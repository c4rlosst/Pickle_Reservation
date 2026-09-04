const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

// --- Configuration -------------------------------------------------------
const COURTS = [
  { id: 1, name: 'Court 1' },
  { id: 2, name: 'Court 2' },
  { id: 3, name: 'Court 3' },
];

// Operating hours: bookable start hours, 24h format.
// 6 => 6:00-7:00 slot ... 21 => 21:00-22:00 slot (last slot of the day)
const OPEN_HOUR = 6;
const CLOSE_HOUR = 22; // courts close at 22:00, so last start hour is CLOSE_HOUR - 1
const HOURS = [];
for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) HOURS.push(h);

// Price shown to customers and included in the payment instructions.
// Edit these two to match your actual rate and payment details.
const PRICE_PER_HOUR = 500; // in PHP
const CURRENCY = 'PHP';
const PAYMENT_INSTRUCTIONS =
  'Send your payment via GCash to 0917-000-0000 (Juan Dela Cruz), ' +
  'then upload a screenshot of the confirmation below. ' +
  'Your slot will be held as "Pending" until the admin verifies your payment.';

// Booking statuses:
//   pending    - customer submitted a payment screenshot, awaiting admin review (slot is held)
//   confirmed  - admin verified the payment; slot is booked
//   rejected   - admin determined the payment was invalid; slot re-opens
//   cancelled  - booking was cancelled after being confirmed; slot re-opens
//   blocked    - admin blocked the slot directly (e.g. maintenance), no payment involved

const ACTIVE_STATUSES = ['pending', 'confirmed', 'blocked'];

// --- Storage ---------------------------------------------------------------
function ensureDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify({ bookings: [], nextId: 1 }, null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return { bookings: [], nextId: 1 };
  }
}

function writeDb(db) {
  // Write to a temp file then rename, to avoid partial writes if two
  // requests land at nearly the same time.
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// --- Helpers ---------------------------------------------------------------
function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(new Date(str + 'T00:00:00'));
}

function getCourt(courtId) {
  return COURTS.find((c) => c.id === Number(courtId));
}

// --- Public API --------------------------------------------------------------
function listBookingsForDate(date) {
  const db = readDb();
  return db.bookings.filter((b) => b.date === date && ACTIVE_STATUSES.includes(b.status));
}

function listAllBookings() {
  const db = readDb();
  return db.bookings.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1; // newest date first
    return a.hour - b.hour;
  });
}

// Creates a pending booking (customer submitted payment proof, awaiting admin review).
// Throws an Error with a `code` property on failure:
//   'INVALID' - bad input
//   'TAKEN'   - slot already held/booked
function createBooking({ courtId, date, hour, name, contact, notes, screenshotFilename }) {
  courtId = Number(courtId);
  hour = Number(hour);

  if (!getCourt(courtId)) {
    const err = new Error('Unknown court.');
    err.code = 'INVALID';
    throw err;
  }
  if (!isValidDate(date)) {
    const err = new Error('Invalid date.');
    err.code = 'INVALID';
    throw err;
  }
  if (!HOURS.includes(hour)) {
    const err = new Error('That hour is outside operating hours.');
    err.code = 'INVALID';
    throw err;
  }
  if (!name || !String(name).trim()) {
    const err = new Error('Name is required.');
    err.code = 'INVALID';
    throw err;
  }
  if (!contact || !String(contact).trim()) {
    const err = new Error('Phone or email is required.');
    err.code = 'INVALID';
    throw err;
  }
  if (!screenshotFilename) {
    const err = new Error('A payment screenshot is required.');
    err.code = 'INVALID';
    throw err;
  }

  const db = readDb();

  const clash = db.bookings.find(
    (b) => b.courtId === courtId && b.date === date && b.hour === hour && ACTIVE_STATUSES.includes(b.status)
  );
  if (clash) {
    const err = new Error('That court/hour is already booked or pending review.');
    err.code = 'TAKEN';
    throw err;
  }

  const booking = {
    id: db.nextId++,
    courtId,
    date,
    hour,
    name: String(name).trim(),
    contact: String(contact).trim(),
    notes: notes ? String(notes).trim() : '',
    screenshotFilename,
    price: PRICE_PER_HOUR,
    status: 'pending',
    createdAt: new Date().toISOString(),
    reviewedAt: null,
  };
  db.bookings.push(booking);
  writeDb(db);
  return booking;
}

