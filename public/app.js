(function () {
  let CONFIG = null;
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
  // Set by selectDate() when switching to a new date should also clear the
  // current selection. Deferred until renderTimes()'s animateListHeight
  // callback runs (rather than done immediately in selectDate) so the
  // selection-summary bar collapsing and the time-list swapping happen as
  // ONE atomic, height-locked update -- otherwise the summary bar (and the
  // Clear/Next buttons re-disabling) collapses instantly before the height
  // animation even starts measuring, which is what made date switches look
  // like they "snap" even when the time-list swap itself was animated.
  let pendingSelectionClear = false;
  let holdCountdownInterval = null;

  const el = (id) => document.getElementById(id);
  const dayStrip = el('dayStrip');
  const moreDatesBtn = el('moreDatesBtn');
  const calendarPopover = el('calendarPopover');
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

  // Split version for the grid's row labels: a short numeric range on its
  // own line ("11 - 12") plus a small period line below ("AM" normally, or
  // "AM-PM" for the one slot each day that crosses noon/midnight). Splitting
  // it this way keeps every row label the same tidy two-line shape instead
  // of the AM/PM-crossing row alone being a much longer single line that
  // reads as cramped against the shorter ones around it.
  function fmtTimeParts(h) {
    const start = to12Hour(h);
    const end = to12Hour(h + 1);
    const period = start.period === end.period ? start.period : `${start.period}-${end.period}`;
    return { range: `${start.hour} - ${end.hour}`, period };
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

  // Takes the response index.html already started fetching, if it's there
  // and succeeded; otherwise just does the request itself. Same for the
  // day's availability in fetchDay() below.
  function bootstrapped(key, expectedDate) {
    const boot = window.__boot;
    if (!boot) return null;
    if (expectedDate && boot.date !== expectedDate) return null;
    const promise = boot[key];
    // One use only -- a later call must get fresh data, not a replay of
    // whatever the page happened to load with.
    boot[key] = null;
    return promise || null;
  }

  async function loadConfig() {
    const booted = await (bootstrapped('config') || Promise.resolve(null));
    CONFIG = booted || await (await fetch('/api/config')).json();

    if (CONFIG.name) {
      el('venueName').textContent = CONFIG.name;
      el('modalVenueName').textContent = CONFIG.name;
      document.title = `${CONFIG.name} \u2014 Court Booking`;
    }

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

  }

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
    // updateSummaryBar() runs as part of renderTimes()'s own height-locked
    // update below, not separately here -- see the comment in renderTimes().
    renderTimes();
  }

  clearSelectionBtn.addEventListener('click', () => {
    selectedSlots.clear();
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
        await loadTimes(true);
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
    // Those slots are free again, so don't let a cached copy of the day
    // keep showing them as held.
    dayCache.clear();
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
    loadTimes(true);
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
      pendingSelectionClear = true;
    }
    renderCalendar();
    renderDayStrip();
    closeCalendarPopover();
    loadTimes();
  }

  // --- Day strip (the row of tappable day pills above the grid) ----------
  // Always shows the calendar week (Sun-Sat) containing today -- anything
  // further out is reached through the "More" calendar popover instead of
  // scrolling this strip indefinitely.
  function renderDayStrip() {
    const today = todayDate();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());
    const todayS = todayStr();
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    dayStrip.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const dateStr = fmtDate(d);
      const isToday = dateStr === todayS;
      const isSelected = dateStr === selectedDate;
      const isPast = dateStr < todayS;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'day-pill' + (isToday ? ' today' : '') + (isSelected ? ' selected' : '');
      btn.innerHTML = `<span class="day-pill-label">${dayLabels[i]}</span><span class="day-pill-num">${d.getDate()}</span>`;
      if (isToday) btn.innerHTML += '<span class="day-pill-dot"></span>';
      if (isPast) {
        btn.disabled = true;
      } else {
        btn.addEventListener('click', () => selectDate(dateStr));
      }
      dayStrip.appendChild(btn);
    }
  }

  // The popover used to live inside .booking-card, which clips its own
  // contents (overflow: hidden, so its rounded corners stay clean). That
  // meant the calendar got cut off any time it was taller than whatever
  // card space happened to be left below it -- a real risk on a phone
  // screen, where the card is narrower and every row of extra month grid
  // eats into less headroom. Moving the popover to <body> and positioning
  // it with fixed coordinates computed from the "More" button escapes that
  // clipping entirely, so it always renders in full regardless of card
  // height. It reparents once and stays in <body> from then on -- reusing
  // it in place is simpler than moving it back and forth on every toggle.
  function positionCalendarPopover() {
    const btnRect = moreDatesBtn.getBoundingClientRect();
    const popWidth = calendarPopover.offsetWidth || 280;
    const margin = 16;
    let left = btnRect.right - popWidth;
    left = Math.max(margin, Math.min(left, window.innerWidth - popWidth - margin));
    let top = btnRect.bottom + 8;
    const popHeight = calendarPopover.offsetHeight;
    if (popHeight && top + popHeight > window.innerHeight - margin) {
      // Not enough room below the button (common on short mobile viewports
      // once the keyboard-safe area is factored in) -- open upward instead.
      top = Math.max(margin, btnRect.top - popHeight - 8);
    }
    calendarPopover.style.left = `${left}px`;
    calendarPopover.style.top = `${top}px`;
  }

  function openCalendarPopover() {
    if (calendarPopover.parentElement !== document.body) {
      document.body.appendChild(calendarPopover);
    }
    calendarPopover.classList.remove('hidden');
    positionCalendarPopover();
    moreDatesBtn.classList.add('active');
    moreDatesBtn.setAttribute('aria-expanded', 'true');
    window.addEventListener('resize', positionCalendarPopover);
    window.addEventListener('scroll', positionCalendarPopover, true);
  }

  function closeCalendarPopover() {
    calendarPopover.classList.add('hidden');
    moreDatesBtn.classList.remove('active');
    moreDatesBtn.setAttribute('aria-expanded', 'false');
    window.removeEventListener('resize', positionCalendarPopover);
    window.removeEventListener('scroll', positionCalendarPopover, true);
  }

  moreDatesBtn.addEventListener('click', () => {
    if (calendarPopover.classList.contains('hidden')) openCalendarPopover();
    else closeCalendarPopover();
  });

  document.addEventListener('click', (e) => {
    if (calendarPopover.classList.contains('hidden')) return;
    if (e.target === moreDatesBtn || moreDatesBtn.contains(e.target)) return;
    if (calendarPopover.contains(e.target)) return;
    closeCalendarPopover();
  });

  monthPrevBtn.addEventListener('click', () => {
    const candidate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    const floor = firstOfMonth(new Date());
    calendarMonth = candidate < floor ? floor : candidate;
    renderCalendar();
    positionCalendarPopover();
  });

  monthNextBtn.addEventListener('click', () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    renderCalendar();
    positionCalendarPopover();
  });

  // --- Times list ---

  // A day's availability is fetched once and reused when the customer flips
  // back to a date they already looked at, instead of paying for another
  // round trip every single time. Deliberately short-lived, because someone
  // else may be booking at the same moment -- and anything that changes
  // availability from this browser clears it outright (see loadTimes(true)
  // at every such call site). Worst case a slot shown as free was just
  // taken by someone else, and the server refuses the hold with a clear
  // message -- which it already does regardless of caching, since the
  // database is what actually guarantees a slot can't be double-booked.
  const dayCache = new Map();
  const DAY_CACHE_MS = 20_000;

  async function fetchDay(date, fresh) {
    const cached = dayCache.get(date);
    if (!fresh && cached && Date.now() - cached.at < DAY_CACHE_MS) return cached.bookings;
    const booted = fresh ? null : await (bootstrapped('day', date) || Promise.resolve(null));
    const data = booted || await (await fetch(`/api/bookings?date=${date}`)).json();
    const bookings = data.bookings || [];
    dayCache.set(date, { at: Date.now(), bookings });
    return bookings;
  }

  function applyDay(bookings) {
    dayBookings = {};
    bookings.forEach((b) => {
      dayBookings[`${b.courtId}-${b.hour}`] = b;
    });
  }

  // `fresh` skips the cache -- pass it whenever availability may have just
  // changed (a hold was taken or released, a booking went through, a hold
  // expired), so we never render a stale day right after changing it.
  async function loadTimes(fresh) {
    const date = selectedDate;
    if (fresh) dayCache.clear();
    const bookings = await fetchDay(date, fresh);
    // Guard against a slower earlier request landing after a newer one and
    // painting the wrong day's availability -- easy to trigger by clicking
    // through dates quickly.
    if (date !== selectedDate) return;
    applyDay(bookings);
    renderTimes();
  }

  // Smoothly resizes the times list when its content changes (switching to
  // a date with a different number of available slots).
  //
  // This animates the TIME LIST itself, not the outer card, and that
  // distinction is the whole fix. Animating the outer card's height looked
  // correct when growing but always read as a snap when shrinking, for a
  // subtle reason: the card is a normal block whose children reflow the
  // instant the content changes. So on a shrink, the moment the shorter
  // list was swapped in, the list, the Clear/Next footer and everything
  // else immediately jumped to their final positions inside a card that
  // was still pinned to its old, taller height -- all that was left to
  // animate was 60-odd pixels of empty space below the footer. Everything
  // the eye actually tracks had already moved; only the card's bottom edge
  // glided. Growing hid this because the taller content was clipped by the
  // card's overflow and got revealed as the card opened up.
  //
  // Animating the list means the box that actually changes size is the one
  // being animated, and normal layout carries everything below it -- the
  // footer and the card's bottom edge -- along smoothly, identically in
  // both directions.
  function animateListHeight(el, updateFn) {
    const startHeight = el.getBoundingClientRect().height;

    // First render (the list is still empty, so it has no height yet): just
    // fill it in. Animating up from zero here would make the list visibly
    // unfold every time the page loads, which isn't a resize -- it's just
    // the page arriving.
    if (startHeight === 0) {
      updateFn();
      return;
    }

    // Lock the current height with transitions off, and force the browser to
    // commit that as its own style/layout state before anything else --
    // forcing a reflow (offsetHeight) makes this reliable without depending
    // on requestAnimationFrame, which doesn't run in a backgrounded tab.
    //
    // This locks an explicit `height`, not `max-height`. A max-height only
    // caps how tall a box may get; it never keeps one from shrinking below
    // it. So with max-height the box dropped straight to its new smaller
    // size the instant the content changed, leaving the transition nothing
    // to animate from -- another reason shrinking used to snap.
    el.style.transition = 'none';
    el.style.height = startHeight + 'px';
    void el.offsetHeight;

    updateFn();

    // Measure the real target by briefly releasing to auto. Nothing is
    // painted during this synchronous stretch, so there's no flash. Reading
    // the rect (rather than scrollHeight) is deliberate: it respects the
    // list's CSS max-height, so a long list targets that cap and scrolls
    // inside it, exactly as it does when no animation is involved.
    el.style.height = 'auto';
    const targetHeight = el.getBoundingClientRect().height;
    el.style.height = startHeight + 'px';
    void el.offsetHeight;

    // Clearing the inline override falls back to the CSS-declared
    // transition, which is what honors prefers-reduced-motion. Commit that
    // as its own state before changing the height so the browser has two
    // genuinely distinct states to transition between.
    el.style.transition = '';
    void el.offsetHeight;
    el.style.height = targetHeight + 'px';

    // Once settled, hand the height back to natural sizing so a later
    // window resize isn't stuck at a stale pinned value. Because the target
    // above was measured against real auto sizing, this changes nothing
    // visually -- there's no final correction to snap.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      el.style.height = '';
      el.removeEventListener('transitionend', onEnd);
      clearTimeout(fallback);
    };
    const onEnd = (e) => {
      if (e.target !== el || e.propertyName !== 'height') return;
      release();
    };
    el.addEventListener('transitionend', onEnd);
    // Safety net: transitionend never fires if there's no transition to run
    // at all -- most notably under prefers-reduced-motion, where the CSS
    // disables it. Without this the height would stay pinned to a number
    // that's correct now but goes stale on the next window resize.
    const fallback = setTimeout(release, 400);
  }

  // Renders the court x time grid for selectedDate: one column per court
  // (from CONFIG.courts), one row per operating hour, so every court's
  // availability is visible at once instead of switching between courts.
  function renderTimes() {
    const dateObj = new Date(selectedDate + 'T00:00:00');
    timesHeading.textContent = dateObj.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });

    const hours = CONFIG.hours.filter((hour) => !isPastSlot(selectedDate, hour));
    const courts = CONFIG.courts;

    animateListHeight(timeList, () => {
      if (pendingSelectionClear) {
        pendingSelectionClear = false;
        selectedSlots.clear();
      }

      timeList.innerHTML = '';

      if (hours.length === 0) {
        timeList.style.gridTemplateColumns = '1fr';
        const empty = document.createElement('div');
        empty.className = 'time-empty';
        empty.textContent = 'No times available for this date.';
        timeList.appendChild(empty);
        updateSummaryBar();
        return;
      }

      timeList.style.gridTemplateColumns = `92px repeat(${courts.length}, minmax(96px, 1fr))`;

      const corner = document.createElement('div');
      corner.className = 'grid-corner';
      timeList.appendChild(corner);

      courts.forEach((court) => {
        const header = document.createElement('div');
        header.className = 'grid-court-header';
        header.textContent = court.name;
        timeList.appendChild(header);
      });

      hours.forEach((hour) => {
        const rowLabel = document.createElement('div');
        rowLabel.className = 'grid-row-label';
        const timeParts = fmtTimeParts(hour);
        rowLabel.innerHTML = `<span class="grid-row-label-range">${timeParts.range}</span><span class="grid-row-label-period">${timeParts.period}</span>`;
        timeList.appendChild(rowLabel);

        courts.forEach((court) => {
          const key = `${court.id}-${hour}`;
          const booking = dayBookings[key];
          const selKey = `${court.id}-${selectedDate}-${hour}`;
          const isSelected = selectedSlots.has(selKey);

          const cell = document.createElement('button');
          cell.type = 'button';

          if (booking && booking.status === 'pending') {
            cell.className = 'grid-cell pending';
            cell.disabled = true;
            cell.innerHTML = '<span>Pending</span>';
          } else if (booking) {
            cell.className = 'grid-cell unavailable';
            cell.disabled = true;
            cell.innerHTML = '<span>Booked</span>';
          } else if (isSelected) {
            cell.className = 'grid-cell selected';
            cell.innerHTML = `<span>Selected</span><span class="grid-cell-price">₱${CONFIG.pricePerHour}</span>`;
            cell.addEventListener('click', () => toggleSlot(court.id, selectedDate, hour));
          } else {
            cell.className = 'grid-cell';
            cell.innerHTML = `<span>Available</span><span class="grid-cell-price">₱${CONFIG.pricePerHour}</span>`;
            cell.addEventListener('click', () => toggleSlot(court.id, selectedDate, hour));
          }
          timeList.appendChild(cell);
        });
      });

      // Runs inside the same height-locked update as the row rebuild above
      // (rather than as a separate call after renderTimes() returns) so a
      // selection change's summary bar and a date change's grid always
      // resize together in one animation instead of the summary bar
      // popping in/out on its own beat.
      updateSummaryBar();
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
    await loadTimes(true);
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
          await loadTimes(true);
        }
        return;
      }
      el('successName').textContent = nameValue;
      el('successAmount').textContent = `\u20b1${transactionTotal(selectedSlots.size)}`;
      const successSlots = Array.from(selectedSlots.values()).sort(
        (a, b) => a.date.localeCompare(b.date) || a.courtId - b.courtId || a.hour - b.hour
      );
      el('successSlots').innerHTML = successSlots
        .map((s) => {
          const shortDate = new Date(s.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          return `<div class="success-summary-row"><span>${shortDate}, ${fmtTime(s.hour)}</span><span>${courtName(s.courtId)}</span></div>`;
        })
        .join('');

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
      await loadTimes(true);
    } catch (err) {
      formError.textContent = 'Network error. Please try again.';
      submitBtn.disabled = false;
      submitLabel.textContent = 'SUBMIT FOR REVIEW';
    }
  });

  (async function init() {
    // Fire both requests at once rather than waiting for the config
    // response before even asking for availability. The availability
    // request only needs selectedDate, which is computed locally, so the
    // old sequential version was stacking two full round trips back to
    // back on every single page load for no reason.
    const initialDate = selectedDate;
    const configReady = loadConfig();
    const dayReady = fetchDay(initialDate);

    await configReady;
    updateSummaryBar();
    renderCalendar();
    renderDayStrip();

    const bookings = await dayReady;
    // Skip if the customer already picked a different date while this was
    // still loading -- that click's own load owns the list now.
    if (initialDate === selectedDate) {
      applyDay(bookings);
      renderTimes();
    }
  })();
})();
