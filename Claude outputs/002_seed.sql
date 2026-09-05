-- Seeds the two facilities. Both admin passwords are set to "admin123" for
-- now (same default Fora already used) -- change them later by updating
-- the admin_password_hash column (ask me for a fresh bcrypt hash, or I can
-- add a "change password" admin feature later).

insert into facilities (
  id, name, courts, open_hour, close_hour, price_per_hour, currency,
  payment_method, payment_number, payment_name, payment_note,
  location_maps_url, max_slots_per_booking, admin_password_hash
) values (
  'fora',
  'FORA',
  '[{"id":1,"name":"Court 1"},{"id":2,"name":"Court 2"},{"id":3,"name":"Court 3"}]'::jsonb,
  6, 22, 150, 'PHP',
  'GCash', '0917-000-0000', 'Juan Dela Cruz',
  'Upload a screenshot below once you''ve paid. Slots are held as Pending until we confirm it.',
  'https://maps.app.goo.gl/Fg9G4Zndzf8YkVdT8',
  12,
  '$2b$10$b40hBOKQocncnAwFFeng/ezoQR24eb/JEHPgHb9DxqyAovj/DNly6'
)
on conflict (id) do nothing;

insert into facilities (
  id, name, courts, open_hour, close_hour, price_per_hour, currency,
  payment_method, payment_number, payment_name, payment_note,
  location_maps_url, max_slots_per_booking, admin_password_hash
) values (
  'jp',
  'J&P',
  '[{"id":1,"name":"Court 1"},{"id":2,"name":"Court 2"},{"id":3,"name":"Court 3"},{"id":4,"name":"Court 4"}]'::jsonb,
  6, 22, 150, 'PHP',
  'GCash', '0917-000-0000', 'J&P Owner',
  'Upload a screenshot below once you''ve paid. Slots are held as Pending until we confirm it.',
  'https://maps.app.goo.gl/replace-with-jp-location',
  12,
  '$2b$10$sAsirZ530LIsnRFqlEXWpeyDDQcF6n4zb84.YIfXd2fm91mZhc4HG'
)
on conflict (id) do nothing;
