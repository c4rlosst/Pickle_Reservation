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

const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// --- Screenshot upload handling ---------------------------------------------
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

const upload = multer({
  storage: multer.diskStorage({
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
    paymentInstructions: store.PAYMENT_INSTRUCTIONS,
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
    status: b.status, // pending | confirmed | blocked
    // Don't leak customer contact info (or screenshots) to the public booking grid
    label: b.status === 'blocked' ? 'Unavailable' : b.status === 'pending' ? 'Pending' : initials(b.name),
  }));
  res.json({ bookings });
});

function initials(name) {
  if (!name) return 'Booked';
  return (
    name
      .trim()
      .split(/\s+/)
      .map((p) => p[0].toUpperCase())
      .slice(0, 2)
      .join('.') + '.'
  );
}

app.post('/api/bookings', (req, res) => {
  upload.single('screenshot')(req, res, (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message, code: 'INVALID' });
    }
    const { courtId, date, hour, name, contact, notes } = req.body || {};
    try {
      if (!req.file) {
        const err = new Error('A payment screenshot is required.');
        err.code = 'INVALID';
        throw err;
      }
      const booking = store.createBooking({
        courtId,
        date,
        hour,
        name,
        contact,
        notes,
        screenshotFilename: req.file.filename,
      });
      res.status(201).json({
        booking: {
          id: booking.id,
          courtId: booking.courtId,
          date: booking.date,
          hour: booking.hour,
          status: booking.status,
          price: booking.price,
        },
      });
    } catch (err) {
      // Clean up the uploaded file if the booking itself failed validation
      if (req.file) {
        fs.unlink(path.join(UPLOADS_DIR, req.file.filename), () => {});
      }
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

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const bookings = store.listAllBookings().map((b) => ({
    ...b,
    screenshotUrl: b.screenshotFilename ? `/api/admin/screenshots/${b.screenshotFilename}?pw=${encodeURIComponent(ADMIN_PASSWORD)}` : null,
  }));
  res.json({ bookings });
});

// Serve payment screenshots only to authenticated admins. Filenames are
// random/unguessable, and this route additionally requires the admin
// password, so screenshots are never exposed on the public site.
app.get('/api/admin/screenshots/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
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

app.post('/api/admin/bookings/:id/confirm', requireAdmin, (req, res) => {
  try {
    const booking = store.confirmBooking(req.params.id);
    res.json({ booking });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/admin/bookings/:id/reject', requireAdmin, (req, res) => {
  try {
    const booking = store.rejectBooking(req.params.id, req.body?.reason);
    res.json({ booking });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: err.message });
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
    const booking = store.findBooking(req.params.id);
    store.deleteBooking(req.params.id);
    if (booking.screenshotFilename) {
      fs.unlink(path.join(UPLOADS_DIR, booking.screenshotFilename), () => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FORA Pickleball booking site running at http://localhost:${PORT}`);
});
