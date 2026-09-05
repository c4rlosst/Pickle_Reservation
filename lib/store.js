const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getSupabase } = require('./supabaseClient');
const { sendTelegramMessage, findChatIdForCode, getBotUsername, getBotToken } = require('./telegram');

// --- Multi-tenant facility selection ----------------------------------------
// One shared Supabase database/storage bucket serves every facility (Fora,
// J&P, ...). Each deployment picks which facility it serves via this env
// var, and every query below is scoped to it -- one facility's admin can
// never see or touch another facility's rows.
const FACILITY_ID = process.env.FACILITY_SLUG;
if (!FACILITY_ID) {
  throw new Error('FACILITY_SLUG environment variable is required (e.g. "fora" or "jp") -- it selects which facilities row this deployment serves.');
}

// Flat platform fee, in pesos, added ONCE per booking transaction (i.e. once
// per customer submission/groupId) on top of the court total -- not once
// per slot. A customer booking 3 courts x 2 hours in one go still only pays
// this fee a single time, since it's one payment/one screenshot/one
// transaction, however many slots it covers. This is the operator's (your)
// cut, separate from what each facility charges per hour, and is the same
// across every facility this codebase serves.
const PLATFORM_FEE = Number(process.env.PLATFORM_FEE_PHP || 10);

// How long a slot stays reserved for a customer who has opened the payment
// screen but not yet uploaded their screenshot. Long enough to actually
// switch to a GCash app, send money, and come back; short enough that a
// customer who changes their mind doesn't lock the slot for everyone else
// for very long.
const HOLD_MINUTES = Number(process.env.HOLD_MINUTES || 5);

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
    platformFee: PLATFORM_FEE,
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
// NOTE: deliberately does NOT call expireStaleHolds() -- this is the
// customer-facing endpoint hit on every single calendar date click, and
// adding a second sequential database round-trip here measurably slows
// down clicking around the calendar for no real benefit: a hold that just
// expired but hasn't been swept yet still correctly shows as unavailable
// for the minute or two before cleanup, which is harmless. Cleanup instead
// happens where it actually matters for correctness -- right before
// creating a new hold (so a stale hold can never wrongly block a slot) and
// in the admin list.
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

// Deletes holds that expired without ever being finalized (no screenshot
// was ever attached, so there's no customer data worth keeping) -- this is
// what actually frees the slot back up: their status stays 'pending' the
// whole time they're held, so removing the row is what clears them out of
// every availability check and the unique-index reservation.
async function expireStaleHolds() {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('bookings')
    .delete()
    .eq('facility_id', FACILITY_ID)
    .not('hold_expires_at', 'is', null)
    .lt('hold_expires_at', new Date().toISOString());
  if (error) throw error;
}

async function listAllBookings() {
  await expireStaleHolds();
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('facility_id', FACILITY_ID)
    .order('date', { ascending: false })
    .order('hour', { ascending: true });
  if (error) throw error;
  // Hide holds that are still in progress (the customer has reserved the
  // slot but hasn't submitted a payment screenshot yet) -- there's nothing
  // for an admin to act on until the customer finishes or the hold expires
  // and disappears on its own.
  return data.filter((row) => !row.hold_expires_at).map(mapBookingOut);
}

// Shared slot validation used by createHold below.
function normalizeSlots(facility, slots) {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw invalid('At least one slot must be selected.');
  }
  if (slots.length > facility.max_slots_per_booking) {
    throw invalid(`You can select at most ${facility.max_slots_per_booking} slots per booking.`);
  }
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
  return normalized;
}

