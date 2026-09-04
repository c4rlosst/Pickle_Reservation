const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const PRICE_PER_HOUR = 150; // in PHP
const CURRENCY = 'PHP';

// Structured payment details, shown on the confirm panel with a copy button
// next to the number. Edit these to match your actual GCash (or other) account.
const PAYMENT_METHOD = 'GCash';
const PAYMENT_NUMBER = '0917-000-0000';
const PAYMENT_NAME = 'Juan Dela Cruz';
const PAYMENT_NOTE = 'Upload a screenshot below once you\'ve paid. Slots are held as Pending until we confirm it.';

// Max slots a customer can select/submit in a single booking.
const MAX_SLOTS_PER_BOOKING = 12;

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

function invalid(msg) {
  const err = new Error(msg);
  err.code = 'INVALID';
  return err;
}

function taken(msg) {
  const err = new Error(msg);
  err.code = 'TAKEN';
  return err;
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

// Creates one or more pending bookings from a single customer submission
// (one payment screenshot can cover multiple court/hour slots, e.g. two
// courts at once or several hours back-to-back). Either all slots are
// created, or none are (validated together first).
//
// slots: [{ courtId, date, hour }, ...]
// Throws an Error with a `code` property on failure:
//   'INVALID' - bad input
//   'TAKEN'   - one or more slots already held/booked
// Accepts either an email address, or a PH mobile number (11 digits,
// starting with 09 -- e.g. 0917 123 4567; spaces/dashes are ignored).
function validateContact(value) {
  if (value.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw invalid('Please enter a valid email address.');
    }
    return;
  }
  const digits = value.replace(/\D/g, '');
  if (!/^09\d{9}$/.test(digits)) {
    throw invalid('Please enter a valid 11-digit PH mobile number (e.g. 0917 123 4567), or an email address.');
  }
}

function createBookings(slots, { name, contact, notes, screenshotFilename }) {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw invalid('At least one slot must be selected.');
  }
  if (slots.length > MAX_SLOTS_PER_BOOKING) {
    throw invalid(`You can select at most ${MAX_SLOTS_PER_BOOKING} slots per booking.`);
  }
  if (!name || !String(name).trim()) throw invalid('Name is required.');
  if (!contact || !String(contact).trim()) throw invalid('Phone or email is required.');
  validateContact(String(contact).trim());
  if (!screenshotFilename) throw invalid('A payment screenshot is required.');

  const normalized = slots.map((s) => {
    const courtId = Number(s.courtId);
    const hour = Number(s.hour);
    const date = s.date;
    if (!getCourt(courtId)) throw invalid('Unknown court.');
    if (!isValidDate(date)) throw invalid('Invalid date.');
    if (!HOURS.includes(hour)) throw invalid('One of the selected hours is outside operating hours.');
    return { courtId, date, hour };
  });

  // De-duplicate identical slots within the same submission.
  const seen = new Set();
  for (const s of normalized) {
    const key = `${s.courtId}|${s.date}|${s.hour}`;
    if (seen.has(key)) throw invalid('Duplicate slot selected.');
    seen.add(key);
  }

  const db = readDb();

  for (const s of normalized) {
    const clash = db.bookings.find(
      (b) => b.courtId === s.courtId && b.date === s.date && b.hour === s.hour && ACTIVE_STATUSES.includes(b.status)
    );
    if (clash) {
      throw taken('One or more of the selected slots is already booked or pending review.');
    }
  }

  const groupId = crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const created = normalized.map((s) => {
    const booking = {
      id: db.nextId++,
      groupId,
      courtId: s.courtId,
      date: s.date,
      hour: s.hour,
      name: String(name).trim(),
      contact: String(contact).trim(),
      notes: notes ? String(notes).trim() : '',
      screenshotFilename,
      price: PRICE_PER_HOUR,
      status: 'pending',
      createdAt: now,
      reviewedAt: null,
    };
    db.bookings.push(booking);
    return booking;
  });

  writeDb(db);
  return { groupId, bookings: created };
}

// Admin: block off a court/hour (e.g. for maintenance) - no payment needed, takes effect immediately.
function blockSlot({ courtId, date, hour, notes }) {
  courtId = Number(courtId);
  hour = Number(hour);

  if (!getCourt(courtId)) throw invalid('Unknown court.');
  if (!isValidDate(date)) throw invalid('Invalid date.');
  if (!HOURS.includes(hour)) throw invalid('That hour is outside operating hours.');

  const db = readDb();
  const clash = db.bookings.find(
    (b) => b.courtId === courtId && b.date === date && b.hour === hour && ACTIVE_STATUSES.includes(b.status)
  );
  if (clash) throw taken('That court/hour is already booked or pending review.');

  const booking = {
    id: db.nextId++,
    groupId: null,
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

// Admin: verify the payment screenshot for an entire group (one submission,
// possibly several court/hour slots) -> confirms every pending booking in it.
function confirmGroup(groupId) {
  const db = readDb();
  const bookings = db.bookings.filter((b) => (b.groupId || String(b.id)) === groupId && b.status === 'pending');
  if (bookings.length === 0) {
    const err = new Error('No pending bookings found for that group.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const now = new Date().toISOString();
  bookings.forEach((b) => {
    b.status = 'confirmed';
    b.reviewedAt = now;
  });
  writeDb(db);
  return bookings;
}

// Admin: payment screenshot was fake/invalid -> rejects every pending
// booking in the group and frees those slots.
function rejectGroup(groupId, reason) {
  const db = readDb();
  const bookings = db.bookings.filter((b) => (b.groupId || String(b.id)) === groupId && b.status === 'pending');
  if (bookings.length === 0) {
    const err = new Error('No pending bookings found for that group.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const now = new Date().toISOString();
  bookings.forEach((b) => {
    b.status = 'rejected';
    b.reviewedAt = now;
    if (reason) b.rejectReason = String(reason).trim();
  });
  writeDb(db);
  return bookings;
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
  PAYMENT_METHOD,
  PAYMENT_NUMBER,
  PAYMENT_NAME,
  PAYMENT_NOTE,
  MAX_SLOTS_PER_BOOKING,
  listBookingsForDate,
  listAllBookings,
  createBookings,
  blockSlot,
  findBooking,
  confirmGroup,
  rejectGroup,
  cancelBooking,
  deleteBooking,
  getCourt,
};
