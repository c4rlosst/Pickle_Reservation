(function () {
  let CONFIG = null;
  let currentCourtId = null;
  let calendarMonth = firstOfMonth(new Date());
  let selectedDate = todayStr();
  let dayBookings = {}; // "courtId-hour" -> booking, for selectedDate

  // Key: "courtId-date-hour" (date is always selectedDate while a date is
  // selected, but keeping it in the key keeps things consistent if that changes)
  const selectedSlots = new Map();

  // The active reservation hold for whichever slots are in the payment
  // modal right now -- created the moment the modal opens (before the
  // customer has paid), so nobody else can grab those slots while this
  // customer is off sending money. { groupId, holdExpiresAt } or null.
  let currentHold = null;
  let holdCountdownInterval = null;

  const el = (id) => document.getElementById(id);
  const courtSelect = el('courtSelect');
  const monthLabel = el('monthLabel');
  const monthPrevBtn = el('monthPrevBtn');
  const monthNextBtn = el('monthNextBtn');
  const calGrid = el('calGrid');
  const timesHeading = el('timesHeading');
  const timeList = el('timeList');
  const bookingCard = el('bookingCard');
  const cardInner = el('cardInner');
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
  // Converts a 24h hour (can wrap past 24, e.g. 24 -> 0 next day) to a
  // { hour, period } 12h pair.
  function to12Hour(hRaw) {
    const h = ((hRaw % 24) + 24) % 24;
    const period = h >= 12 ? 'PM' : 'AM';
    let hour = h % 12;
    if (hour === 0) hour = 12;
    return { hour, period };
  }

  // One-hour slot range label, e.g. "1\u201302 PM" or "11 AM\u201312 PM" when it
  // crosses noon/midnight, so it's clear at a glance how long the slot is.
  function fmtTime(h) {
    const start = to12Hour(h);
    const end = to12Hour(h + 1);
    if (start.period === end.period) {
      return `${start.hour} - ${end.hour} ${start.period}`;
    }
    return `${start.hour} ${start.period} - ${end.hour} ${end.period}`;
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

    const locationLink = el('venueLocationLink');
    if (CONFIG.locationMapsUrl) {
      locationLink.href = CONFIG.locationMapsUrl;
      locationLink.classList.remove('hidden');
    } else {
      locationLink.classList.add('hidden');
    }

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

  // The platform fee is charged ONCE per booking transaction (one payment,
  // one screenshot), not once per slot -- a customer booking 6 slots in one
  // go still only pays it a single time.
  function courtsSubtotal(n) {
    return n * CONFIG.pricePerHour;
  }

  function transactionTotal(n) {
    return courtsSubtotal(n) + (CONFIG.platformFee || 0);
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
    const total = transactionTotal(n);
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

  // Step 1 of booking: reserve the selected slot(s) on the server BEFORE
  // opening the payment screen, so they're locked under this customer while
  // they go pay -- not just once they come back and submit a screenshot.
  bookSelectedBtn.addEventListener('click', async () => {
    if (selectedSlots.size === 0 || bookSelectedBtn.disabled) return;
    const slots = Array.from(selectedSlots.values()).map((s) => ({ courtId: s.courtId, hour: s.hour, date: s.date }));
    bookSelectedBtn.disabled = true;
    try {
      const res = await fetch('/api/bookings/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'One of those slots was just taken. Please pick another.', 'error');
        selectedSlots.clear();
        updateSummaryBar();
        await loadTimes();
        return;
      }
      currentHold = { groupId: data.groupId, holdExpiresAt: data.holdExpiresAt };
      openModal();
      startHoldCountdown(data.holdSeconds);
    } catch (err) {
      showToast('Network error. Please try again.', 'error');
    } finally {
      updateSummaryBar(); // restores bookSelectedBtn's disabled state correctly
    }
  });

  // Best-effort: free this customer's hold immediately instead of making
  // everyone else wait out the full countdown, whenever they leave the
  // payment screen without finishing (Back button).
  function releaseCurrentHold() {
    if (!currentHold) return;
    const { groupId } = currentHold;
    currentHold = null;
    stopHoldCountdown();
    fetch(`/api/bookings/hold/${groupId}`, { method: 'DELETE' }).catch(() => {});
  }

  function stopHoldCountdown() {
    if (holdCountdownInterval) {
      clearInterval(holdCountdownInterval);
      holdCountdownInterval = null;
    }
  }

  // Counts down locally from a plain number of seconds handed back by the
  // server, rather than repeatedly comparing an absolute expiry timestamp
  // against this device's own clock -- that comparison drifts (and can show
  // the wrong minute) whenever the customer's device clock isn't in sync
  // with the server's. The server's own hold_expires_at remains the real
  // source of truth for when the hold actually expires; this is purely for
  // what the customer sees on screen.
  let holdSecondsLeft = 0;

  function renderHoldCountdown() {
    const timerEl = el('holdTimer');
    if (!currentHold) {
      timerEl.classList.add('hidden');
      return;
    }
    if (holdSecondsLeft <= 0) {
      handleHoldExpired();
      return;
    }
    const mm = Math.floor(holdSecondsLeft / 60);
    const ss = String(holdSecondsLeft % 60).padStart(2, '0');
    timerEl.textContent = `Slot reserved for you — ${mm}:${ss} to complete payment`;
    timerEl.classList.remove('hidden');
    timerEl.classList.toggle('urgent', holdSecondsLeft <= 60);
  }

  function startHoldCountdown(holdSeconds) {
    stopHoldCountdown();
    holdSecondsLeft = Math.max(0, Math.round(Number(holdSeconds) || 0));
    renderHoldCountdown();
    holdCountdownInterval = setInterval(() => {
      holdSecondsLeft -= 1;
      renderHoldCountdown();
    }, 1000);
  }

  function handleHoldExpired() {
    stopHoldCountdown();
    currentHold = null;
    closeModal();
    selectedSlots.clear();
    updateSummaryBar();
    showToast('Your reserved time ran out. Please select your slot(s) again.', 'error');
    loadTimes();
  }

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

  // Locks the list's current rendered height, runs the content update, then
  // animates to the new content's natural height (capped the same way the
  // CSS max-height already caps it). Without this, switching to a date with
  // a different number of available slots snaps the box to its new size
  // instantly, which reads as a jump/glitch rather than a resize.
  // Animates the WHOLE card's height when its content's natural size
  // changes (e.g. switching to a date with a different number of available
  // slots). This deliberately targets #cardInner -- the calendar and times
  // columns are flex siblings under align-items: stretch, so animating the
  // inner time-list's own max-height doesn't reliably move the outer card:
  // whichever column has the taller natural content governs the row's
  // height, and once the times list's content drops below the calendar's
  // natural height, the row clamps to the calendar's fixed size and the
  // list's own shrinking has no further visible effect -- which is exactly
  // why shrinking looked like it "snapped" while growing didn't. Animating
  // the outer wrapper's height sidesteps that entirely.
  function animateCardHeight(el, updateFn) {
    const startHeight = el.getBoundingClientRect().height;
    // Lock the starting height with transitions off, and force the browser
    // to commit that as its own separate style/layout state before doing
    // anything else -- forcing a reflow (offsetHeight) makes this reliable
    // without depending on requestAnimationFrame timing.
    //
    // This locks an explicit `height`, not `max-height`. A max-height only
    // caps growth -- it does nothing to stop a box from shrinking below it,
    // so when the new content was SHORTER, the box would immediately drop
    // to its new natural (smaller) size the instant updateFn() ran, before
    // the transition ever got a chance to animate anything: growing worked
    // (content was being clipped down to the old max-height, then released)
    // but shrinking always snapped instantly. Locking a real `height`
    // pins the box at the old size in both directions, so there is always
    // a genuine start state to transition from.
    el.style.transition = 'none';
    el.style.height = startHeight + 'px';
    void el.offsetHeight;

    updateFn();

    const targetHeight = el.scrollHeight;
    // Clear the inline override (falls back to the CSS-declared transition,
    // which is what respects prefers-reduced-motion) and commit THAT as its
    // own state before changing the height, so the browser has two
    // genuinely distinct states to transition between.
    el.style.transition = '';
    void el.offsetHeight;
    el.style.height = targetHeight + 'px';

    // Once settled, release the fixed pixel height back to natural sizing
    // so a later window resize (or anything else that changes the content's
    // natural height without going through this function) isn't stuck
    // clipped to a stale pinned value.
    const clearFixedHeight = (e) => {
      if (e.target !== el || e.propertyName !== 'height') return;
      el.style.height = '';
      el.removeEventListener('transitionend', clearFixedHeight);
    };
    el.addEventListener('transitionend', clearFixedHeight);
  }

  function renderTimes() {
    const dateObj = new Date(selectedDate + 'T00:00:00');
    timesHeading.textContent = dateObj.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });

    const hours = CONFIG.hours.filter((hour) => !isPastSlot(selectedDate, hour));

    animateCardHeight(cardInner, () => {
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

        if (booking && booking.status === 'pending') {
          btn.className = 'time-slot unavailable pending';
          btn.disabled = true;
          btn.innerHTML = `<span class="pending-time">${fmtTime(hour)}</span><span class="pending-badge">Pending</span>`;
          timeList.appendChild(btn);
          return;
        } else if (booking) {
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
    const fee = CONFIG.platformFee || 0;
    if (fee > 0) {
      const subtotalRow = document.createElement('div');
      subtotalRow.className = 'selected-slot-row selected-slots-subtotal';
      subtotalRow.innerHTML = `<span class="slot-info">Courts subtotal</span><span class="slot-price">₱${courtsSubtotal(slots.length)}</span>`;
      list.appendChild(subtotalRow);

      const feeRow = document.createElement('div');
      feeRow.className = 'selected-slot-row selected-slots-subtotal';
      feeRow.innerHTML = `<span class="slot-info">Service fee</span><span class="slot-price">₱${fee}</span>`;
      list.appendChild(feeRow);
    }

    const totalRow = document.createElement('div');
    totalRow.className = 'selected-slots-total';
    totalRow.innerHTML = `<span>Total</span><span>₱${transactionTotal(slots.length)}</span>`;
    list.appendChild(totalRow);

    el('paymentAmount').textContent = `₱${transactionTotal(slots.length)}`;
    el('paymentMethod').textContent = CONFIG.paymentMethod;
    el('paymentNumber').textContent = CONFIG.paymentNumber;
    el('paymentName').textContent = CONFIG.paymentName;
    el('paymentNote').textContent = CONFIG.paymentNote;
    const copyBtn = el('copyNumberBtn');
    copyBtn.classList.remove('copied');
    copyBtn.querySelector('.copy-icon').classList.remove('hidden');
    copyBtn.querySelector('.check-icon').classList.add('hidden');
    copyBtn.querySelector('.copy-btn-label').textContent = 'Copy';
    formError.textContent = '';
    bookingForm.reset();
    el('name').classList.remove('invalid');
    el('contact').classList.remove('invalid');
    el('screenshot').closest('.file-upload').classList.remove('invalid');
    el('previewWrap').classList.add('hidden');
    el('screenshot').closest('.file-upload').classList.remove('has-file');
    el('fileUploadLabel').textContent = 'Upload screenshot';
    bookingForm.classList.remove('hidden');
    el('selectedSlotsList').classList.remove('hidden');
    el('paymentAmount').closest('.payment-box').classList.remove('hidden');
    successBox.classList.add('hidden');
    bookingCard.classList.remove('success-compact');
    el('submitBtn').disabled = false;
    el('submitBtn').querySelector('span').textContent = 'SUBMIT FOR REVIEW';

    confirmPanel.classList.add('open');
    bookingCard.classList.add('confirm-open');
  }

  function closeModal() {
    confirmPanel.classList.remove('open');
    bookingCard.classList.remove('confirm-open');
    bookingCard.classList.remove('success-compact');
  }

  el('backBtn').addEventListener('click', () => {
    // Leaving the payment screen without finishing -- free the hold right
    // away instead of making the slot wait out the full countdown.
    releaseCurrentHold();
    closeModal();
  });

  el('copyNumberBtn').addEventListener('click', async () => {
    const btn = el('copyNumberBtn');
    const number = el('paymentNumber').textContent;
    try {
      await navigator.clipboard.writeText(number);
    } catch (err) {
      // Fallback for browsers/contexts without Clipboard API access.
      const tmp = document.createElement('textarea');
      tmp.value = number;
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      document.body.removeChild(tmp);
    }
    btn.classList.add('copied');
    btn.querySelector('.copy-icon').classList.add('hidden');
    btn.querySelector('.check-icon').classList.remove('hidden');
    btn.querySelector('.copy-btn-label').textContent = 'Copied';
    clearTimeout(btn._copyResetTimer);
    btn._copyResetTimer = setTimeout(() => {
      btn.classList.remove('copied');
      btn.querySelector('.copy-icon').classList.remove('hidden');
      btn.querySelector('.check-icon').classList.add('hidden');
      btn.querySelector('.copy-btn-label').textContent = 'Copy';
    }, 1800);
  });
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
    const fileUploadLabel = el('fileUploadLabel');
    const fileUpload = el('screenshot').closest('.file-upload');
    if (!file) {
      previewWrap.classList.add('hidden');
      fileUpload.classList.remove('has-file');
      fileUploadLabel.textContent = 'Upload screenshot';
      return;
    }
    fileUpload.classList.add('has-file');
    fileUploadLabel.textContent = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
      previewImg.src = e.target.result;
      previewWrap.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  });

  // Accepts either an email address, or a PH mobile number (11 digits,
  // starting with 09 -- e.g. 0917 123 4567; spaces/dashes are ignored).
  // Returns an error message, or null if the value is valid.
  function validateContact(value) {
    if (value.includes('@')) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return 'Please enter a valid email address.';
      }
      return null;
    }
    const digits = value.replace(/\D/g, '');
    if (!/^09\d{9}$/.test(digits)) {
      return 'Please enter a valid 11-digit PH mobile number (e.g. 0917 123 4567), or an email address.';
    }
    return null;
  }

  // Clear a field's red "invalid" highlight as soon as the customer
  // starts fixing it.
  el('name').addEventListener('input', () => el('name').classList.remove('invalid'));
  el('contact').addEventListener('input', () => el('contact').classList.remove('invalid'));
  el('screenshot').addEventListener('change', () => {
    if (el('screenshot').files[0]) {
      el('screenshot').closest('.file-upload').classList.remove('invalid');
    }
  });

  bookingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (selectedSlots.size === 0 || !currentHold) return;
    formError.textContent = '';
    el('name').classList.remove('invalid');
    el('contact').classList.remove('invalid');
    el('screenshot').closest('.file-upload').classList.remove('invalid');

    const nameValue = el('name').value.trim();
    if (!nameValue) {
      el('name').classList.add('invalid');
      el('name').focus();
      return;
    }

    const contactValue = el('contact').value.trim();
    const contactError = validateContact(contactValue);
    if (contactError) {
      el('contact').classList.add('invalid');
      el('contact').focus();
      return;
    }

    const fileInput = el('screenshot');
    if (!fileInput.files[0]) {
      el('screenshot').closest('.file-upload').classList.add('invalid');
      return;
    }

    const submitBtn = el('submitBtn');
    const submitLabel = submitBtn.querySelector('span');
    submitBtn.disabled = true;
    submitLabel.textContent = 'SUBMITTING…';

    const fd = new FormData();
    fd.append('groupId', currentHold.groupId);
    fd.append('name', el('name').value);
    fd.append('contact', el('contact').value);
    fd.append('notes', el('notes').value);
    fd.append('screenshot', fileInput.files[0]);

    try {
      const res = await fetch('/api/bookings', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'HOLD_EXPIRED') {
          handleHoldExpired();
          return;
        }
        formError.textContent = data.error || 'Could not submit that booking.';
        submitBtn.disabled = false;
        submitLabel.textContent = 'SUBMIT FOR REVIEW';
        if (data.code === 'TAKEN') {
          stopHoldCountdown();
          currentHold = null;
          selectedSlots.clear();
          updateSummaryBar();
          await loadTimes();
        }
        return;
      }
      stopHoldCountdown();
      currentHold = null;
      el('holdTimer').classList.add('hidden');
      bookingForm.classList.add('hidden');
      el('selectedSlotsList').classList.add('hidden');
      el('paymentAmount').closest('.payment-box').classList.add('hidden');
      successBox.classList.remove('hidden');
      bookingCard.classList.add('success-compact');
      selectedSlots.clear();
      updateSummaryBar();
      await loadTimes();
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