// Step 1 of booking: reserve the selected slot(s) the moment the customer
// opens the payment screen, BEFORE they've actually paid or uploaded
// anything. This closes the real-world gap where a customer sends money via
// GCash, and only then comes back to submit -- during which someone else
// could otherwise grab the same slot first. The hold expires on its own
// (see expireStaleHolds) if the customer never finishes.
//
// The insert is one multi-row statement, so it's atomic (all slots are
// held, or none are) without needing an app-level transaction. A unique
// index in the database (facility_id, court_id, date, hour) additionally
// guarantees no two active bookings/holds can ever land on the same slot,
// even under concurrent requests -- the pre-check below is just a fast,
// friendly error before hitting that database-level backstop.
async function createHold(slots) {
  await expireStaleHolds();
  const facility = await getFacility();
  const normalized = normalizeSlots(facility, slots);

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
  const holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString();
  const rows = normalized.map((s) => ({
    facility_id: FACILITY_ID,
    group_id: groupId,
    court_id: s.courtId,
    date: s.date,
    hour: s.hour,
    name: '',
    contact: '',
    notes: '',
    screenshot_path: null,
    price: facility.price_per_hour,
    status: 'pending',
    hold_expires_at: holdExpiresAt,
  }));

  const { data, error } = await supabase.from('bookings').insert(rows).select();
  if (error) {
    if (error.code === '23505') throw taken('One or more of the selected slots was just taken by someone else. Please choose a different time.');
    throw error;
  }
  return { groupId, holdExpiresAt, holdSeconds: HOLD_MINUTES * 60, bookings: data.map(mapBookingOut) };
}

// Lets a customer free up their own hold early (they closed the payment
// screen or picked different slots) instead of making everyone else wait
// out the full countdown.
async function releaseHold(groupId) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('bookings')
    .delete()
    .eq('facility_id', FACILITY_ID)
    .eq('group_id', groupId)
    .not('hold_expires_at', 'is', null);
  if (error) throw error;
}

// Step 2 of booking: the customer has paid and submitted their name,
// contact, and payment screenshot -- attach that to their existing held
// slot(s) and turn the hold into a normal "pending, awaiting admin review"
// booking (by clearing hold_expires_at). If the hold already expired (or
// never existed, e.g. a stale/replayed groupId), there's nothing to attach
// to and the customer needs to select their slot(s) again.
async function finalizeHold(groupId, { name, contact, notes, screenshotFilename }) {
  await expireStaleHolds();

  if (!name || !String(name).trim()) throw invalid('Name is required.');
  if (!contact || !String(contact).trim()) throw invalid('Phone or email is required.');
  validateContact(String(contact).trim());
  if (!screenshotFilename) throw invalid('A payment screenshot is required.');

  const supabase = getSupabase();
  const { data: held, error: heldError } = await supabase
    .from('bookings')
    .select('id')
    .eq('facility_id', FACILITY_ID)
    .eq('group_id', groupId)
    .not('hold_expires_at', 'is', null);
  if (heldError) throw heldError;
  if (!held || held.length === 0) {
    const err = new Error('Your reserved time expired. Please select your slot(s) again.');
    err.code = 'HOLD_EXPIRED';
    throw err;
  }

  const ids = held.map((r) => r.id);
  const { data, error } = await supabase
    .from('bookings')
    .update({
      name: String(name).trim(),
      contact: String(contact).trim(),
      notes: notes ? String(notes).trim() : '',
      screenshot_path: screenshotFilename,
      hold_expires_at: null,
    })
    .in('id', ids)
    .select();
  if (error) throw error;

  const bookings = data.map(mapBookingOut);
  // Best-effort only -- a Telegram outage or a facility that never linked
  // notifications must never fail (or even delay) the booking itself. The
  // booking has already been written to the database at this point; this
  // is purely a courtesy heads-up on top of it.
  notifyNewBooking(bookings).catch((err) => console.error('notifyNewBooking error:', err));

  return { groupId, bookings };
}

// Sends the admin's linked Telegram chat a heads-up that a payment
// screenshot just came in for review. Fired once per booking group (all of
// a customer's slots in one message), not once per slot.
async function notifyNewBooking(bookings) {
  if (!bookings.length) return;
  const facility = await getFacility();
  if (!facility.telegram_chat_id) return;

  const first = bookings[0];
  const total = bookings.reduce((sum, b) => sum + Number(b.price || 0), 0) + PLATFORM_FEE;
  const lines = bookings
    .slice()
    .sort((a, b) => a.hour - b.hour || a.courtId - b.courtId)
    .map((b) => {
      const court = getCourtFrom(facility, b.courtId);
      const courtLabel = court ? court.name : `Court ${b.courtId}`;
      return `• ${courtLabel}, ${fmtHour(b.hour)}–${fmtHour(b.hour + 1)}`;
    });

  const parts = [
    `📥 <b>New booking pending review</b>`,
    `${escapeHtmlForTelegram(first.name)} — ${escapeHtmlForTelegram(first.contact)}`,
    first.date,
    lines.join('\n'),
    `Total: ₱${total}`,
  ];
  if (first.notes) parts.push(`Notes: ${escapeHtmlForTelegram(first.notes)}`);
  const text = parts.join('\n');

  await sendTelegramMessage(facility.telegram_chat_id, text);
}

