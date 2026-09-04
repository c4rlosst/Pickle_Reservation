require('dotenv').config();
const express = require('express');
const path = require('path');
const store = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Admin auth middleware -------------------------------------------------
function requireAdmin(req, res, next) {
  const supplied = req.get('x-admin-password') || req.body?.password;
  if (supplied && supplied === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// --- Public config -----------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    courts: store.COURTS,
    hours: store.HOURS,
    openHour: store.OPEN_HOUR,
    closeHour: store.CLOSE_HOUR,
  });
});

// --- Public bookings ---------------------------------------------------------
app.get('/api/bookings', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });
  const bookings = store.listBookingsForDate(date).map((b) => ({
    id: b.id,
    courtId: b.courtId,
    date: b.date,
    hour: b.hour,
    status: b.status,
    // Don't leak customer contact info to the public booking grid
    name: b.status === 'blocked' || b.contact === 'admin' ? 'Unavailable' : initials(b.name),
  }));
  res.json({ bookings });
});

function initials(name) {
  if (!name) return 'Booked';
  return name
    .trim()
    .split(/\s+/)
    .map((p) => p[0].toUpperCase())
    .slice(0, 2)
    .join('.') + '.';
}

app.post('/api/bookings', (req, res) => {
  const { courtId, date, hour, name, contact, notes } = req.body || {};
  try {
    const booking = store.createBooking({ courtId, date, hour, name, contact, notes });
    res.status(201).json({ booking });
  } catch (err) {
    const status = err.code === 'TAKEN' ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// --- Admin routes --------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Incorrect password' });
});

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  res.json({ bookings: store.listAllBookings() });
});

app.post('/api/admin/block', requireAdmin, (req, res) => {
  const { courtId, date, hour, notes } = req.body || {};
  try {
    const booking = store.blockSlot({ courtId, date, hour, notes });
    res.status(201).json({ booking });
  } catch (err) {
    const status = err.code === 'TAKEN' ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

app.post('/api/admin/bookings/:id/cancel', requireAdmin, (req, res) => {
  try {
    const booking = store.cancelBooking(req.params.id);
    res.json({ booking });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/admin/bookings/:id', requireAdmin, (req, res) => {
  try {
    store.deleteBooking(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FORA Pickleball booking site running at http://localhost:${PORT}`);
});
