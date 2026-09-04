# Pickleball Court Booking — multi-facility

A booking site for pickleball court facilities with manual payment
verification: customers pick a date, see an hourly availability grid for
that facility's courts, and book a slot by uploading a screenshot of their
payment. The slot is held as **Pending** until the admin reviews the
screenshot in the admin dashboard and either **Confirms** it (payment
verified, slot booked) or **Rejects** it (slot re-opens for others).

This one codebase can serve multiple separate facilities (e.g. FORA, J&P)
from a single shared Supabase database -- each facility gets its own
deployment, courts, pricing, payment info, and admin login, but none of
them can ever see or touch another facility's bookings. See "Multi-facility
setup" below.

## Stack

Node.js + Express backend, vanilla HTML/CSS/JS frontend, [Supabase](https://supabase.com)
(Postgres) for booking data and Supabase Storage (a private bucket) for
payment screenshots. There is no local-file storage mode anymore -- every
environment (local dev included) talks to the same Supabase project.

## Getting started

1. Create a Supabase project, then run `supabase/001_init.sql` and
   `supabase/002_seed.sql` (in that order) in its **SQL Editor**. This
   creates the `facilities` and `bookings` tables and seeds a couple of
   example facilities.
2. In the Supabase dashboard, go to **Storage** → **New bucket** → name it
   `screenshots` → leave **Public bucket** off (private).
3. Copy `.env.example` to `.env` and fill in `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API), plus
   `FACILITY_SLUG` (which facility row this instance serves, e.g. `fora`).
4. `npm install && npm start`

Visit http://localhost:3000 for the public booking page and
http://localhost:3000/admin.html for the admin dashboard. The seeded admin
password is `admin123` for every facility until you change it (see
"Changing an admin password" below).

## How booking works

1. The public page shows one table: courts as columns, hours as rows.
   Customer taps any number of **OPEN** cells — across different courts
   and/or different times on the same day — to select them; selected
   cells turn green.
2. A summary bar appears below the grid ("N slots selected · ₱total").
   Clicking **Book selected** opens a modal listing every selected slot
   and the total price, plus that facility's payment instructions.
3. Customer enters their name, phone/email, and uploads **one** screenshot
   covering the whole payment (even if it's for multiple slots), then
   submits. Up to `max_slots_per_booking` slots (12 by default) can be
   submitted together.
4. All selected slots are created together as one "group" and immediately
   show as **Pending** to everyone else, so nobody else can book them
   while under review. If any of the selected slots was taken in the
   meantime, the whole submission is rejected (nothing is partially
   booked) and the customer is asked to reselect. This is enforced twice:
   a fast application-level check, and a database unique index as the real
   guarantee against a race between two simultaneous bookings.
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
   which also removes its uploaded screenshot from storage.
8. In **Block a slot**, the hour picker shows which times are already taken
   for the selected court/date -- green (available), yellow/struck-through
   (pending), or red/struck-through (booked/blocked) -- so staff have a
   clear view of what can actually be blocked.

## Multi-facility setup

Every table has a `facility_id` column, so one Supabase project can safely
hold many facilities at once. Adding a new one:

1. Insert a row into `facilities` (courts, hours, pricing, payment info,
   and a bcrypt-hashed admin password -- ask an assistant, or use any
   online bcrypt generator, to hash the password you want).
2. Create a new Vercel project pointing at this **same** GitHub repo (no
   forking needed -- it's the same code for every facility).
3. Set that project's environment variables: the same `SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE_KEY` as every other facility, but its own
   `FACILITY_SLUG` matching the new row's id.
4. Deploy, and optionally attach a custom domain for that facility.

No new database, storage bucket, or per-facility infrastructure is needed
-- the whole point of the shared-database design is that onboarding a new
facility is just a database row and a small Vercel project.

### Changing an admin password

There's no in-app "change password" screen yet. To change one, generate a
bcrypt hash of the new password (ask an assistant, or `node -e
"console.log(require('bcryptjs').hashSync('new-password', 10))"` with
`bcryptjs` installed) and update that facility's `admin_password_hash`
column via the Supabase SQL Editor or Table Editor.

## Deploying to Vercel

`vercel.json` and `api/index.js` are already set up to run the whole
Express app as one serverless function (Vercel's filesystem is read-only
outside `/tmp`, which is why storage lives in Supabase rather than on
disk).

1. **Push this repo to Vercel** (import the GitHub repo, or `vercel deploy`).
2. Under Project Settings → Environment Variables, set `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, and `FACILITY_SLUG` for this deployment.
3. Redeploy so the new environment variables take effect.

## Project structure

```
server.js                Express app, API routes, screenshot upload handling (multer)
api/index.js                Vercel serverless entry point (re-exports server.js)
vercel.json                  Routes every request on Vercel to api/index.js
lib/store.js              Booking data + business rules, scoped to FACILITY_SLUG
lib/supabaseClient.js       Shared server-side Supabase client (service_role key)
supabase/001_init.sql     Table/index definitions -- run once per Supabase project
supabase/002_seed.sql       Example facility rows -- edit/extend as you add facilities
public/index.html          Public booking page
public/app.js                Public booking page logic
public/admin.html          Admin dashboard
public/admin.js              Admin dashboard logic (review, confirm/reject, block, cancel, delete)
public/style.css           Shared styling
```

## Notes

- Double-booking is prevented both in the application and by a database
  unique index (`facility_id, court_id, date, hour` for active bookings) --
  a genuine race between two simultaneous bookings can't create a
  duplicate.
- The public grid never shows a booker's phone/email or screenshot — only
  their name once pending/confirmed.
- Payment screenshots live in a private Supabase Storage bucket. They're
  only ever reachable through an admin-password-gated route, which hands
  back a 60-second signed URL -- never a public link.
- Every database/storage call uses the `SUPABASE_SERVICE_ROLE_KEY`, which
  bypasses Row Level Security -- that key must only ever be set as a
  server-side environment variable, never shipped to the browser.