// Admin: block off a court/hour (e.g. for maintenance) - no payment needed, takes effect immediately.
function blockSlot({ courtId, date, hour, notes }) {
  courtId = Number(courtId);
  hour = Number(hour);

  if (!getCourt(courtId)) {
    const err = new Error('Unknown court.');
    err.code = 'INVALID';
    throw err;
  }
  if (!isValidDate(date)) {
    const err = new Error('Invalid date.');
    err.code = 'INVALID';
    throw err;
  }
  if (!HOURS.includes(hour)) {
    const err = new Error('That hour is outside operating hours.');
    err.code = 'INVALID';
    throw err;
  }

  const db = readDb();
  const clash = db.bookings.find(
    (b) => b.courtId === courtId && b.date === date && b.hour === hour && ACTIVE_STATUSES.includes(b.status)
  );
  if (clash) {
    const err = new Error('That court/hour is already booked or pending review.');
    err.code = 'TAKEN';
    throw err;
  }

  const booking = {
    id: db.nextId++,
    courtId,
    date,
    hour,
    name: 'Blocked',
    contact: 'admin',
    notes: notes || 'Blocked by admin',
    screenshotFilename: null,
    price: 0,
    status: 'blocked',
    createdAt: new Date().toISOString(),
    reviewedAt: new Date().toISOString(),
  };
  db.bookings.push(booking);
  writeDb(db);
  return booking;
}

function findBooking(id) {
  const db = readDb();
  const booking = db.bookings.find((b) => b.id === Number(id));
  if (!booking) {
    const err = new Error('Booking not found.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return booking;
}

// Admin: verify the payment screenshot was real -> confirms the booking.
function confirmBooking(id) {
  const db = readDb();
  const booking = db.bookings.find((b) => b.id === Number(id));
  if (!booking) {
    const err = new Error('Booking not found.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (booking.status !== 'pending') {
    const err = new Error('Only pending bookings can be confirmed.');
    err.code = 'INVALID';
    throw err;
  }
  booking.status = 'confirmed';
  booking.reviewedAt = new Date().toISOString();
  writeDb(db);
  return booking;
}

// Admin: payment screenshot was fake/invalid -> rejects the booking and frees the slot.
function rejectBooking(id, reason) {
  const db = readDb();
  const booking = db.bookings.find((b) => b.id === Number(id));
  if (!booking) {
    const err = new Error('Booking not found.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (booking.status !== 'pending') {
    const err = new Error('Only pending bookings can be rejected.');
    err.code = 'INVALID';
    throw err;
  }
  booking.status = 'rejected';
  booking.reviewedAt = new Date().toISOString();
  if (reason) booking.rejectReason = String(reason).trim();
  writeDb(db);
  return booking;
}

// Admin: cancel a previously confirmed booking (e.g. customer request), frees the slot.
function cancelBooking(id) {
  const db = readDb();
  const booking = db.bookings.find((b) => b.id === Number(id));
  if (!booking) {
    const err = new Error('Booking not found.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  booking.status = 'cancelled';
  booking.reviewedAt = new Date().toISOString();
  writeDb(db);
  return booking;
}

function deleteBooking(id) {
  const db = readDb();
  const before = db.bookings.length;
  db.bookings = db.bookings.filter((b) => b.id !== Number(id));
  if (db.bookings.length === before) {
    const err = new Error('Booking not found.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  writeDb(db);
}

module.exports = {
  COURTS,
  HOURS,
  OPEN_HOUR,
  CLOSE_HOUR,
  PRICE_PER_HOUR,
  CURRENCY,
  PAYMENT_INSTRUCTIONS,
  listBookingsForDate,
  listAllBookings,
  createBooking,
  blockSlot,
  findBooking,
  confirmBooking,
  rejectBooking,
  cancelBooking,
  deleteBooking,
  getCourt,
};
