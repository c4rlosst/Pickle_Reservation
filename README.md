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

1. The public page shows one table: courts as columns, hours as rows.
   Customer taps any number of **OPEN** cells — across different courts
   and/or different times on the same day — to select them; selected
   cells turn green.
2. A summary bar appears below the grid ("N slots selected · ₱total").
   Clicking **Book selected** opens a modal listing every selected slot
   and the total price, plus your payment instructions (GCash number,
   etc. — edit these in `lib/store.js`).
3. Customer enters their name, phone/email, and uploads **one** screenshot
   covering the whole payment (even if it's for multiple slots), then
   submits. Up to `MAX_SLOTS_PER_BOOKING` slots (12 by default) can be
   submitted together.
4. All selected slots are created together as one "group" and immediately
   show as **Pending** to everyone else, so nobody else can book them
   while under review. If any of the selected slots was taken in the
   meantime, the whole submission is rejected (nothing is partially
   booked) and the customer is asked to reselect.
5. In the admin dashboard, pending bookings from the same submission are
   shown as a single row (since they share one payment screenshot) with a
   thumbnail (click to view full size). You either:
   - **Confirm all** — payment looks real, every slot in that submission
     becomes booked.
   - **Reject all** — payment looks fake/wrong, every slot re-opens; you
     can add a reason that's saved on each booking record.
6. Once confirmed, slots appear as individual rows so you can **Cancel**
   just one of them if needed (e.g. the customer only wants to cancel one
   court out of several), which re-opens that slot.
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
