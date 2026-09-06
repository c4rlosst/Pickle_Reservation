(function () {
  let CONFIG = null;
  let adminPassword = sessionStorage.getItem('fora_admin_pw') || '';
  const selectedBlockHours = new Set();
  let allBookings = []; // unfiltered, refreshed each loadBookings() — used to show
                         // which hours are already taken in the block-a-slot picker

  const el = (id) => document.getElementById(id);
  const loginBox = el('loginBox');
  const adminMain = el('adminMain');
  const toast = el('toast');
  const lightbox = el('lightbox');
  const lightboxImg = el('lightboxImg');
  const textLightbox = el('textLightbox');
  const textLightboxContent = el('textLightboxContent');

  function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = 'toast ' + (type || '');
    setTimeout(() => (toast.className = 'toast hidden'), 3200);
  }

  function fmtHour(h) {
    const period = h >= 12 ? 'PM' : 'AM';
    let hour12 = h % 12;
    if (hour12 === 0) hour12 = 12;
    return `${hour12}:00 ${period}`;
  }

  function courtName(id) {
    const c = CONFIG.courts.find((c) => c.id === id);
    return c ? c.name : `Court ${id}`;
  }

  lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));
  textLightbox.addEventListener('click', () => textLightbox.classList.add('hidden'));
  textLightboxContent.addEventListener('click', (e) => e.stopPropagation());

  // Custom confirm/prompt modal -- native window.confirm()/prompt() are
  // unreliable inside some embedded/webview browser contexts (they can be
  // silently auto-dismissed), which made Confirm/Reject/Cancel/Delete
  // appear completely dead with no visible error. This in-page modal works
  // everywhere the rest of the app already works.
  const confirmModal = el('confirmModal');
  const confirmModalCard = confirmModal.querySelector('.confirm-modal-card');
  const confirmModalMsg = el('confirmModalMsg');
  const confirmModalInput = el('confirmModalInput');
  const confirmModalCancel = el('confirmModalCancel');
  const confirmModalOk = el('confirmModalOk');
  let confirmModalResolve = null;
  let confirmModalIsPrompt = false;

  function closeConfirmModal(confirmed) {
    confirmModal.classList.add('hidden');
    const resolve = confirmModalResolve;
    confirmModalResolve = null;
    if (!resolve) return;
    resolve(confirmModalIsPrompt ? (confirmed ? confirmModalInput.value.trim() : null) : Boolean(confirmed));
  }

  confirmModal.addEventListener('click', () => closeConfirmModal(false));
  confirmModalCard.addEventListener('click', (e) => e.stopPropagation());
  confirmModalCancel.addEventListener('click', () => closeConfirmModal(false));
  confirmModalOk.addEventListener('click', () => closeConfirmModal(true));
  confirmModalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      closeConfirmModal(true);
    }
  });

  function openConfirmModal({ message, okLabel, danger, withInput, inputPlaceholder }) {
    return new Promise((resolve) => {
      confirmModalResolve = resolve;
      confirmModalIsPrompt = Boolean(withInput);
      confirmModalMsg.textContent = message;
      confirmModalOk.textContent = okLabel || 'OK';
      confirmModalOk.classList.toggle('danger', Boolean(danger));
      if (withInput) {
        confirmModalInput.classList.remove('hidden');
        confirmModalInput.value = '';
        confirmModalInput.placeholder = inputPlaceholder || '';
      } else {
        confirmModalInput.classList.add('hidden');
      }
      confirmModal.classList.remove('hidden');
      requestAnimationFrame(() => (withInput ? confirmModalInput : confirmModalOk).focus());
    });
  }

  function showConfirm(message, opts) {
    return openConfirmModal(Object.assign({ message }, opts));
  }

  function showPrompt(message, opts) {
    return openConfirmModal(Object.assign({ message, withInput: true }, opts));
  }

  function notesCellHtml(preview, full) {
    if (!full) return '';
    return `<button type="button" class="notes-icon-btn" data-full="${escapeHtml(full)}" title="View notes" aria-label="View notes"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg></button>`;
  }

  el('bookingTbody').addEventListener('click', (e) => {
    const trigger = e.target.closest('.notes-icon-btn');
    if (!trigger) return;
    textLightboxContent.textContent = trigger.dataset.full;
    textLightbox.classList.remove('hidden');
  });

  async function authedFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { 'x-admin-password': adminPassword });
    const res = await fetch(url, opts);
    if (res.status === 401) {
      sessionStorage.removeItem('fora_admin_pw');
      showLogin('Session expired. Please log in again.');
      throw new Error('Unauthorized');
    }
    return res;
  }

  function showLogin(err) {
    loginBox.classList.remove('hidden');
    adminMain.classList.add('hidden');
    el('loginError').textContent = err || '';
    el('changePasswordBtn').classList.add('hidden');
  }

  function showAdmin() {
    loginBox.classList.add('hidden');
    adminMain.classList.remove('hidden');
    el('changePasswordBtn').classList.remove('hidden');
  }

  // --- Change admin password ---------------------------------------------
  const changePasswordModal = el('changePasswordModal');
  const changePasswordForm = el('changePasswordForm');
  const changePasswordError = el('changePasswordError');

  function openChangePasswordModal() {
    changePasswordForm.reset();
    changePasswordError.textContent = '';
    changePasswordModal.classList.remove('hidden');
    requestAnimationFrame(() => el('cpCurrent').focus());
  }

  function closeChangePasswordModal() {
    changePasswordModal.classList.add('hidden');
  }

  el('changePasswordBtn').addEventListener('click', openChangePasswordModal);
  el('changePasswordCancel').addEventListener('click', closeChangePasswordModal);
  changePasswordModal.addEventListener('click', (e) => {
    if (e.target === changePasswordModal) closeChangePasswordModal();
  });

  changePasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    changePasswordError.textContent = '';

    const current = el('cpCurrent').value;
    const next = el('cpNew').value;
    const confirm = el('cpConfirm').value;

    if (next.length < 8) {
      changePasswordError.textContent = 'New password must be at least 8 characters.';
      return;
    }
    if (next !== confirm) {
      changePasswordError.textContent = "New passwords don't match.";
      return;
    }

    const submitBtn = el('changePasswordSubmit');
    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/admin/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': current },
        body: JSON.stringify({ newPassword: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        changePasswordError.textContent = data.error || 'Could not change password.';
        return;
      }
      adminPassword = next;
      sessionStorage.setItem('fora_admin_pw', next);
      closeChangePasswordModal();
      showToast('Password changed.', 'success');
    } catch (err) {
      changePasswordError.textContent = 'Network error. Please try again.';
    } finally {
      submitBtn.disabled = false;
    }
  });

  el('loginBtn').addEventListener('click', async () => {
    const pw = el('password').value;
    if (!pw) return;
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (data.ok) {
      adminPassword = pw;
      sessionStorage.setItem('fora_admin_pw', pw);
      await boot();
    } else {
      el('loginError').textContent = data.error || 'Login failed';
    }
  });

  el('password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('loginBtn').click();
  });

  async function loadConfig() {
    const res = await fetch('/api/config');
    CONFIG = await res.json();

    if (CONFIG.name) {
      el('siteVenueName').textContent = CONFIG.name;
      el('siteVenueSub').textContent = `Manage ${CONFIG.name} court bookings`;
      el('siteMark').textContent = CONFIG.name.trim().charAt(0).toUpperCase() || 'F';
      document.title = `Admin \u2014 ${CONFIG.name}`;
    }
  }

  // Local calendar date as YYYY-MM-DD -- NOT toISOString(), which is UTC
  // and rolls back to "yesterday" for anyone east of UTC (e.g. PHT, UTC+8)
  // once local time is past midnight but UTC hasn't rolled over yet.
  function todayLocalStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function populateBlockForm() {
    const courtSel = el('blockCourt');
    courtSel.innerHTML = CONFIG.courts.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');

    el('blockDate').value = todayLocalStr();

    selectedBlockHours.clear();
    const hoursWrap = el('blockHours');
    hoursWrap.innerHTML = CONFIG.hours
      .map((h) => `<button type="button" class="hour-chip" data-hour="${h}">${fmtHour(h)}</button>`)
      .join('');
    updateBlockHoursAvailability();
  }

  function updateBlockHoursSummary() {
    const label = el('blockHoursLabel');
    if (selectedBlockHours.size === 0) label.textContent = 'Select times';
    else if (selectedBlockHours.size === 1) label.textContent = '1 time selected';
    else label.textContent = `${selectedBlockHours.size} times selected`;
  }

  // Marks each time chip as already taken (pending/confirmed/blocked
  // booking on that court+date) so staff can see at a glance what's
  // actually free to block, instead of guessing and hitting a "TAKEN" error.
  function updateBlockHoursAvailability() {
    const courtId = Number(el('blockCourt').value);
    const date = el('blockDate').value;
    // Map each taken hour to its status so the chip can be colored:
    // pending (awaiting confirmation) vs confirmed/blocked (locked in).
    const hourStatus = new Map();
    allBookings
      .filter((b) => b.courtId === courtId && b.date === date && ['pending', 'confirmed', 'blocked'].includes(b.status))
      .forEach((b) => hourStatus.set(b.hour, b.status));

    el('blockHours').querySelectorAll('.hour-chip').forEach((chip) => {
      const hour = Number(chip.dataset.hour);
      const status = hourStatus.get(hour);
      const taken = Boolean(status);
      chip.classList.toggle('taken', taken);
      chip.classList.toggle('pending', status === 'pending');
      chip.classList.toggle('booked', status === 'confirmed' || status === 'blocked');
      chip.disabled = taken;
      chip.title = status === 'pending'
        ? 'Pending — awaiting confirmation'
        : taken
          ? 'Already booked or blocked'
          : 'Available';
      if (taken && selectedBlockHours.has(hour)) {
        selectedBlockHours.delete(hour);
        chip.classList.remove('selected');
      }
    });
    updateBlockHoursSummary();
  }

  el('blockCourt').addEventListener('change', updateBlockHoursAvailability);
  el('blockDate').addEventListener('change', updateBlockHoursAvailability);

  // A dedicated button for opening the date field's native picker -- see
  // the .date-field-btn comment in admin.html for why this exists instead
  // of relying on the browser's own tiny calendar icon.
  el('blockDateBtn').addEventListener('click', () => {
    const input = el('blockDate');
    if (typeof input.showPicker === 'function') {
      try {
        input.showPicker();
        return;
      } catch (err) {
        // Falls through to focus() below (e.g. browsers that support
        // showPicker() but still throw in some contexts).
      }
    }
    input.focus();
  });

  el('blockHours').addEventListener('click', (e) => {
    const chip = e.target.closest('.hour-chip');
    if (!chip || chip.disabled) return;
    const hour = Number(chip.dataset.hour);
    if (selectedBlockHours.has(hour)) {
      selectedBlockHours.delete(hour);
      chip.classList.remove('selected');
    } else {
      selectedBlockHours.add(hour);
      chip.classList.add('selected');
    }
    updateBlockHoursSummary();
  });

  el('blockBtn').addEventListener('click', async () => {
    if (selectedBlockHours.size === 0) {
      showToast('Pick at least one time to block', 'error');
      return;
    }
    const courtId = Number(el('blockCourt').value);
    const date = el('blockDate').value;
    const notes = el('blockNotes').value;
    const hours = Array.from(selectedBlockHours).sort((a, b) => a - b);

    let blocked = 0;
    let failed = 0;
    let firstError = '';
    for (const hour of hours) {
      try {
        const res = await authedFetch('/api/admin/block', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ courtId, date, hour, notes }),
        });
        const data = await res.json();
        if (!res.ok) {
          failed++;
          firstError = firstError || data.error || 'Could not block slot';
        } else {
          blocked++;
        }
      } catch (e) {
        failed++;
        /* network/auth errors already surfaced by authedFetch */
      }
    }

    if (blocked > 0) {
      const msg = failed > 0
        ? `${blocked} slot${blocked > 1 ? 's' : ''} blocked, ${failed} failed${firstError ? ` (${firstError})` : ''}`
        : `${blocked} slot${blocked > 1 ? 's' : ''} blocked`;
      showToast(msg, failed > 0 ? 'error' : 'success');
    } else if (failed > 0) {
      showToast(firstError || 'Could not block those slots', 'error');
    }

    el('blockNotes').value = '';
    selectedBlockHours.clear();
    el('blockHours').querySelectorAll('.hour-chip.selected').forEach((c) => c.classList.remove('selected'));
    updateBlockHoursSummary();
    await loadBookings();
  });

  async function loadBookings() {
    const res = await authedFetch('/api/admin/bookings');
    const data = await res.json();
    allBookings = data.bookings || [];
    updateBlockHoursAvailability();

    let bookings = allBookings;
    const statusFilter = el('filterStatus').value;
    const dateFilter = el('filterDate').value.trim();

    if (statusFilter !== 'all') {
      bookings = bookings.filter((b) => b.status === statusFilter);
    }
    if (dateFilter) {
      bookings = bookings.filter((b) => b.date === dateFilter);
    }

    const tbody = el('bookingTbody');
    tbody.innerHTML = '';
    if (bookings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:24px;">No bookings found.</td></tr>';
      el('reservationCount').textContent = '';
      return;
    }

    // Every customer submission (one payment, one screenshot) shares a
    // single groupId, however many court/hour slots it covers -- that's one
    // reservation/transaction, so it's always rendered as one row and acted
    // on as one unit, at every status (pending, confirmed, rejected,
    // cancelled). Only groupId-less rows (admin-blocked slots, or a rare
    // legacy row from before groupId existed) render individually.
    const renderedGroups = new Set();
    let reservationCount = 0;

    bookings.forEach((b) => {
      const isGroupable = Boolean(b.groupId);
      if (isGroupable) {
        const key = `${b.groupId}|${b.status}`;
        if (renderedGroups.has(key)) return; // already rendered with the group
        renderedGroups.add(key);
        const groupBookings = bookings.filter((x) => x.groupId === b.groupId && x.status === b.status);
        renderGroupRow(tbody, groupBookings);
      } else {
        renderSingleRow(tbody, b);
      }
      reservationCount += 1;
    });

    el('reservationCount').textContent = `${reservationCount} reservation${reservationCount === 1 ? '' : 's'}`;
  }

  function addCardToggle(tr, actionsDiv) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'card-toggle-btn';
    toggleBtn.textContent = 'Show details';
    toggleBtn.addEventListener('click', () => {
      const expanded = tr.classList.toggle('expanded');
      toggleBtn.textContent = expanded ? 'Hide details' : 'Show details';
    });
    actionsDiv.insertBefore(toggleBtn, actionsDiv.firstChild);
  }

  // A group's total is what the customer actually paid: the courts
  // subtotal (sum of each slot's price) plus the platform fee charged ONCE
  // for the whole transaction -- never once per slot. Only real paid
  // transactions carry a groupId (blocked slots don't), so this is safe to
  // apply to every group unconditionally.
  function groupTotal(group) {
    const subtotal = group.reduce((sum, b) => sum + (b.price || 0), 0);
    return subtotal + (CONFIG.platformFee || 0);
  }

  function renderGroupRow(tbody, group) {
    const tr = document.createElement('tr');
    const first = group[0];
    const totalPrice = groupTotal(group);
    const slotsHtml = group
      .map((b) => `${fmtHour(b.hour)} <span class="muted">${courtName(b.courtId)}</span>`)
      .join('<br>');
    const notesParts = [];
    if (first.notes) notesParts.push(first.notes);
    if (first.rejectReason) notesParts.push(`Reason: ${first.rejectReason}`);

    tr.innerHTML = `
      <td data-label="Date">${first.date}</td>
      <td data-label="Time">${slotsHtml}</td>
      <td data-label="Court">${group.length} slot${group.length > 1 ? 's' : ''}</td>
      <td data-label="Name">${escapeHtml(first.name)}<div class="muted">₱${totalPrice} total</div></td>
      <td data-label="Contact" data-collapsible="true">${escapeHtml(first.contact)}</td>
      <td class="proof-cell" data-label="Proof" data-collapsible="true"></td>
      <td data-label="Notes" data-collapsible="true">${notesCellHtml(notesParts.join(' · '), notesParts.join('\n'))}</td>
      <td data-label="Status"><span class="status-badge status-${first.status}">${first.status} (${group.length})</span></td>
      <td data-label="Actions"><div class="row-actions"></div></td>
    `;

    const proofCell = tr.querySelector('.proof-cell');
    addProofThumb(proofCell, first);

    const actionsTd = tr.querySelector('.row-actions');
    const ids = group.map((b) => b.id);

    if (first.status === 'pending') {
      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = `Confirm all (${group.length})`;
      confirmBtn.className = 'confirm';
      confirmBtn.addEventListener('click', () => confirmGroup(first.groupId, group.length));
      actionsTd.appendChild(confirmBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.textContent = 'Reject all';
      rejectBtn.className = 'reject';
      rejectBtn.addEventListener('click', () => rejectGroup(first.groupId));
      actionsTd.appendChild(rejectBtn);
    }

    if (first.status === 'confirmed') {
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = `Cancel all (${group.length})`;
      cancelBtn.addEventListener('click', () => cancelGroup(ids));
      actionsTd.appendChild(cancelBtn);
    }

    if (first.status !== 'pending') {
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = `Delete all (${group.length})`;
      deleteBtn.addEventListener('click', () => deleteGroup(ids));
      actionsTd.appendChild(deleteBtn);
    }

    addCardToggle(tr, actionsTd);
    tbody.appendChild(tr);
  }

  function renderSingleRow(tbody, b) {
    const tr = document.createElement('tr');
    const priceLabel = b.price ? `₱${b.price}` : '';
    tr.innerHTML = `
      <td data-label="Date">${b.date}</td>
      <td data-label="Time">${fmtHour(b.hour)}</td>
      <td data-label="Court">${courtName(b.courtId)}</td>
      <td data-label="Name">${escapeHtml(b.name)}${priceLabel ? `<div class="muted">${priceLabel}</div>` : ''}</td>
      <td data-label="Contact" data-collapsible="true">${escapeHtml(b.contact)}</td>
      <td class="proof-cell" data-label="Proof" data-collapsible="true"></td>
      <td data-label="Notes" data-collapsible="true">${(() => {
        const parts = [];
        if (b.notes) parts.push(b.notes);
        if (b.rejectReason) parts.push(`Reason: ${b.rejectReason}`);
        return notesCellHtml(parts.join(' \u00b7 '), parts.join('\n'));
      })()}</td>
      <td data-label="Status"><span class="status-badge status-${b.status}">${b.status}</span></td>
      <td data-label="Actions"><div class="row-actions"></div></td>
    `;

    const proofCell = tr.querySelector('.proof-cell');
    addProofThumb(proofCell, b);

    const actionsTd = tr.querySelector('.row-actions');

    if (b.status === 'pending') {
      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = 'Confirm';
      confirmBtn.className = 'confirm';
      confirmBtn.addEventListener('click', () => confirmGroup(b.groupId || String(b.id), 1));
      actionsTd.appendChild(confirmBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.textContent = 'Reject';
      rejectBtn.className = 'reject';
      rejectBtn.addEventListener('click', () => rejectGroup(b.groupId || String(b.id)));
      actionsTd.appendChild(rejectBtn);
    }

    if (b.status === 'confirmed' || b.status === 'blocked') {
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => cancelBooking(b.id));
      actionsTd.appendChild(cancelBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteBooking(b.id));
    actionsTd.appendChild(deleteBtn);

    addCardToggle(tr, actionsTd);
    tbody.appendChild(tr);
  }

  function addProofThumb(cell, b) {
    if (b.screenshotUrl) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = b.screenshotUrl;
      img.alt = 'Payment screenshot';
      img.addEventListener('click', () => {
        lightboxImg.src = b.screenshotUrl;
        lightbox.classList.remove('hidden');
      });
      cell.appendChild(img);
    } else {
      cell.innerHTML = '<span class="muted">—</span>';
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function confirmGroup(groupId, count) {
    const label = count > 1 ? `these ${count} slots` : 'this booking';
    const ok = await showConfirm(`Confirm ${label}? Only do this after verifying the payment screenshot is real.`, { okLabel: 'Confirm' });
    if (!ok) return;
    try {
      const res = await authedFetch(`/api/admin/groups/${groupId}/confirm`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast(count > 1 ? `${count} slots confirmed` : 'Booking confirmed', 'success');
        await loadBookings();
      } else {
        showToast(data.error || 'Could not confirm booking', 'error');
      }
    } catch (e) {}
  }

  async function rejectGroup(groupId) {
    const reason = await showPrompt('Reason for rejecting (optional, e.g. "Screenshot does not match amount"):', { okLabel: 'Reject', danger: true, inputPlaceholder: 'Reason (optional)' });
    if (reason === null) return;
    try {
      const res = await authedFetch(`/api/admin/groups/${groupId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Booking rejected — slot(s) re-opened', 'success');
        await loadBookings();
      } else {
        showToast(data.error || 'Could not reject booking', 'error');
      }
    } catch (e) {}
  }

  async function cancelBooking(id) {
    const ok = await showConfirm('Cancel this booking and re-open the slot?', { okLabel: 'Cancel booking', danger: true });
    if (!ok) return;
    try {
      const res = await authedFetch(`/api/admin/bookings/${id}/cancel`, { method: 'POST' });
      if (res.ok) {
        showToast('Booking cancelled', 'success');
        await loadBookings();
      }
    } catch (e) {}
  }

  async function deleteBooking(id) {
    const ok = await showConfirm('Permanently delete this booking?', { okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const res = await authedFetch(`/api/admin/bookings/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Booking deleted', 'success');
        await loadBookings();
      }
    } catch (e) {}
  }

  // Whole-transaction versions of cancel/delete -- a customer's multi-slot
  // booking is one reservation, so cancelling or deleting it acts on every
  // slot in that group at once rather than leaving some behind.
  async function cancelGroup(ids) {
    const label = ids.length > 1 ? `all ${ids.length} slots` : 'this booking';
    const ok = await showConfirm(`Cancel ${label} and re-open ${ids.length > 1 ? 'them' : 'it'}?`, { okLabel: 'Cancel booking', danger: true });
    if (!ok) return;
    try {
      const results = await Promise.all(ids.map((id) => authedFetch(`/api/admin/bookings/${id}/cancel`, { method: 'POST' })));
      if (results.every((res) => res.ok)) {
        showToast('Booking cancelled', 'success');
      } else {
        showToast('Some slots could not be cancelled', 'error');
      }
      await loadBookings();
    } catch (e) {}
  }

  async function deleteGroup(ids) {
    const label = ids.length > 1 ? `all ${ids.length} slots` : 'this booking';
    const ok = await showConfirm(`Permanently delete ${label}?`, { okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const results = await Promise.all(ids.map((id) => authedFetch(`/api/admin/bookings/${id}`, { method: 'DELETE' })));
      if (results.every((res) => res.ok)) {
        showToast('Booking deleted', 'success');
      } else {
        showToast('Some slots could not be deleted', 'error');
      }
      await loadBookings();
    } catch (e) {}
  }

  el('refreshBtn').addEventListener('click', loadBookings);
  el('filterStatus').addEventListener('change', loadBookings);
  el('filterDate').addEventListener('change', loadBookings);

  async function boot() {
    await loadConfig();
    populateBlockForm();
    showAdmin();
    await loadBookings();
    loadNotifyStatus();
  }

  // --- Notifications (Telegram) ---------------------------------------------
  // Mirrors the confirm/reject/cancel pattern elsewhere in this file: plain
  // authedFetch calls, re-render the panel from whatever the server says is
  // true rather than trusting local state, and surface errors via toast.

  async function loadNotifyStatus() {
    try {
      const res = await authedFetch('/api/admin/telegram/status');
      renderNotifyPanel(await res.json());
    } catch (err) {
      // authedFetch already handles a 401 (bounces to login); anything else
      // just leaves the panel on its "Checking..." state rather than
      // breaking the rest of the admin page over a non-critical feature.
    }
  }

  function renderNotifyPanel(status) {
    const dot = el('notifyDot');
    const text = el('notifyStatusText');
    const sub = el('notifyStatusSub');
    const actions = el('notifyActions');

    if (!status.configured) {
      dot.className = 'notify-dot';
      text.textContent = 'Telegram notifications not set up';
      sub.textContent = 'Ask your developer to add TELEGRAM_BOT_TOKEN to this deployment.';
      actions.innerHTML = '';
      return;
    }

    if (status.connected) {
      dot.className = 'notify-dot on';
      text.textContent = 'Telegram notifications are on';
      sub.textContent = "You'll get a message here whenever a new booking comes in.";
      actions.innerHTML = '<button type="button" class="ghost" id="notifyDisconnectBtn">Disconnect</button>';
      el('notifyDisconnectBtn').addEventListener('click', disconnectNotify);
      return;
    }

    dot.className = 'notify-dot';
    text.textContent = 'Telegram notifications are off';
    sub.textContent = 'Connect once and every new booking pings your phone.';
    actions.innerHTML = '<button type="button" id="notifyConnectBtn">Connect Telegram</button>';
    el('notifyConnectBtn').addEventListener('click', startNotifyLink);
  }

  async function startNotifyLink() {
    try {
      const res = await authedFetch('/api/admin/telegram/start-link', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not start linking', 'error');
        return;
      }
      renderLinkStep(data.code, data.botUsername);
    } catch (err) {
      showToast('Network error. Please try again.', 'error');
    }
  }

  function renderLinkStep(code, botUsername) {
    const actions = el('notifyActions');
    const openBotHtml = botUsername
      ? `<a href="https://t.me/${encodeURIComponent(botUsername)}?start=${encodeURIComponent(code)}" target="_blank" rel="noopener">Open the bot</a> and tap Send,`
      : `Message the bot`;
    actions.innerHTML = `
      <div class="notify-link-step">
        <span>${openBotHtml} or send it this code: <span class="notify-link-code">${escapeHtml(code)}</span></span>
        <button type="button" id="notifyFinishBtn">I've sent it</button>
      </div>
    `;
    el('notifyFinishBtn').addEventListener('click', finishNotifyLink);
  }

  async function finishNotifyLink() {
    const btn = el('notifyFinishBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking\u2026'; }
    try {
      const res = await authedFetch('/api/admin/telegram/finish-link', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || "Couldn't find that message yet -- try again in a moment.", 'error');
        if (btn) { btn.disabled = false; btn.textContent = "I've sent it"; }
        return;
      }
      showToast('Telegram connected', 'success');
      loadNotifyStatus();
    } catch (err) {
      showToast('Network error. Please try again.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = "I've sent it"; }
    }
  }

  async function disconnectNotify() {
    const ok = await showConfirm('Turn off Telegram notifications for this facility?');
    if (!ok) return;
    try {
      await authedFetch('/api/admin/telegram/disconnect', { method: 'POST' });
      showToast('Telegram disconnected', 'success');
      loadNotifyStatus();
    } catch (err) {
      showToast('Network error. Please try again.', 'error');
    }
  }

  (async function init() {
    if (adminPassword) {
      try {
        await boot();
        return;
      } catch (e) {
        // fall through to login
      }
    }
    await loadConfig().catch(() => {});
    showLogin();
  })();
})();
