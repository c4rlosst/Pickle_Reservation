-- Example facility rows. Edit or add more as needed -- see "Multi-facility
-- setup" in the README. Both admin passwords below hash to "admin123" --
-- change them before going live (see README: "Changing an admin password").

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
