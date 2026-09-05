-- FORA booking system -- multi-tenant schema
-- One row per facility (Fora, J&P, ...), sharing this database/bucket.

create table if not exists facilities (
  id text primary key,                 -- slug, e.g. 'fora', 'jp' -- also the FACILITY_SLUG env var value
  name text not null,
  courts jsonb not null,               -- [{"id":1,"name":"Court 1"}, ...]
  open_hour int not null default 6,
  close_hour int not null default 22,
  price_per_hour int not null,
  currency text not null default 'PHP',
  payment_method text,
  payment_number text,
  payment_name text,
  payment_note text,
  location_maps_url text,
  max_slots_per_booking int not null default 12,
  admin_password_hash text not null,   -- bcrypt hash, never plaintext
  created_at timestamptz not null default now()
);

create table if not exists bookings (
  id bigint generated always as identity primary key,
  facility_id text not null references facilities(id) on delete cascade,
  group_id text,
  court_id int not null,
  date date not null,
  hour int not null,
  name text not null,
  contact text not null,
  notes text default '',
  reject_reason text,
  screenshot_path text,                -- path inside the private "screenshots" storage bucket
  price int not null default 0,
  status text not null,                -- pending | confirmed | rejected | cancelled | blocked
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists bookings_facility_date_idx on bookings (facility_id, date);
create index if not exists bookings_facility_status_idx on bookings (facility_id, status);

-- Database-level double-booking protection: only one active (pending/confirmed/blocked)
-- booking may exist per facility+court+date+hour at a time.
create unique index if not exists bookings_active_slot_uniq
  on bookings (facility_id, court_id, date, hour)
  where status in ('pending', 'confirmed', 'blocked');

-- Lock every table down to the service_role key only (the app never uses the
-- anon/public key for database access -- all reads/writes happen server-side).
alter table facilities enable row level security;
alter table bookings enable row level security;