function escapeHtmlForTelegram(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// "6 AM" / "1 PM" style label for a single hour boundary, e.g. in the
// Telegram notification's time range.
function fmtHour(h) {
  const hour = ((h % 24) + 24) % 24;
  const label = hour % 12 === 0 ? 12 : hour % 12;
  const period = hour >= 12 ? 'PM' : 'AM';
  return `${label} ${period}`;
}

// --- Telegram notification linking ------------------------------------------
// One shared bot (TELEGRAM_BOT_TOKEN) serves every facility; a facility's
// own admin links their personal chat to it once from the admin panel, and
// that chat_id is all that's stored -- linking never touches the bot token
// itself, which lives only in this deployment's environment variables.

function getTelegramConfigured() {
  return Boolean(getBotToken());
}

async function getTelegramStatus() {
  const facility = await getFacility();
  return {
    configured: getTelegramConfigured(),
    connected: Boolean(facility.telegram_chat_id),
    botUsername: getBotUsername(),
  };
}

// Generates a short one-time code for the admin to send the bot, valid for
// 10 minutes, and stores it against this facility so finishTelegramLink()
// knows which facility a matching Telegram message belongs to.
async function startTelegramLink() {
  if (!getTelegramConfigured()) {
    throw new Error('Telegram notifications are not configured for this deployment (missing TELEGRAM_BOT_TOKEN).');
  }
  const code = crypto.randomBytes(4).toString('hex'); // e.g. "a1b2c3d4"
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const supabase = getSupabase();
  const { error } = await supabase
    .from('facilities')
    .update({ telegram_link_code: code, telegram_link_code_expires_at: expiresAt })
    .eq('id', FACILITY_ID);
  if (error) throw error;
  facilityCache = null; // force a fresh read next time -- the code just changed
  return { code, botUsername: getBotUsername() };
}

// Looks for a Telegram message containing this facility's pending code
// (sent by the admin to the bot after startTelegramLink()) and, if found,
// saves that chat as the facility's notification target.
async function finishTelegramLink() {
  const facility = await getFacility();
  const code = facility.telegram_link_code;
  if (!code) throw invalid('No linking code is pending. Click "Connect Telegram" again first.');
  if (!facility.telegram_link_code_expires_at || new Date(facility.telegram_link_code_expires_at) < new Date()) {
    throw invalid('That code expired. Click "Connect Telegram" again to get a new one.');
  }

  const match = await findChatIdForCode(code);
  if (!match) {
    const err = new Error('Haven\'t seen that code yet -- make sure you sent it to the bot, then try again.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('facilities')
    .update({ telegram_chat_id: match.chatId, telegram_link_code: null, telegram_link_code_expires_at: null })
    .eq('id', FACILITY_ID);
  if (error) throw error;
  facilityCache = null;

  await sendTelegramMessage(
    match.chatId,
    `✅ Connected! You'll get a message here whenever a new booking comes in for ${escapeHtmlForTelegram(facility.name)}.`
  );

  return { name: match.name };
}

async function disconnectTelegram() {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('facilities')
    .update({ telegram_chat_id: null, telegram_link_code: null, telegram_link_code_expires_at: null })
    .eq('id', FACILITY_ID);
  if (error) throw error;
  facilityCache = null;
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
  createHold,
  releaseHold,
  finalizeHold,
  blockSlot,
  findBooking,
  confirmGroup,
  rejectGroup,
  cancelBooking,
  deleteBooking,
  getTelegramStatus,
  startTelegramLink,
  finishTelegramLink,
  disconnectTelegram,
};
