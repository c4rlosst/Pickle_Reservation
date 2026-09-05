require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const store = require('./lib/store');
const { getSupabase } = require('./lib/supabaseClient');

const app = express();
const PORT = process.env.PORT || 3000;
const SCREENSHOT_BUCKET = 'screenshots';

// --- Screenshot upload handling ---------------------------------------------
// Screenshots are stored in a private Supabase Storage bucket (shared across
// facilities, namespaced by facility id) rather than local disk, since the
// deployment target (Vercel) has a read-only filesystem outside /tmp.
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only image files (jpg, png, webp, gif, heic) are allowed.'));
  },
});

function randomFilename(file) {
  const ext = path.extname(file.originalname || '').slice(0, 10) || '.jpg';
  return crypto.randomBytes(20).toString('hex') + ext;
}

async function saveUploadedFile(file) {
  const supabase = getSupabase();
  const objectPath = `${store.FACILITY_ID}/${randomFilename(file)}`;
  const { error } = await supabase.storage.from(SCREENSHOT_BUCKET).upload(objectPath, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  });
  if (error) throw error;
  return objectPath;
}

async function deleteUploadedFile(objectPath) {
  if (!objectPath) return;
  try {
    const supabase = getSupabase();
    await supabase.storage.from(SCREENSHOT_BUCKET).remove([objectPath]);
  } catch (e) {
    // Best-effort cleanup only -- don't fail the request over it.
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Admin auth middleware -------------------------------------------------
// Each deployment serves one facility (FACILITY_SLUG), and that facility's
// admin password (bcrypt-hashed in the database) is what's checked here --
// there's no shared/global admin password across facilities.
async function requireAdmin(req, res, next) {
  try {
    const supplied = req.get('x-admin-password') || req.body?.password || req.query?.pw;
    if (supplied && (await store.verifyAdminPassword(supplied))) return next();
    res.status(401).json({ error: 'Unauthorized' });
  } catch (err) {
    console.error('requireAdmin error:', err);
    res.status(500).json({ error: 'Could not verify admin password.' });
  }
}

// --- Public config -----------------------------------------------------------
app.get('/api/config', async (req, res) => {
  try {
    res.json(await store.getConfig());
  } catch (err) {
    console.error('GET /api/config error:', err);
    res.status(500).json({ error: 'Could not load config.' });
  }
});

// --- Public bookings ---------------------------------------------------------
app.get('/api/bookings', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });
  try {
    const bookings = (await store.listBookingsForDate(date)).map((b) => ({
      id: b.id,
      courtId: b.courtId,
      date: b.date,
      hour: b.hour,
      status: b.status, // pending | confirmed | blocked
      // Don't leak customer contact info (or screenshots) to the public booking grid
      name: b.status === 'blocked' ? null : b.name,
    }));
    res.json({ bookings });
  } catch (err) {
    console.error('GET /api/bookings error:', err);
    res.status(500).json({ error: 'Could not load bookings.' });
  }
});

// Step 1: reserve the slot(s) the moment the customer opens the payment
// screen -- before they've paid or uploaded anything. Holds the slot under
// a short countdown (see lib/store.js) so someone else can't grab it out
// from under a customer who's mid-payment.
app.post('/api/bookings/hold', async (req, res) => {
  try {
    const { groupId, holdExpiresAt, holdSeconds, bookings } = await store.createHold(req.body?.slots);
    res.status(201).json({
      groupId,
      holdExpiresAt,
      holdSeconds,
      bookings: bookings.map((b) => ({ id: b.id, courtId: b.courtId, date: b.date, hour: b.hour, status: b.status, price: b.price })),
    });
  } catch (err) {
    const status = err.code === 'TAKEN' ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// Lets the client free its own hold early (customer backed out or changed
// their slot selection) instead of making everyone else wait out the timer.
app.delete('/api/bookings/hold/:groupId', async (req, res) => {
  try {
    await store.releaseHold(req.params.groupId);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/bookings/hold error:', err);
    res.status(500).json({ error: 'Could not release hold.' });
  }
});

// Step 2: the customer has paid and is submitting their name, contact, and
// payment screenshot -- attaches it to their existing held slot(s) from
// step 1. Requires the groupId returned by /api/bookings/hold; if that hold
// already expired, the customer needs to select their slot(s) again.
app.post('/api/bookings', (req, res) => {
  upload.single('screenshot')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message, code: 'INVALID' });
    }
    let objectPath = null;
    try {
      const groupId = req.body?.groupId;
      if (!groupId) {
        const err = new Error('Missing reservation. Please select your slot(s) again.');
        err.code = 'INVALID';
        throw err;
      }
      if (!req.file) {
        const err = new Error('A payment screenshot is required.');
        err.code = 'INVALID';
        throw err;
      }

      objectPath = await saveUploadedFile(req.file);

      const { bookings } = await store.finalizeHold(groupId, {
        name: req.body?.name,
        contact: req.body?.contact,
        notes: req.body?.notes,
        screenshotFilename: objectPath,
      });

      res.status(201).json({
        groupId,
        bookings: bookings.map((b) => ({
          id: b.id,
          courtId: b.courtId,
          date: b.date,
          hour: b.hour,
          status: b.status,
          price: b.price,
        })),
      });
    } catch (err) {
      // Clean up the uploaded file if the booking itself failed validation
      if (objectPath) deleteUploadedFile(objectPath);
      const status = err.code === 'TAKEN' ? 409 : err.code === 'HOLD_EXPIRED' ? 410 : 400;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });
});

