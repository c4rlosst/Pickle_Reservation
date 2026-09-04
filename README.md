# FORA Pickleball — Court Booking

A booking site for a 3-court pickleball facility with manual payment
verification: customers pick a date, see an hourly availability grid for all
3 courts, and book a slot by uploading a screenshot of their payment. The
slot is held as **Pending** until the admin reviews the screenshot in the
admin dashboard and either **Confirms** it (payment verified, slot booked)
or **Rejects** it (slot re-opens for others).

## Stack

Plain Node.js + Express backend, vanilla HTML/CSS/JS frontend. Locally (or
on any host with a persistent disk, like a VPS or Render) it stores bookings
in a small JSON file (`data/db.json`) and payment screenshots on disk under
`uploads/` — no external database required. On Vercel, whose serverless
functions have a read-only filesystem, it automatically switches to Vercel
Blob (screenshots) and a Redis store via the Vercel Marketplace (bookings)
instead — see "Deploying to Vercel" below. Screenshots are only ever served
to authenticated admin requests (never linked from the public site) either
way.

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

## Deploying to Vercel

Vercel's serverless functions run on a read-only filesystem (only `/tmp` is
writable), so the local JSON-file/disk storage above can't be used there —
without the two integrations below, the app crashes on startup instead.

1. **Push this repo to Vercel** (import the GitHub repo, or `vercel deploy`).
   `vercel.json` and `api/index.js` are already set up to run the whole
   Express app as one serverless function.
2. **Add screenshot storage:** in the Vercel project, go to Storage → Browse
   Marketplace → add **Blob**. This sets `BLOB_READ_WRITE_TOKEN`
   automatically; no code changes needed.
3. **Add a bookings database:** in the same Storage tab, add a **Redis**
   integration (e.g. Upstash Redis) from the Marketplace. This sets
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically.
4. **Set `ADMIN_PASSWORD`** under Project Settings → Environment Variables
   (falls back to `admin123` if unset — change this before going live).
5. Redeploy so the new environment variables take effect.

Without step 2 the app will crash immediately on any request (the original
"Serverless Function has crashed" error); without step 3 it'll run but every
booking will vanish the moment the serverless instance recycles. Both are
required for a real deployment.

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
api/index.js            Vercel serverless entry point (re-exports server.js)
vercel.json              Routes every request on Vercel to api/index.js
lib/store.js          Booking data + business rules (courts, hours, statuses, double-booking checks)
data/db.json           Booking data -- local/disk mode only (auto-created, gitignored)
uploads/                Payment screenshots -- local/disk mode only (auto-created, gitignored)
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
