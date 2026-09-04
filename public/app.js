(function () {
  let CONFIG = null;
  let currentDate = todayStr();

  // Selections persist while on the same date. Key: "courtId-hour"
  const selectedSlots = new Map(); // key -> { courtId, hour }

  const el = (id) => document.getElementById(id);
  const gridHead = el('gridHead');
  const gridBody = el('gridBody');
  const datePicker = el('datePicker');
  const dateLabel = el('dateLabel');
  const dateStrip = el('dateStrip');
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

  function todayStr() {
    return fmtDate(new Date());
  }

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // Compact "2-3 PM" style label for a one-hour slot starting at `h` (24h).
  function fmtSlot(h) {
    const start = h % 12 === 0 ? 12 : h % 12;
    const endHour = h + 1;
    const end = endHour % 12 === 0 ? 12 : endHour % 12;
    const startPeriod = h >= 12 ? 'PM' : 'AM';
    const endPeriod = endHour >= 12 && endHour < 24 ? 'PM' : 'AM';
    if (startPeriod === endPeriod) {
      return `${start}-${end} ${endPeriod}`;
    }
    return `${start} ${startPeriod}-${end} ${endPeriod}`;
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
  }

  function buildHead() {
    gridHead.innerHTML =
      '<th class="time-col">Time</th>' + CONFIG.courts.map((c) => `<th>${c.name}</th>`).join('');
  }

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

  function toggleSlot(courtId, hour) {
    const key = `${courtId}-${hour}`;
    if (selectedSlots.has(key)) {
      selectedSlots.delete(key);
    } else {
      if (selectedSlots.size >= CONFIG.maxSlotsPerBooking) {
        showToast(`You can select up to ${CONFIG.maxSlotsPerBooking} slots at once.`, 'error');
        return;
      }
      selectedSlots.set(key, { courtId, hour });
    }
    if (renderGrid.lastData) renderGrid(renderGrid.lastData);
    updateSummaryBar();
  }

  clearSelectionBtn.addEventListener('click', () => {
    selectedSlots.clear();
    updateSummaryBar();
    if (renderGrid.lastData) renderGrid(renderGrid.lastData);
  });

  bookSelectedBtn.addEventListener('click', () => openModal());

  function buildDateStrip() {
    dateStrip.innerHTML = '';
    const today = new Date();
    for (let i = 0; i < 14; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dateStr = fmtDate(d);

      const chip = document.createElement('button');
      chip.type = 'button';
      let cls = 'date-chip';
      if (dateStr === currentDate) cls += ' active';
      else if (i === 0) cls += ' today';
      chip.className = cls;
      chip.innerHTML = `<span class="dow">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span><span class="dom">${d.getDate()}</span>`;
      chip.addEventListener('click', () => {
        if (dateStr === currentDate) return;
        currentDate = dateStr;
        clearSelectionOnDateChange();
        loadGrid();
      });
      dateStrip.appendChild(chip);
    }
  }

  async function loadGrid() {
    dateLabel.textContent = new Date(currentDate + 'T00:00:00').toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    datePicker.value = currentDate;
    buildDateStrip();

    const res = await fetch(`/api/bookings?date=${currentDate}`);
    const data = await res.json();
    const bookingMap = {}; // key: courtId-hour
    (data.bookings || []).forEach((b) => {
      bookingMap[`${b.courtId}-${b.hour}`] = b;
    });
    renderGrid(bookingMap);
  }

  function renderGrid(bookingMap) {
    renderGrid.lastData = bookingMap;

    gridBody.innerHTML = '';
    CONFIG.hours.forEach((hour) => {
      const tr = document.createElement('tr');
      const timeTd = document.createElement('td');
      timeTd.className = 'hour-label';
      timeTd.textContent = fmtSlot(hour);
      tr.appendChild(timeTd);

      CONFIG.courts.forEach((court) => {
        const key = `${court.id}-${hour}`;
        const booking = bookingMap[key];
        const past = isPastSlot(currentDate, hour);
        const isSelected = selectedSlots.has(key);

        const td = document.createElement('td');
        td.className = 'cell-wrap';

        const btn = document.createElement('button');
        btn.type = 'button';

        if (booking) {
          if (booking.status === 'pending') {
            btn.className = 'cell-btn pending-cell';
            btn.innerHTML = `<span>PENDING</span>`;
          } else {
            btn.className = 'cell-btn booked';
            btn.innerHTML = `<span>Booked</span>`;
          }
          btn.disabled = true;
        } else if (past) {
          btn.className = 'cell-btn past';
          btn.innerHTML = `<span>Past</span>`;
          btn.disabled = true;
        } else if (isSelected) {
          btn.className = 'cell-btn selected';
          btn.innerHTML = `<span>Selected</span>`;
          btn.addEventListener('click', () => toggleSlot(court.id, hour));
        } else {
          btn.className = 'cell-btn open';
          btn.innerHTML = `<span>OPEN</span><span class="price">₱${CONFIG.pricePerHour}</span>`;
          btn.addEventListener('click', () => toggleSlot(court.id, hour));
        }

        td.appendChild(btn);
        tr.appendChild(td);
      });

      gridBody.appendChild(tr);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function openModal() {
    if (selectedSlots.size === 0) return;

    const slots = Array.from(selectedSlots.values()).sort((a, b) => a.courtId - b.courtId || a.hour - b.hour);
    modalSub.textContent = `${slots.length} slot${slots.length > 1 ? 's' : ''} · ${currentDate}`;

    const list = el('selectedSlotsList');
    list.innerHTML = '';
    slots.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'selected-slot-row';
      row.innerHTML = `
        <span class="slot-info">${fmtSlot(s.hour)}<span class="slot-court">${courtName(s.courtId)}</span></span>
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
    await loadGrid();
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
      date: currentDate,
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
          await loadGrid();
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

  el('calBtn').addEventListener('click', () => {
    if (datePicker.showPicker) {
      try { datePicker.showPicker(); } catch (e) { datePicker.focus(); }
    } else {
      datePicker.focus();
    }
  });
  datePicker.addEventListener('change', () => {
    if (datePicker.value) {
      currentDate = datePicker.value;
      clearSelectionOnDateChange();
      loadGrid();
    }
  });

  function clearSelectionOnDateChange() {
    if (selectedSlots.size > 0) {
      selectedSlots.clear();
      updateSummaryBar();
      showToast('Date changed — selection cleared.', '');
    }
  }


  (async function init() {
    await loadConfig();
    buildHead();
    updateSummaryBar();
    await loadGrid();
  })();
})();
