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
  return db.bookings.filter((b) => b.date === date && b.status !== 'cancelled');
}

function listAllBookings() {
  const db = readDb();
  return db.bookings.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.hour - b.hour;
  });
}

// Creates a booking. Throws an Error with a `code` property on failure:
//   'INVALID' - bad input
//   'TAKEN'   - slot already booked
function createBooking({ courtId, date, hour, name, contact, notes }) {
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

  const db = readDb();

  const clash = db.bookings.find(
    (b) => b.courtId === courtId && b.date === date && b.hour === hour && b.status !== 'cancelled'
  );
  if (clash) {
    const err = new Error('That court/hour is already booked.');
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
    status: 'confirmed', // 'confirmed' | 'cancelled' | 'blocked'
    createdAt: new Date().toISOString(),
  };
  db.bookings.push(booking);
  writeDb(db);
  return booking;
}

// Admin: block off a court/hour (e.g. for maintenance) without a customer name
function blockSlot({ courtId, date, hour, notes }) {
  return createBooking({
    courtId,
    date,
    hour,
    name: 'Blocked',
    contact: 'admin',
    notes: notes || 'Blocked by admin',
  });
}

function cancelBooking(id) {
  const db = readDb();
  const booking = db.bookings.find((b) => b.id === Number(id));
  if (!booking) {
    const err = new Error('Booking not found.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  booking.status = 'cancelled';
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
  listBookingsForDate,
  listAllBookings,
  createBooking,
  blockSlot,
  cancelBooking,
  deleteBooking,
  getCourt,
};
