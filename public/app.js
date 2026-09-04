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
  const successBox = el('successBox');

  function todayStr() {
    return fmtDate(new Date());
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
        const statusClass = booking ? (booking.status === 'pending' ? 'pending' : 'taken') : past ? 'past' : '';
        td.className = 'slot' + (statusClass ? ' ' + statusClass : '');
        td.textContent = booking ? booking.label : past ? '' : `₱${CONFIG.pricePerHour}`;
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
    el('paymentAmount').textContent = `₱${CONFIG.pricePerHour} for this slot`;
    el('paymentInstructions').textContent = CONFIG.paymentInstructions;
    formError.textContent = '';
    bookingForm.reset();
    el('previewWrap').classList.add('hidden');
    bookingForm.classList.remove('hidden');
    successBox.classList.add('hidden');
    el('submitBtn').disabled = false;
    el('submitBtn').textContent = 'Submit for review';
    overlay.classList.remove('hidden');
  }

  function closeModal() {
    overlay.classList.add('hidden');
    selected = null;
  }

  el('cancelBtn').addEventListener('click', closeModal);
  el('closeSuccessBtn').addEventListener('click', async () => {
    closeModal();
    await loadGrid();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
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
    if (!selected) return;
    formError.textContent = '';

    const fileInput = el('screenshot');
    if (!fileInput.files[0]) {
      formError.textContent = 'Please attach a screenshot of your payment.';
      return;
    }

    const submitBtn = el('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    const fd = new FormData();
    fd.append('courtId', selected.courtId);
    fd.append('date', currentDate);
    fd.append('hour', selected.hour);
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
        submitBtn.textContent = 'Submit for review';
        if (data.code === 'TAKEN') {
          await loadGrid();
        }
        return;
      }
      bookingForm.classList.add('hidden');
      successBox.classList.remove('hidden');
    } catch (err) {
      formError.textContent = 'Network error. Please try again.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit for review';
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
