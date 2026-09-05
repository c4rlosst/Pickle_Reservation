-- Adds Telegram-based booking notifications: each facility can link its own
-- admin's Telegram chat, and the server DMs that chat whenever a customer
-- submits a booking (payment screenshot uploaded -> pending review).
--
-- telegram_chat_id: set once the admin finishes linking; null means
--   notifications are off for this facility.
-- telegram_link_code / telegram_link_code_expires_at: a short-lived code
--   generated when the admin clicks "Connect Telegram" in the admin panel,
--   used to match the message they send the bot back to this facility row.
--   Cleared as soon as linking succeeds (or the code expires).

alter table facilities add column if not exists telegram_chat_id text;
alter table facilities add column if not exists telegram_link_code text;
alter table facilities add column if not exists telegram_link_code_expires_at timestamptz;
