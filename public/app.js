(function () {
  let CONFIG = null;
  let selected = null; // { courtId, hour }
  let currentDate = todayStr();
  let selectedCourtId = null;

  const el = (id) => document.getElementById(id);
  const courtTabs = el('courtTabs');
  const slotGrid = el('slotGrid');
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

  // Compact "2-3 PM" style label for a one-hour slot starting at `h` (24h).
  function fmtSlot(h) {
    const start = h % 12 === 0 ? 12 : h % 12;
    const endHour = h + 1;
    const end = endHour % 12 === 0 ? 12 : endHour % 12;
    const period = endHour >= 12 && endHour < 24 ? 'PM' : 'AM';
    // Use the period of the end of the slot for the whole label, unless it
    // crosses noon/midnight, in which case show both.
    const startPeriod = h >= 12 ? 'PM' : 'AM';
    const endPeriod = endHour >= 12 && endHour < 24 ? 'PM' : 'AM';
    if (startPeriod === endPeriod) {
      return `${start}-${end} ${endPeriod}`;
    }
    return `${start} ${startPeriod}-${end} ${endPeriod}`;
  }

  function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = 'toast ' + (type || '');
    setTimeout(() => (toast.className = 'toast hidden'), 3200);
  }

  async function loadConfig() {
    const res = await fetch('/api/config');
    CONFIG = await res.json();
    if (!selectedCourtId) selectedCourtId = CONFIG.courts[0].id;
  }

  function buildCourtTabs() {
    courtTabs.innerHTML = '';
    CONFIG.courts.forEach((court) => {
      const btn = document.createElement('button');
      btn.className = 'court-tab' + (court.id === selectedCourtId ? ' active' : '');
      btn.textContent = court.name;
      btn.addEventListener('click', () => {
        selectedCourtId = court.id;
        buildCourtTabs();
        loadGrid();
      });
      courtTabs.appendChild(btn);
    });
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

    const court = CONFIG.courts.find((c) => c.id === selectedCourtId);

    slotGrid.innerHTML = '';
    CONFIG.hours.forEach((hour) => {
      const key = `${selectedCourtId}-${hour}`;
      const booking = bookingMap[key];
      const past = isPastSlot(currentDate, hour);

      const card = document.createElement('div');
      let cls = 'slot-card';
      if (booking) {
        cls += booking.status === 'pending' ? ' pending-card' : ' taken';
      } else if (past) {
        cls += ' past';
      } else {
        cls += ' available';
      }
      card.className = cls;

      const timeEl = document.createElement('div');
      timeEl.className = 'time';
      timeEl.textContent = fmtSlot(hour);
      card.appendChild(timeEl);

      if (booking) {
        if (booking.name) {
          const bookerEl = document.createElement('div');
          bookerEl.className = 'booker';
          bookerEl.innerHTML = `<span class="icon">👤</span> ${escapeHtml(booking.name)}`;
          card.appendChild(bookerEl);
        }
        const badges = document.createElement('div');
        badges.className = 'badges';
        if (booking.status === 'confirmed') {
          badges.innerHTML = '<span class="badge verified">✓ VERIFIED</span><span class="badge booked">BOOKED</span>';
        } else if (booking.status === 'pending') {
          badges.innerHTML = '<span class="badge pending">PENDING REVIEW</span>';
        } else {
          badges.innerHTML = '<span class="badge booked">UNAVAILABLE</span>';
        }
        card.appendChild(badges);
      } else if (past) {
        const statusEl = document.createElement('div');
        statusEl.className = 'status-line';
        statusEl.style.color = 'var(--muted)';
        statusEl.textContent = 'Past';
        card.appendChild(statusEl);
      } else {
        const statusEl = document.createElement('div');
        statusEl.className = 'status-line';
        statusEl.textContent = `Available · ₱${CONFIG.pricePerHour}`;
        card.appendChild(statusEl);
        card.addEventListener('click', () => openModal(court, hour));
      }

      slotGrid.appendChild(card);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function openModal(court, hour) {
    selected = { courtId: court.id, hour };
    modalSub.textContent = `${court.name} · ${fmtSlot(hour)} · ${currentDate}`;
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
    buildCourtTabs();
    await loadGrid();
  })();
})();
