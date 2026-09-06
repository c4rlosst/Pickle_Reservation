# FORA Reservation — Security & Architecture Review

Date: 2026-09-05
Scope: `server.js`, `lib/store.js`, `lib/telegram.js`, `lib/supabaseClient.js`, `public/app.js`, `public/admin.js`, Supabase schema (`supabase/*.sql`).

Note: I don't have access to this project's Supabase account through my tools (it's on a different account than the one connected to this session), so I could not pull Supabase's own Security Advisor report. Everything below comes from reading the actual schema and code. I'd still recommend running **Database → Advisors → Security Advisor** yourself in the Supabase dashboard as a cross-check — it catches a couple of things (like missing indexes on foreign keys, or extensions installed in the public schema) that aren't visible from the app code alone.

---

## Summary

The core design is solid: row-level security is enabled with zero policies (meaning only the server's `service_role` key can touch the data at all — the anon/public key literally cannot read or write anything), every query is scoped to the deployment's own `FACILITY_ID`, secrets never reach the client, and `.env` has never been committed. That's the hard part, and it's done right.

The issues found are all in the "smaller cracks" category — nothing that exposes another facility's data, but a few real gaps around brute-force protection, one small PII leak, and a couple of low-severity hardening items. Ranked by severity below.

---

## High

### 1. No rate limiting or lockout on admin login, and no way to change the seeded default password from the app

`requireAdmin` (server.js) checks the supplied password against the bcrypt hash on *every* request, with no throttling, no attempt counter, and no lockout. Combined with the seed data (`supabase/002_seed.sql`), every facility starts with the same default password (`admin123`), and there is currently **no in-app way to change it** — the only path is manually generating a new bcrypt hash and updating the row via SQL, which is a real barrier for a non-technical facility owner.

In practice, for a product meant to be resold to multiple facilities, this means: unless you personally walk each new facility through changing their password via SQL, their admin panel is protected by a widely-known default password with nothing stopping a script from guessing it (or a handful of common passwords) at any speed. `bcryptjs` at the default cost factor isn't even particularly slow to guess against for a scripted attacker without a lockout in place.

**Fix:**
- Add a simple rate limit to `requireAdmin` and `/api/admin/login` (e.g. `express-rate-limit`, keyed by IP — a handful of attempts per minute is plenty for a real admin who mistypes their password, and painful for a brute-force script).
- Add a "Change password" action to the admin panel (a new `POST /api/admin/change-password` route, `requireAdmin`-protected, that re-hashes and updates `admin_password_hash`) so this stops depending on you manually running SQL for every facility.
- Consider forcing a password change on first login if the hash still matches the known seed value.

### 2. Public `/api/bookings` returns real customer names to anyone, unauthenticated

In `server.js`, `GET /api/bookings` deliberately strips `name` only for `blocked` slots — pending/confirmed bookings still return the customer's real name in the JSON response:

```js
name: b.status === 'blocked' ? null : b.name,
```

I checked `public/app.js` and this `name` field is never actually rendered anywhere in the UI — it's fetched and silently unused. That means it's pure unnecessary exposure: anyone who opens dev tools, or just runs `curl yoursite.com/api/bookings?date=2026-09-06`, gets a list of every customer's real name for that day with zero authentication. For a booking calendar, the public only needs to know a slot is taken — not who took it.

**Fix:** null out `name` for every status in the public response, not just `blocked` (i.e. always `null`, or drop the field entirely from this endpoint). The admin-only `/api/admin/bookings` endpoint already correctly includes full name/contact — that's the right place for it.

---

## Medium

### 3. Admin password is passed as a URL query string for the screenshot route

Everywhere else, the admin password travels as the `x-admin-password` header (`admin.js`'s `authedFetch`). But `/api/admin/screenshots/:objectPath` is reached via `window.location`/`<a>`-style navigation (so a custom header isn't possible), so it's passed as `?pw=...` in the URL instead — and that same password is echoed back into the `screenshotUrl` field on every `/api/admin/bookings` response.

Query strings like this get written into Vercel's own request logs, and would show up in browser history if the link were ever opened in a new tab. It's a smaller exposure than the plaintext password itself already implies (transport is HTTPS, so nothing is sniffable in transit), but it's an unnecessary place for a credential to end up sitting in a log file.

**Fix:** Since the underlying value only needs to authorize *this one screenshot fetch*, swap it for a short-lived, single-purpose token instead of the real admin password — e.g. `requireAdmin` on `/api/admin/bookings` also mints a signed, 60-second-expiry token (HMAC of `objectPath` + timestamp using a server secret) and that's what goes in the URL, not the actual password. That way, even if a URL leaks into a log, it doesn't hand out the admin credential itself.

### 4. No rate limiting on hold creation (a griefing / availability risk)

`POST /api/bookings/hold` requires no authentication and no CAPTCHA. A script could repeatedly hold every slot on every court for every future date, letting each hold nearly expire and re-holding it just before the countdown ends — effectively locking real customers out of booking anything, indefinitely, with no financial cost to the attacker (no payment is required to create a hold, only to finalize one).

This doesn't expose any data, but it's a real availability risk for a live booking business, and it gets more likely as this product is resold to more facilities that could plausibly be targeted by a disgruntled customer or competitor.

**Fix:** A basic per-IP rate limit on `/api/bookings/hold` (e.g. a handful of holds per minute) would make this impractical without materially affecting real customers, who only ever need to hold their own slot(s) once.

---

## Low

### 5. No security headers (helmet)

There's no `helmet` (or equivalent) in use, so there's no explicit `X-Frame-Options` / `Content-Security-Policy: frame-ancestors`. That means the admin login page could technically be embedded in an invisible iframe on a malicious site for a clickjacking attempt (tricking an already-logged-in-feeling admin into clicking something). Vercel does add a few defaults (like HSTS) automatically, but frame-ancestors isn't one of them.

**Fix:** `app.use(helmet())` is a one-line addition that covers this and a few other minor headers (`X-Content-Type-Options`, etc.) for free.

### 6. No in-app audit trail for admin actions

Confirming, rejecting, deleting bookings, and disconnecting Telegram all happen with no record of *who* did it (there's only ever one admin per facility today, so this is low-stakes right now) or *when*, beyond `reviewed_at`. Worth keeping in mind if a facility ever wants more than one staff account — right now there's no way to tell them apart, since auth is a single shared password per facility rather than per-user.

---

## What's already solid (no action needed)

- **Row-Level Security**: both `facilities` and `bookings` have RLS enabled with zero policies defined — this means the anon/public Supabase key (if it ever leaked) grants literally zero read/write access to anything. All access goes through the server-only `service_role` key, which correctly never appears in any client-side file (verified by grepping `public/`).
- **Multi-tenant isolation**: every single database query in `lib/store.js` — no exceptions — filters on `.eq('facility_id', FACILITY_ID)`, where `FACILITY_ID` comes from a server-side env var, never from user input. There's no path for one facility's deployment to read or modify another facility's rows.
- **Payment screenshots**: stored in a private Supabase Storage bucket, served only via a `requireAdmin`-gated route that (a) checks the path is prefixed with the calling deployment's own `FACILITY_ID` and (b) hands back a 60-second signed URL rather than a permanent public link.
- **Secrets hygiene**: `.env` is gitignored and has never been committed (checked full git history, not just the current tree). No token, key, or password appears in any client-side JS bundle.
- **XSS**: every user-supplied field rendered into the admin panel's HTML (customer name, contact, notes, reject reason) goes through a consistent `escapeHtml()` before hitting `innerHTML`. Telegram notification text goes through an equivalent `escapeHtmlForTelegram()` before being sent with `parse_mode: 'HTML'`.
- **Injection**: all database access goes through the Supabase client's parameterized query builder. The one place a value gets interpolated into a raw PostgREST filter string (`store.js`'s `confirmGroup`/`rejectGroup`, matching a numeric `groupId`) is guarded by a `/^\d+$/` regex first, so only pure digits — which can't break out of the filter syntax — ever reach that code path.
- **Double-booking protection**: enforced at the database level via a partial unique index (`bookings_active_slot_uniq`), not just application logic, so even a race condition or a bug in the hold logic can't produce two active bookings for the same slot.

---

## Suggested priority order

1. Add a "change admin password" flow + basic login rate limiting (High #1) — this is the one that matters most before onboarding real facilities.
2. Strip customer names from the public `/api/bookings` response (High #2) — a five-minute fix.
3. Swap the screenshot route's `?pw=` for a short-lived signed token (Medium #3).
4. Rate-limit `/api/bookings/hold` (Medium #4).
5. Add `helmet()` (Low #5) — trivial, do it while you're in there.

Happy to implement any of these now — the password-change flow and the two rate limits are probably the best use of the next session.
