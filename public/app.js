(function () {
  let CONFIG = null;
  let selected = null; // { courtId, hour }
  let currentDate = todayStr();

  const el = (id) => document.getElementById(id);
  const gridHead = el('gridHead');
  const gridBody = el('gridBody');
  const datePicker = el('datePicker');
  const dateLabel = el('dateLabel');
  const overlay = el('overlay');
  const modalSub = el('modalSub');
  const bookingForm = el('bookingForm');
  const formError = el('formError');
  const toast = el('toast');

  function todayStr() {
    const d = new Date();
    return fmtDate(d);
  }

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function fmtHour(h) {
    const period = h >= 12 ? 'PM' : 'AM';
    let hour12 = h % 12;
    if (hour12 === 0) hour12 = 12;
    return `${hour12}:00 ${period}`;
  }

  function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = 'toast ' + (type || '');
    setTimeout(() => (toast.className = 'toast hidden'), 3200);
  }

  async function loadConfig() {
    const res = await fetch('/api/config');
    CONFIG = await res.json();
  }

  function buildHead() {
    gridHead.innerHTML = '<th>Time</th>' + CONFIG.courts.map((c) => `<th>${c.name}</th>`).join('');
  }

  function isPastSlot(dateStr, hour) {
    const now = new Date();
    const slotTime = new Date(dateStr + 'T00:00:00');
    slotTime.setHours(hour, 0, 0, 0);
    return slotTime.getTime() < now.getTime();
  }

  async function loadGrid() {
    dateLabel.textContent = new Date(currentDate + 'T00:00:00').toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
    datePicker.value = currentDate;

    const res = await fetch(`/api/bookings?date=${currentDate}`);
    const data = await res.json();
    const bookingMap = {}; // key: courtId-hour
    (data.bookings || []).forEach((b) => {
      bookingMap[`${b.courtId}-${b.hour}`] = b;
    });

    gridBody.innerHTML = '';
    CONFIG.hours.forEach((hour) => {
      const tr = document.createElement('tr');
      const timeTd = document.createElement('td');
      timeTd.className = 'hour-label';
      timeTd.textContent = fmtHour(hour);
      tr.appendChild(timeTd);

      CONFIG.courts.forEach((court) => {
        const key = `${court.id}-${hour}`;
        const booking = bookingMap[key];
        const td = document.createElement('td');
        const past = isPastSlot(currentDate, hour);
        td.className = 'slot' + (booking ? ' taken' : past ? ' past' : '');
        td.textContent = booking ? booking.name : past ? '' : 'Book';
        if (!booking && !past) {
          td.addEventListener('click', () => openModal(court, hour));
        }
        tr.appendChild(td);
      });

      gridBody.appendChild(tr);
    });
  }

  function openModal(court, hour) {
    selected = { courtId: court.id, hour };
    modalSub.textContent = `${court.name} · ${fmtHour(hour)}–${fmtHour(hour + 1)} · ${currentDate}`;
    formError.textContent = '';
    bookingForm.reset();
    overlay.classList.remove('hidden');
  }

  function closeModal() {
    overlay.classList.add('hidden');
    selected = null;
  }

  el('cancelBtn').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  bookingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selected) return;
    formError.textContent = '';
    const payload = {
      courtId: selected.courtId,
      date: currentDate,
      hour: selected.hour,
      name: el('name').value,
      contact: el('contact').value,
      notes: el('notes').value,
    };
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        formError.textContent = data.error || 'Could not book that slot.';
        if (data.code === 'TAKEN') {
          await loadGrid();
        }
        return;
      }
      closeModal();
      showToast('Booking confirmed!', 'success');
      await loadGrid();
    } catch (err) {
      formError.textContent = 'Network error. Please try again.';
    }
  });

  el('prevDay').addEventListener('click', () => shiftDay(-1));
  el('nextDay').addEventListener('click', () => shiftDay(1));
  el('todayBtn').addEventListener('click', () => {
    currentDate = todayStr();
    loadGrid();
  });
  datePicker.addEventListener('change', () => {
    if (datePicker.value) {
      currentDate = datePicker.value;
      loadGrid();
    }
  });

  function shiftDay(delta) {
    const d = new Date(currentDate + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    currentDate = fmtDate(d);
    loadGrid();
  }

  (async function init() {
    await loadConfig();
    buildHead();
    await loadGrid();
  })();
})();
