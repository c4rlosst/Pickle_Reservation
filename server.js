require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const store = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// On Vercel the filesystem is read-only outside /tmp, so uploaded payment
// screenshots can't live on local disk there. When Vercel Blob is linked
// (BLOB_READ_WRITE_TOKEN is set automatically once you add the integration)
// screenshots are stored there instead; everywhere else (local dev, a VPS,
// Render, etc.) they stay on local disk exactly as before.
const USE_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
let blobApi = null;
if (USE_BLOB) {
  blobApi = require('@vercel/blob');
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!USE_BLOB) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// --- Screenshot upload handling ---------------------------------------------
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

const upload = multer({
  storage: USE_BLOB
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOADS_DIR),
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname || '').slice(0, 10) || '.jpg';
          cb(null, crypto.randomBytes(20).toString('hex') + ext);
        },
      }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only image files (jpg, png, webp, gif, heic) are allowed.'));
  },
});

// When storing in Blob, multer only gives us a buffer (no filename), so we
// generate the same kind of random name ourselves before uploading it.
function randomFilename(file) {
  const ext = path.extname(file.originalname || '').slice(0, 10) || '.jpg';
  return crypto.randomBytes(20).toString('hex') + ext;
}

async function saveUploadedFile(file) {
  if (!USE_BLOB) return file.filename; // multer already wrote it to disk
  const filename = randomFilename(file);
  await blobApi.put(filename, file.buffer, {
    access: 'public',
    addRandomSuffix: false,
    contentType: file.mimetype,
  });
  return filename;
}

async function deleteUploadedFile(filename) {
  if (!filename) return;
  if (USE_BLOB) {
    try {
      const { blobs } = await blobApi.list({ prefix: filename, limit: 1 });
      const match = blobs.find((b) => b.pathname === filename);
      if (match) await blobApi.del(match.url);
    } catch (e) {
      // Best-effort cleanup only -- don't fail the request over it.
    }
    return;
  }
  fs.unlink(path.join(UPLOADS_DIR, filename), () => {});
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Admin auth middleware -------------------------------------------------
function requireAdmin(req, res, next) {
  const supplied = req.get('x-admin-password') || req.body?.password || req.query?.pw;
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
    pricePerHour: store.PRICE_PER_HOUR,
    currency: store.CURRENCY,
    paymentMethod: store.PAYMENT_METHOD,
    paymentNumber: store.PAYMENT_NUMBER,
    paymentName: store.PAYMENT_NAME,
    paymentNote: store.PAYMENT_NOTE,
    locationMapsUrl: store.LOCATION_MAPS_URL,
    maxSlotsPerBooking: store.MAX_SLOTS_PER_BOOKING,
  });
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
    res.status(500).json({ error: 'Could not load bookings.' });
  }
});

app.post('/api/bookings', (req, res) => {
  upload.single('screenshot')(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message, code: 'INVALID' });
    }
    let filename = null;
    try {
      if (!req.file) {
        const err = new Error('A payment screenshot is required.');
        err.code = 'INVALID';
        throw err;
      }

      let slots;
      try {
        slots = JSON.parse(req.body?.slots || '[]');
      } catch (e) {
        const err = new Error('Invalid slot selection.');
        err.code = 'INVALID';
        throw err;
      }

      filename = await saveUploadedFile(req.file);

      const { groupId, bookings } = await store.createBookings(slots, {
        name: req.body?.name,
        contact: req.body?.contact,
        notes: req.body?.notes,
        screenshotFilename: filename,
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
      if (filename) deleteUploadedFile(filename);
      const status = err.code === 'TAKEN' ? 409 : 400;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });
});

// --- Admin routes --------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, error: 'Incorrect password' });
});

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const bookings = (await store.listAllBookings()).map((b) => ({
      ...b,
      screenshotUrl: b.screenshotFilename ? `/api/admin/screenshots/${b.screenshotFilename}?pw=${encodeURIComponent(ADMIN_PASSWORD)}` : null,
    }));
    res.json({ bookings });
  } catch (err) {
    res.status(500).json({ error: 'Could not load bookings.' });
  }
});

// Serve payment screenshots only to authenticated admins. Filenames are
// random/unguessable, and this route additionally requires the admin
// password, so screenshots are never exposed on the public site.
app.get('/api/admin/screenshots/:filename', requireAdmin, async (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  if (USE_BLOB) {
    try {
      const { blobs } = await blobApi.list({ prefix: filename, limit: 1 });
      const match = blobs.find((b) => b.pathname === filename);
      if (!match) return res.status(404).json({ error: 'Not found' });
      const blobRes = await fetch(match.url);
      if (!blobRes.ok) return res.status(404).json({ error: 'Not found' });
      res.setHeader('Content-Type', blobRes.headers.get('content-type') || 'application/octet-stream');
      const buf = Buffer.from(await blobRes.arrayBuffer());
      res.send(buf);
    } catch (err) {
      res.status(500).json({ error: 'Could not load screenshot.' });
    }
    return;
  }
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
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

// Vercel wraps this file as a serverless function and calls the exported
// app directly, so app.listen() must only run when the file is executed
// as a normal Node process (local dev, or a persistent host like Render).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`FORA Pickleball booking site running at http://localhost:${PORT}`);
  });
}

module.exports = app;