// --- Admin routes --------------------------------------------------------------
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    if (await store.verifyAdminPassword(password)) return res.json({ ok: true });
    res.status(401).json({ ok: false, error: 'Incorrect password' });
  } catch (err) {
    console.error('POST /api/admin/login error:', err);
    res.status(500).json({ ok: false, error: 'Could not verify password.' });
  }
});

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const supplied = req.get('x-admin-password') || req.body?.password || req.query?.pw;
    const bookings = (await store.listAllBookings()).map((b) => ({
      ...b,
      screenshotUrl: b.screenshotFilename ? `/api/admin/screenshots/${b.screenshotFilename}?pw=${encodeURIComponent(supplied)}` : null,
    }));
    res.json({ bookings });
  } catch (err) {
    console.error('GET /api/admin/bookings error:', err);
    res.status(500).json({ error: 'Could not load bookings.' });
  }
});

// Serve payment screenshots only to authenticated admins: this route checks
// the admin password itself, then hands back a short-lived (60s) signed URL
// from the private bucket -- the browser is redirected straight to Supabase
// Storage rather than proxying bytes through this function.
app.get('/api/admin/screenshots/:objectPath(.*)', requireAdmin, async (req, res) => {
  const objectPath = req.params.objectPath;
  // Only ever allow serving a screenshot that belongs to this deployment's
  // own facility, even though the underlying bucket is shared.
  if (!objectPath.startsWith(`${store.FACILITY_ID}/`)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.storage.from(SCREENSHOT_BUCKET).createSignedUrl(objectPath, 60);
    if (error || !data?.signedUrl) return res.status(404).json({ error: 'Not found' });
    res.redirect(data.signedUrl);
  } catch (err) {
    console.error('GET /api/admin/screenshots error:', err);
    res.status(500).json({ error: 'Could not load screenshot.' });
  }
});

app.post('/api/admin/block', requireAdmin, async (req, res) => {
  const { courtId, date, hour, notes } = req.body || {};
  try {
    const booking = await store.blockSlot({ courtId, date, hour, notes });
    res.status(201).json({ booking });
  } catch (err) {
    const status = err.code === 'TAKEN' ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

app.post('/api/admin/groups/:groupId/confirm', requireAdmin, async (req, res) => {
  try {
    const bookings = await store.confirmGroup(req.params.groupId);
    res.json({ bookings });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/admin/groups/:groupId/reject', requireAdmin, async (req, res) => {
  try {
    const bookings = await store.rejectGroup(req.params.groupId, req.body?.reason);
    res.json({ bookings });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/admin/bookings/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const booking = await store.cancelBooking(req.params.id);
    res.json({ booking });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  try {
    const booking = await store.findBooking(req.params.id);
    await store.deleteBooking(req.params.id);
    if (booking.screenshotFilename) deleteUploadedFile(booking.screenshotFilename);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// --- Telegram booking notifications -----------------------------------------
// See lib/store.js's "Telegram notification linking" section for how
// linking actually works (one shared bot, per-facility chat_id, no
// webhook). These routes are just the admin-panel-facing surface of it.

app.get('/api/admin/telegram/status', requireAdmin, async (req, res) => {
  try {
    res.json(await store.getTelegramStatus());
  } catch (err) {
    console.error('GET /api/admin/telegram/status error:', err);
    res.status(500).json({ error: 'Could not load Telegram status.' });
  }
});

app.post('/api/admin/telegram/start-link', requireAdmin, async (req, res) => {
  try {
    res.json(await store.startTelegramLink());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/telegram/finish-link', requireAdmin, async (req, res) => {
  try {
    res.json(await store.finishTelegramLink());
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

app.post('/api/admin/telegram/disconnect', requireAdmin, async (req, res) => {
  try {
    await store.disconnectTelegram();
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/admin/telegram/disconnect error:', err);
    res.status(500).json({ error: 'Could not disconnect Telegram.' });
  }
});

// Vercel wraps this file as a serverless function and calls the exported
// app directly, so app.listen() must only run when the file is executed
// as a normal Node process (local dev, or a persistent host like Render).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`FORA Pickleball booking site running at http://localhost:${PORT}`);
  });
}

module.exports = app;
