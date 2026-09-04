# FORA Pickleball — Court Booking

A booking site for a 3-court pickleball facility with manual payment
verification: customers pick a date, see an hourly availability grid for all
3 courts, and book a slot by uploading a screenshot of their payment. The
slot is held as **Pending** until the admin reviews the screenshot in the
admin dashboard and either **Confirms** it (payment verified, slot booked)
or **Rejects** it (slot re-opens for others).

## Stack

Plain Node.js + Express backend, vanilla HTML/CSS/JS frontend, and a small
JSON file (`data/db.json`) as the database — no external database required.
Payment screenshots are stored on disk under `uploads/` and are only ever
served to authenticated admin requests (never linked from the public site).

## Getting started

```bash
npm install
cp .env.example .env   # then edit .env and set your own ADMIN_PASSWORD
npm start
```

Visit http://localhost:3000 for the public booking page and
http://localhost:3000/admin.html for the admin dashboard (default password
`admin123` unless you changed it in `.env`).

## How booking works

1. Customer picks an open (green) slot on the public grid.
2. The modal shows the price and your payment instructions (GCash number,
   etc. — edit these in `lib/store.js`).
3. Customer enters their name, phone/email, and uploads a screenshot of the
   payment, then submits.
4. The slot immediately shows as **Pending** (yellow) to everyone else, so
   nobody else can book the same court/hour while it's under review.
5. In the admin dashboard, you see the pending booking with a thumbnail of
   the screenshot (click to view full size). You either:
   - **Confirm** — payment looks real, slot becomes booked (red).
   - **Reject** — payment looks fake/wrong, slot re-opens; you can add a
     reason that's saved on the booking record.
6. Confirmed bookings can later be **Cancelled** by the admin if needed
   (e.g. a customer asks to cancel), which also re-opens the slot.
7. Any booking can be permanently **Deleted** from the admin dashboard,
   which also removes its uploaded screenshot from disk.

## Configuration

Edit the constants at the top of `lib/store.js` to change:

- `COURTS` — court names/IDs (currently Court 1, 2, 3)
- `OPEN_HOUR` / `CLOSE_HOUR` — operating hours (currently 6:00–22:00, hourly slots)
- `PRICE_PER_HOUR`, `CURRENCY` — price shown to customers
- `PAYMENT_INSTRUCTIONS` — where/how customers should send payment (GCash
  number, bank details, etc.) — **update this with your real payment info**
  before going live.

Admin password is set via the `ADMIN_PASSWORD` environment variable (see
`.env.example`).

## Project structure

```
server.js            Express app, API routes, screenshot upload handling (multer)
lib/store.js          Booking data + business rules (courts, hours, statuses, double-booking checks)
data/db.json           Booking data (auto-created, gitignored)
uploads/                Payment screenshots (auto-created, gitignored)
public/index.html      Public booking page
public/app.js            Public booking page logic
public/admin.html      Admin dashboard
public/admin.js          Admin dashboard logic (review, confirm/reject, block, cancel, delete)
public/style.css       Shared styling
```

## Notes

- Double-booking is prevented server-side: a court/hour can only be held by
  one pending/confirmed/blocked booking at a time.
- The public grid never shows a booker's phone/email or screenshot — only
  their initials once pending/confirmed.
- Payment screenshots are served only through an admin-authenticated route
  with randomized, unguessable filenames — not linked anywhere public.
- This is intentionally simple (file-based storage) and meant to run as a
  single small Node process. For production use behind a real domain, put it
  behind HTTPS.
