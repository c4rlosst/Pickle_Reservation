-- Adds a temporary "hold" mechanism: the instant a customer opens the
-- payment screen (before they've actually paid), their selected slot(s) get
-- reserved under a short countdown so nobody else can grab them while that
-- customer is off in their GCash app sending money. If they don't finish
-- uploading their payment screenshot in time, the hold expires on its own
-- and the slot frees back up.
--
-- A row with hold_expires_at set and no screenshot yet is an in-progress
-- hold. Once the customer submits their screenshot, hold_expires_at is
-- cleared and it becomes a normal "Pending review" booking, same as before.

alter table bookings add column if not exists hold_expires_at timestamptz;
