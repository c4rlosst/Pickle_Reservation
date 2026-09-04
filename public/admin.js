(function () {
  let CONFIG = null;
  let adminPassword = sessionStorage.getItem('fora_admin_pw') || '';

  const el = (id) => document.getElementById(id);
  const loginBox = el('loginBox');
  const adminMain = el('adminMain');
  const toast = el('toast');

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
  }

  function showAdmin() {
    loginBox.classList.add('hidden');
    adminMain.classList.remove('hidden');
  }

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
  }

  function populateBlockForm() {
    const courtSel = el('blockCourt');
    courtSel.innerHTML = CONFIG.courts.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
    const hourSel = el('blockHour');
    hourSel.innerHTML = CONFIG.hours.map((h) => `<option value="${h}">${fmtHour(h)}</option>`).join('');
    const today = new Date();
    el('blockDate').value = today.toISOString().slice(0, 10);
  }

  el('blockBtn').addEventListener('click', async () => {
    const payload = {
      courtId: Number(el('blockCourt').value),
      date: el('blockDate').value,
      hour: Number(el('blockHour').value),
      notes: el('blockNotes').value,
    };
    try {
      const res = await authedFetch('/api/admin/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not block slot', 'error');
        return;
      }
      showToast('Slot blocked', 'success');
      el('blockNotes').value = '';
      await loadBookings();
    } catch (e) {
      /* handled by authedFetch */
    }
  });

  async function loadBookings() {
    const res = await authedFetch('/api/admin/bookings');
    const data = await res.json();
    let bookings = data.bookings || [];

    const statusFilter = el('filterStatus').value;
    const dateFilter = el('filterDate').value.trim();

    if (statusFilter !== 'all') {
      bookings = bookings.filter((b) => b.status === statusFilter);
    }
    if (dateFilter) {
      bookings = bookings.filter((b) => b.date === dateFilter);
    }

    const courtName = (id) => {
      const c = CONFIG.courts.find((c) => c.id === id);
      return c ? c.name : `Court ${id}`;
    };

    const tbody = el('bookingTbody');
    tbody.innerHTML = '';
    if (bookings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px;">No bookings found.</td></tr>';
      return;
    }

    bookings.forEach((b) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${b.date}</td>
        <td>${fmtHour(b.hour)}</td>
        <td>${courtName(b.courtId)}</td>
        <td>${escapeHtml(b.name)}</td>
        <td>${escapeHtml(b.contact)}</td>
        <td>${escapeHtml(b.notes || '')}</td>
        <td><span class="status-badge status-${b.status}">${b.status}</span></td>
        <td class="row-actions"></td>
      `;
      const actionsTd = tr.querySelector('.row-actions');
      if (b.status !== 'cancelled') {
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => cancelBooking(b.id));
        actionsTd.appendChild(cancelBtn);
      }
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteBooking(b.id));
      actionsTd.appendChild(deleteBtn);

      tbody.appendChild(tr);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function cancelBooking(id) {
    try {
      const res = await authedFetch(`/api/admin/bookings/${id}/cancel`, { method: 'POST' });
      if (res.ok) {
        showToast('Booking cancelled', 'success');
        await loadBookings();
      }
    } catch (e) {}
  }

  async function deleteBooking(id) {
    if (!confirm('Permanently delete this booking?')) return;
    try {
      const res = await authedFetch(`/api/admin/bookings/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Booking deleted', 'success');
        await loadBookings();
      }
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
