-- Basic brute-force protection for the admin login: after too many wrong
-- passwords in a row, the facility's admin login locks itself out for a
-- short cooldown instead of allowing unlimited guesses.
--
-- admin_login_fail_count: consecutive wrong-password attempts since the
--   last success (or the last lockout). Reset to 0 on a correct password.
-- admin_login_locked_until: set once fail_count hits the threshold; while
--   this is in the future, even a correct password is rejected until it
--   passes. Cleared automatically once the lockout naturally expires.

alter table facilities add column if not exists admin_login_fail_count int not null default 0;
alter table facilities add column if not exists admin_login_locked_until timestamptz;
