const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getSupabase } = require('./supabaseClient');

// --- Multi-tenant facility selection ----------------------------------------
// One shared Supabase database/storage bucket serves every facility (Fora,
// J&P, ...). Each deployment picks which facility it serves via this env
// var, and every query below is scoped to it -- one facility's admin can
// never see or touch another facility's rows.
const FACILITY_ID = process.env.FACILITY_SLUG;
if (!FACILITY_ID) {
  throw new Error('FACILITY_SLUG environment variable is required (e.g. "fora" or "jp") -- it selects which facilities row this deployment serves.');
}

// Booking statuses:
//   pending    - customer submitted a payment screenshot, awaiting admin review (slot is held)
//   confirmed  - admin verified the payment; slot is booked
//   rejected   - admin determined the payment was invalid; slot re-opens
//   cancelled  - booking was cancelled after being confirmed; slot re-opens
//   blocked    - admin blocked the slot directly (e.g. maintenance), no payment involved
const ACTIVE_STATUSES = ['pending', 'confirmed', 'blocked'];

// The facilities row rarely changes, so cache it briefly instead of hitting
// the database on every single request.
let facilityCache = null;
let facilityCacheAt = 0;
const FACILITY_CACHE_MS = 30_000;

async function getFacility() {
  const now = Date.now();
  if (facilityCache && now - facilityCacheAt < FACILITY_CACHE_MS) return facilityCache;
  const supabase = getSupabase();
  const { data, error } = await supabase.from('facilities').select('*').eq('id', FACILITY_ID).single();
  if (error || !data) {
    throw new Error(`No facilities row found for FACILITY_SLUG="${FACILITY_ID}". Did you run the seed SQL?`);
  }
  facilityCache = data;
  facilityCacheAt = now;
  return data;
}

function hoursFor(facility) {
  const hours = [];
  for (let h = facility.open_hour; h < facility.close_hour; h++) hours.push(h);
  return hours;
}

function getCourtFrom(facility, courtId) {
  return facility.courts.find((c) => c.id === Number(courtId));
}

async function getConfig() {
  const facility = await getFacility();
  return {
    courts: facility.courts,
    hours: hoursFor(facility),
    openHour: facility.open_hour,
    closeHour: facility.close_hour,
    pricePerHour: facility.price_per_hour,
    currency: facility.currency,
    paymentMethod: facility.payment_method,
    paymentNumber: facility.payment_number,
    paymentName: facility.payment_name,
    paymentNote: facility.payment_note,
    locationMapsUrl: facility.location_maps_url,
    maxSlotsPerBooking: facility.max_slots_per_booking,
  };
}

async function verifyAdminPassword(password) {
  const facility = await getFacility();
  if (!password) return false;
  return bcrypt.compare(String(password), facility.admin_password_hash);
}

// --- Helpers ---------------------------------------------------------------
function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(new Date(str + 'T00:00:00'));
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

// Maps a database row (snake_case) to the shape the rest of the app expects
// (camelCase, matching the old file-based store's booking objects).
function mapBookingOut(row) {
  return {
    id: row.id,
    groupId: row.group_id,
    courtId: row.court_id,
    date: row.date,
    hour: row.hour,
    name: row.name,
    contact: row.contact,
    notes: row.notes || '',
    rejectReason: row.reject_reason || undefined,
    screenshotFilename: row.screenshot_path, // path inside the "screenshots" bucket
    price: row.price,
    status: row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

// --- Public API --------------------------------------------------------------
async function listBookingsForDate(date) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('facility_id', FACILITY_ID)
    .eq('date', date)
    .in('status', ACTIVE_STATUSES);
  if (error) throw error;
  return data.map(mapBookingOut);
}

async function listAllBookings() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('facility_id', FACILITY_ID)
    .order('date', { ascending: false })
    .order('hour', { ascending: true });
  if (error) throw error;
  return data.map(mapBookingOut);
}

