# FORA Pickleball — Court Booking

A simple booking site for a 3-court pickleball facility. Customers pick a date,
see an hourly availability grid for all 3 courts, and book a free slot with
their name and phone/email — no account needed. An admin dashboard lets you
view all bookings, cancel/delete them, and block off slots (e.g. maintenance).

## Stack

Plain Node.js + Express backend, vanilla HTML/CSS/JS frontend, and a small
JSON file (`data/db.json`) as the database — no external database or native
dependencies required.

## Getting started

```bash
npm install
cp .env.example .env   # then edit .env and set your own ADMIN_PASSWORD
npm start
```

Visit http://localhost:3000 for the public booking page and
http://localhost:3000/admin.html for the admin dashboard (default password
`admin123` unless you changed it in `.env`).

## Configuration

Edit the constants at the top of `lib/store.js` to change:

- `COURTS` — court names/IDs (currently Court 1, 2, 3)
- `OPEN_HOUR` / `CLOSE_HOUR` — operating hours (currently 6:00–22:00, hourly slots)

## Project structure

```
server.js         Express app & API routes
lib/store.js       Booking data + business rules (courts, hours, double-booking checks)
data/db.json        Booking data (auto-created, gitignored is NOT set — see note below)
public/index.html   Public booking page
public/app.js        Public booking page logic
public/admin.html   Admin dashboard
public/admin.js      Admin dashboard logic
public/style.css    Shared styling
```

## Notes

- Double-booking is prevented server-side: a court/hour can only be booked once.
- The public grid never shows a booker's phone/email — only their initials.
- This is intentionally simple (file-based storage) and meant to run as a
  single small Node process. For production use behind a real domain, put it
  behind HTTPS and consider swapping `data/db.json` for a real database if
  booking volume grows.
