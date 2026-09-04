(function () {
  const RANGE_LEN = 6;

  let CONFIG = null;
  let currentCourtId = null;
  let rangeStart = todayDate();
  let bookingsByDate = {}; // date -> { "courtId-hour": booking }

  // Selections can span multiple courts and dates in one submission.
  // Key: "courtId-date-hour"
  const selectedSlots = new Map(); // key -> { courtId, date, hour }

  const el = (id) => document.getElementById(id);
  const courtSelect = el('courtSelect');
  const rangeLabel = el('rangeLabel');
  const rangePrevBtn = el('rangePrevBtn');
  const rangeNextBtn = el('rangeNextBtn');
  const dayList = el('dayList');
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

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function fmtShort(d) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
    renderDays();
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
    renderDays();
    updateSummaryBar();
  }

  clearSelectionBtn.addEventListener('click', () => {
    selectedSlots.clear();
    updateSummaryBar();
    renderDays();
  });

  bookSelectedBtn.addEventListener('click', () => openModal());

  function currentRangeDates() {
    const dates = [];
    for (let i = 0; i < RANGE_LEN; i++) dates.push(addDays(rangeStart, i));
    return dates;
  }

  function updateRangeLabel() {
    const dates = currentRangeDates();
    rangeLabel.textContent = `${fmtShort(dates[0])} - ${fmtShort(dates[dates.length - 1])}`;
    rangePrevBtn.disabled = fmtDate(rangeStart) <= fmtDate(todayDate());
  }

  rangePrevBtn.addEventListener('click', () => {
    const candidate = addDays(rangeStart, -RANGE_LEN);
    rangeStart = candidate < todayDate() ? todayDate() : candidate;
    loadSchedule();
  });

  rangeNextBtn.addEventListener('click', () => {
    rangeStart = addDays(rangeStart, RANGE_LEN);
    loadSchedule();
  });

  async function loadSchedule() {
    updateRangeLabel();
    const dates = currentRangeDates();
    const results = await Promise.all(
      dates.map((d) => fetch(`/api/bookings?date=${fmtDate(d)}`).then((r) => r.json()))
    );
    bookingsByDate = {};
    dates.forEach((d, i) => {
      const map = {};
      (results[i].bookings || []).forEach((b) => {
        map[`${b.courtId}-${b.hour}`] = b;
      });
      bookingsByDate[fmtDate(d)] = map;
    });
    renderDays();
  }

  function renderDays() {
    dayList.innerHTML = '';
    const dates = currentRangeDates();

    dates.forEach((d, i) => {
      const dateStr = fmtDate(d);
      const dayMap = bookingsByDate[dateStr] || {};

      const hours = CONFIG.hours.filter((hour) => !isPastSlot(dateStr, hour));

      const section = document.createElement('div');
      section.className = 'day-section';

      const header = document.createElement('div');
      header.className = 'day-header';
      const dayLabel = i === 0
        ? `Today, ${fmtShort(d)}`
        : `${d.toLocaleDateString(undefined, { weekday: 'short' })}, ${fmtShort(d)}`;
      const h3 = document.createElement('h3');
      h3.textContent = dayLabel;
      header.appendChild(h3);

      if (hours.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'day-empty';
        empty.textContent = 'No availability';
        header.appendChild(empty);
        section.appendChild(header);
        dayList.appendChild(section);
        return;
      }

      section.appendChild(header);

      const pills = document.createElement('div');
      pills.className = 'day-pills';

      hours.forEach((hour) => {
        const key = `${currentCourtId}-${hour}`;
        const booking = dayMap[key];
        const selKey = `${currentCourtId}-${dateStr}-${hour}`;
        const isSelected = selectedSlots.has(selKey);

        const btn = document.createElement('button');
        btn.type = 'button';

        if (booking) {
          btn.className = 'pill unavailable';
          btn.disabled = true;
        } else if (isSelected) {
          btn.className = 'pill selected';
          btn.addEventListener('click', () => toggleSlot(currentCourtId, dateStr, hour));
        } else {
          btn.className = 'pill';
          btn.addEventListener('click', () => toggleSlot(currentCourtId, dateStr, hour));
        }
        btn.textContent = fmtTime(hour);
        pills.appendChild(btn);
      });

      section.appendChild(pills);
      dayList.appendChild(section);
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
      const shortDate = fmtShort(new Date(s.date + 'T00:00:00'));
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
    await loadSchedule();
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
          await loadSchedule();
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
    await loadSchedule();
  })();
})();
