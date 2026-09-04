(function () {
  let CONFIG = null;
  let currentCourtId = null;
  let calendarMonth = firstOfMonth(new Date());
  let selectedDate = todayStr();
  let dayBookings = {}; // "courtId-hour" -> booking, for selectedDate

  // Key: "courtId-date-hour" (date is always selectedDate while a date is
  // selected, but keeping it in the key keeps things consistent if that changes)
  const selectedSlots = new Map();

  const el = (id) => document.getElementById(id);
  const courtSelect = el('courtSelect');
  const monthLabel = el('monthLabel');
  const monthPrevBtn = el('monthPrevBtn');
  const monthNextBtn = el('monthNextBtn');
  const calGrid = el('calGrid');
  const timesHeading = el('timesHeading');
  const timeList = el('timeList');
  const bookingCard = el('bookingCard');
  const confirmPanel = el('confirmPanel');
  const modalSub = el('modalSub');
  const bookingForm = el('bookingForm');
  const formError = el('formError');
  const toast = el('toast');
  const successBox = el('successBox');
  const summaryText = el('summaryText');
  const clearSelectionBtn = el('clearSelectionBtn');
  const bookSelectedBtn = el('bookSelectedBtn');

  function todayDate() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function todayStr() {
    return fmtDate(todayDate());
  }

  function firstOfMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // "01:00 PM" style label for a one-hour slot starting at `h` (24h).
  function fmtTime(h) {
    const period = h >= 12 && h < 24 ? 'PM' : 'AM';
    let hour = h % 12;
    if (hour === 0) hour = 12;
    return `${String(hour).padStart(2, '0')}:00 ${period}`;
  }

  // "6 AM" style label for a single hour boundary (used for the venue meta row).
  function fmtHour(h) {
    const hour = h % 12 === 0 ? 12 : h % 12;
    const period = h >= 12 && h < 24 ? 'PM' : 'AM';
    return `${hour} ${period}`;
  }

  function courtName(courtId) {
    const c = CONFIG.courts.find((c) => c.id === courtId);
    return c ? c.name : `Court ${courtId}`;
  }

  function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = 'toast ' + (type || '');
    setTimeout(() => (toast.className = 'toast hidden'), 3200);
  }

  async function loadConfig() {
    const res = await fetch('/api/config');
    CONFIG = await res.json();

    el('venueCourtsMeta').textContent = `${CONFIG.courts.length} court${CONFIG.courts.length > 1 ? 's' : ''}`;
    el('venueHoursMeta').textContent = `${fmtHour(CONFIG.openHour)} – ${fmtHour(CONFIG.closeHour)}`;
    el('venuePrice').textContent = `₱${CONFIG.pricePerHour}`;

    courtSelect.innerHTML = CONFIG.courts.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
    currentCourtId = CONFIG.courts[0].id;
    courtSelect.value = String(currentCourtId);
  }

  courtSelect.addEventListener('change', () => {
    currentCourtId = Number(courtSelect.value);
    loadTimes();
  });

  function isPastSlot(dateStr, hour) {
    const now = new Date();
    const slotTime = new Date(dateStr + 'T00:00:00');
    slotTime.setHours(hour, 0, 0, 0);
    return slotTime.getTime() < now.getTime();
  }

  function updateSummaryBar() {
    const n = selectedSlots.size;
    if (n === 0) {
      summaryText.classList.add('hidden');
      summaryText.textContent = '';
      clearSelectionBtn.disabled = true;
      bookSelectedBtn.disabled = true;
      return;
    }
    const total = n * CONFIG.pricePerHour;
    summaryText.textContent = `${n} slot${n > 1 ? 's' : ''} selected · ₱${total} total`;
    summaryText.classList.remove('hidden');
    clearSelectionBtn.disabled = false;
    bookSelectedBtn.disabled = false;
  }

  function toggleSlot(courtId, date, hour) {
    const key = `${courtId}-${date}-${hour}`;
    if (selectedSlots.has(key)) {
      selectedSlots.delete(key);
    } else {
      if (selectedSlots.size >= CONFIG.maxSlotsPerBooking) {
        showToast(`You can select up to ${CONFIG.maxSlotsPerBooking} slots at once.`, 'error');
        return;
      }
      selectedSlots.set(key, { courtId, date, hour });
    }
    renderTimes();
    updateSummaryBar();
  }

  clearSelectionBtn.addEventListener('click', () => {
    selectedSlots.clear();
    updateSummaryBar();
    renderTimes();
  });

  bookSelectedBtn.addEventListener('click', () => openModal());

  // --- Calendar ---
  function renderCalendar() {
    monthLabel.textContent = calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

    const todayS = todayStr();
    calGrid.innerHTML = '';

    for (let cell = 0; cell < totalCells; cell++) {
      const dayNum = cell - firstWeekday + 1;
      if (dayNum < 1 || dayNum > daysInMonth) {
        const empty = document.createElement('span');
        empty.className = 'cal-day empty';
        calGrid.appendChild(empty);
        continue;
      }
      const dateObj = new Date(year, month, dayNum);
      const dateStr = fmtDate(dateObj);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = String(dayNum);
      let cls = 'cal-day';
      if (dateStr === todayS) cls += ' today';
      if (dateStr === selectedDate) cls += ' selected';
      btn.className = cls;

      if (dateStr < todayS) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', () => selectDate(dateStr));
      }
      calGrid.appendChild(btn);
    }

    const monthStart = fmtDate(firstOfMonth(new Date()));
    monthPrevBtn.disabled = fmtDate(calendarMonth) <= monthStart;
  }

  function selectDate(dateStr) {
    if (dateStr === selectedDate) return;
    selectedDate = dateStr;
    if (selectedSlots.size > 0) {
      selectedSlots.clear();
      updateSummaryBar();
    }
    renderCalendar();
    loadTimes();
  }

  monthPrevBtn.addEventListener('click', () => {
    const candidate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    const floor = firstOfMonth(new Date());
    calendarMonth = candidate < floor ? floor : candidate;
    renderCalendar();
  });

  monthNextBtn.addEventListener('click', () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  // --- Times list ---
  async function loadTimes() {
    const res = await fetch(`/api/bookings?date=${selectedDate}`);
    const data = await res.json();
    dayBookings = {};
    (data.bookings || []).forEach((b) => {
      dayBookings[`${b.courtId}-${b.hour}`] = b;
    });
    renderTimes();
  }

  function renderTimes() {
    const dateObj = new Date(selectedDate + 'T00:00:00');
    timesHeading.textContent = dateObj.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });

    const hours = CONFIG.hours.filter((hour) => !isPastSlot(selectedDate, hour));

    timeList.innerHTML = '';

    if (hours.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'time-empty';
      empty.textContent = 'No times available for this date.';
      timeList.appendChild(empty);
      return;
    }

    hours.forEach((hour) => {
      const key = `${currentCourtId}-${hour}`;
      const booking = dayBookings[key];
      const selKey = `${currentCourtId}-${selectedDate}-${hour}`;
      const isSelected = selectedSlots.has(selKey);

      const btn = document.createElement('button');
      btn.type = 'button';

      if (booking) {
        btn.className = 'time-slot unavailable';
        btn.disabled = true;
      } else if (isSelected) {
        btn.className = 'time-slot selected';
        btn.addEventListener('click', () => toggleSlot(currentCourtId, selectedDate, hour));
      } else {
        btn.className = 'time-slot';
        btn.addEventListener('click', () => toggleSlot(currentCourtId, selectedDate, hour));
      }
      btn.innerHTML = `<span class="dot"></span><span>${fmtTime(hour)}</span>`;
      timeList.appendChild(btn);
    });
  }

  function openModal() {
    if (selectedSlots.size === 0) return;

    const slots = Array.from(selectedSlots.values()).sort(
      (a, b) => a.date.localeCompare(b.date) || a.courtId - b.courtId || a.hour - b.hour
    );
    modalSub.textContent = `${slots.length} slot${slots.length > 1 ? 's' : ''} selected`;

    const list = el('selectedSlotsList');
    list.innerHTML = '';
    slots.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'selected-slot-row';
      const shortDate = new Date(s.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      row.innerHTML = `
        <span class="slot-info"><span class="slot-date">${shortDate}</span>${fmtTime(s.hour)}<span class="slot-court">${courtName(s.courtId)}</span></span>
        <span class="slot-price">₱${CONFIG.pricePerHour}</span>
      `;
      list.appendChild(row);
    });
    const totalRow = document.createElement('div');
    totalRow.className = 'selected-slots-total';
    totalRow.innerHTML = `<span>Total</span><span>₱${slots.length * CONFIG.pricePerHour}</span>`;
    list.appendChild(totalRow);

    el('paymentAmount').textContent = `₱${slots.length * CONFIG.pricePerHour} for ${slots.length} slot${slots.length > 1 ? 's' : ''}`;
    el('paymentInstructions').textContent = CONFIG.paymentInstructions;
    formError.textContent = '';
    bookingForm.reset();
    el('previewWrap').classList.add('hidden');
    bookingForm.classList.remove('hidden');
    el('selectedSlotsList').classList.remove('hidden');
    el('paymentAmount').parentElement.classList.remove('hidden');
    successBox.classList.add('hidden');
    el('submitBtn').disabled = false;
    el('submitBtn').querySelector('span').textContent = 'SUBMIT FOR REVIEW';

    confirmPanel.classList.add('open');
    bookingCard.classList.add('confirm-open');
  }

  function closeModal() {
    confirmPanel.classList.remove('open');
    bookingCard.classList.remove('confirm-open');
  }

  el('backBtn').addEventListener('click', closeModal);
  el('closeSuccessBtn').addEventListener('click', async () => {
    closeModal();
    selectedSlots.clear();
    updateSummaryBar();
    await loadTimes();
  });

  el('screenshot').addEventListener('change', () => {
    const file = el('screenshot').files[0];
    const previewWrap = el('previewWrap');
    const previewImg = el('previewImg');
    if (!file) {
      previewWrap.classList.add('hidden');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      previewImg.src = e.target.result;
      previewWrap.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  });

  bookingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (selectedSlots.size === 0) return;
    formError.textContent = '';

    const fileInput = el('screenshot');
    if (!fileInput.files[0]) {
      formError.textContent = 'Please attach a screenshot of your payment.';
      return;
    }

    const submitBtn = el('submitBtn');
    const submitLabel = submitBtn.querySelector('span');
    submitBtn.disabled = true;
    submitLabel.textContent = 'SUBMITTING…';

    const slots = Array.from(selectedSlots.values()).map((s) => ({
      courtId: s.courtId,
      hour: s.hour,
      date: s.date,
    }));

    const fd = new FormData();
    fd.append('slots', JSON.stringify(slots));
    fd.append('name', el('name').value);
    fd.append('contact', el('contact').value);
    fd.append('notes', el('notes').value);
    fd.append('screenshot', fileInput.files[0]);

    try {
      const res = await fetch('/api/bookings', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        formError.textContent = data.error || 'Could not submit that booking.';
        submitBtn.disabled = false;
        submitLabel.textContent = 'SUBMIT FOR REVIEW';
        if (data.code === 'TAKEN') {
          selectedSlots.clear();
          updateSummaryBar();
          await loadTimes();
        }
        return;
      }
      bookingForm.classList.add('hidden');
      el('selectedSlotsList').classList.add('hidden');
      el('paymentAmount').parentElement.classList.add('hidden');
      successBox.classList.remove('hidden');
    } catch (err) {
      formError.textContent = 'Network error. Please try again.';
      submitBtn.disabled = false;
      submitLabel.textContent = 'SUBMIT FOR REVIEW';
    }
  });

  (async function init() {
    await loadConfig();
    updateSummaryBar();
    renderCalendar();
    await loadTimes();
  })();
})();