// Creates one or more pending bookings from a single customer submission.
// The insert is one multi-row statement, so it's atomic (all slots are
// created, or none are) without needing an app-level transaction. A unique
// index in the database (facility_id, court_id, date, hour) additionally
// guarantees no two active bookings can ever land on the same slot, even
// under concurrent requests -- the pre-check below is just a fast, friendly
// error before hitting that database-level backstop.
async function createBookings(slots, { name, contact, notes, screenshotFilename }) {
  const facility = await getFacility();

  if (!Array.isArray(slots) || slots.length === 0) {
    throw invalid('At least one slot must be selected.');
  }
  if (slots.length > facility.max_slots_per_booking) {
    throw invalid(`You can select at most ${facility.max_slots_per_booking} slots per booking.`);
  }
  if (!name || !String(name).trim()) throw invalid('Name is required.');
  if (!contact || !String(contact).trim()) throw invalid('Phone or email is required.');
  validateContact(String(contact).trim());
  if (!screenshotFilename) throw invalid('A payment screenshot is required.');

  const hours = hoursFor(facility);
  const normalized = slots.map((s) => {
    const courtId = Number(s.courtId);
    const hour = Number(s.hour);
    const date = s.date;
    if (!getCourtFrom(facility, courtId)) throw invalid('Unknown court.');
    if (!isValidDate(date)) throw invalid('Invalid date.');
    if (!hours.includes(hour)) throw invalid('One of the selected hours is outside operating hours.');
    return { courtId, date, hour };
  });

  const seen = new Set();
  for (const s of normalized) {
    const key = `${s.courtId}|${s.date}|${s.hour}`;
    if (seen.has(key)) throw invalid('Duplicate slot selected.');
    seen.add(key);
  }

  const supabase = getSupabase();

  // Friendly pre-check (best-effort; the unique index is the real guarantee).
  const dates = [...new Set(normalized.map((s) => s.date))];
  const { data: existing, error: checkError } = await supabase
    .from('bookings')
    .select('court_id, date, hour')
    .eq('facility_id', FACILITY_ID)
    .in('date', dates)
    .in('status', ACTIVE_STATUSES);
  if (checkError) throw checkError;
  const existingKeys = new Set(existing.map((b) => `${b.court_id}|${b.date}|${b.hour}`));
  for (const s of normalized) {
    if (existingKeys.has(`${s.courtId}|${s.date}|${s.hour}`)) {
      throw taken('One or more of the selected slots is already booked or pending review.');
    }
  }

  const groupId = crypto.randomBytes(8).toString('hex');
  const rows = normalized.map((s) => ({
    facility_id: FACILITY_ID,
    group_id: groupId,
    court_id: s.courtId,
    date: s.date,
    hour: s.hour,
    name: String(name).trim(),
    contact: String(contact).trim(),
    notes: notes ? String(notes).trim() : '',
    screenshot_path: screenshotFilename,
    price: facility.price_per_hour,
    status: 'pending',
  }));

  const { data, error } = await supabase.from('bookings').insert(rows).select();
  if (error) {
    if (error.code === '23505') throw taken('One or more of the selected slots is already booked or pending review.');
    throw error;
  }
  return { groupId, bookings: data.map(mapBookingOut) };
}

// Admin: block off a court/hour (e.g. for maintenance) - no payment needed, takes effect immediately.
async function blockSlot({ courtId, date, hour, notes }) {
  const facility = await getFacility();
  courtId = Number(courtId);
  hour = Number(hour);

  if (!getCourtFrom(facility, courtId)) throw invalid('Unknown court.');
  if (!isValidDate(date)) throw invalid('Invalid date.');
  if (!hoursFor(facility).includes(hour)) throw invalid('That hour is outside operating hours.');

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .insert({
      facility_id: FACILITY_ID,
      group_id: null,
      court_id: courtId,
      date,
      hour,
      name: 'Blocked',
      contact: 'admin',
      notes: notes || 'Blocked by admin',
      screenshot_path: null,
      price: 0,
      status: 'blocked',
      reviewed_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') throw taken('That court/hour is already booked or pending review.');
    throw error;
  }
  return mapBookingOut(data);
}

async function findBooking(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('facility_id', FACILITY_ID)
    .eq('id', Number(id))
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('Booking not found.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return mapBookingOut(data);
}

// Admin: verify the payment screenshot for an entire group -> confirms every
// pending booking in it. Falls back to matching by id for the rare legacy
// case of an ungrouped pending booking (group_id null).
async function confirmGroup(groupId) {
  const supabase = getSupabase();
  let query = supabase.from('bookings').select('id').eq('facility_id', FACILITY_ID).eq('status', 'pending');
  query = /^\d+$/.test(groupId) ? query.or(`group_id.eq.${groupId},and(group_id.is.null,id.eq.${groupId})`) : query.eq('group_id', groupId);
  const { data: matches, error: matchError } = await query;
  if (matchError) throw matchError;
  if (!matches || matches.length === 0) {
    const err = new Error('No pending bookings found for that group.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const ids = matches.map((b) => b.id);
  const { data, error } = await supabase
    .from('bookings')
    .update({ status: 'confirmed', reviewed_at: new Date().toISOString() })
    .in('id', ids)
    .select();
  if (error) throw error;
  return data.map(mapBookingOut);
}

// Admin: payment screenshot was fake/invalid -> rejects every pending
// booking in the group and frees those slots.
async function rejectGroup(groupId, reason) {
  const supabase = getSupabase();
  let query = supabase.from('bookings').select('id').eq('facility_id', FACILITY_ID).eq('status', 'pending');
  query = /^\d+$/.test(groupId) ? query.or(`group_id.eq.${groupId},and(group_id.is.null,id.eq.${groupId})`) : query.eq('group_id', groupId);
  const { data: matches, error: matchError } = await query;
  if (matchError) throw matchError;
  if (!matches || matches.length === 0) {
    const err = new Error('No pending bookings found for that group.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const ids = matches.map((b) => b.id);
  const update = { status: 'rejected', reviewed_at: new Date().toISOString() };
  if (reason) update.reject_reason = String(reason).trim();
  const { data, error } = await supabase.from('bookings').update(update).in('id', ids).select();
  if (error) throw error;
  return data.map(mapBookingOut);
}

// Admin: cancel a previously confirmed booking (e.g. customer request), frees the slot.
async function cancelBooking(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled', reviewed_at: new Date().toISOString() })
    .eq('facility_id', FACILITY_ID)
    .eq('id', Number(id))
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('Booking not found.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return mapBookingOut(data);
}

async function deleteBooking(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .delete()
    .eq('facility_id', FACILITY_ID)
    .eq('id', Number(id))
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('Booking not found.');
    err.code = 'NOT_FOUND';
    throw err;
  }
}

module.exports = {
  FACILITY_ID,
  getConfig,
  verifyAdminPassword,
  listBookingsForDate,
  listAllBookings,
  createBookings,
  blockSlot,
  findBooking,
  confirmGroup,
  rejectGroup,
  cancelBooking,
  deleteBooking,
};
