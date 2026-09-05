// Developer-only tool: resets a facility's admin password directly in the
// database, for when an admin forgets theirs and can't use the in-app
// "Change password" form (which requires knowing the current one).
//
// Run from the repo root, with your usual .env in place (needs
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY -- the same values your server
// already uses):
//
//   node scripts/reset-admin-password.js <facility-slug> <new-password>
//
// Example:
//   node scripts/reset-admin-password.js fora "a new password here"
//
// This does NOT read or print the old password -- there's no way to,
// since it's only ever stored as a one-way bcrypt hash. It just sets a
// fresh one, which you then tell the admin.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const [, , slug, newPassword] = process.argv;
  if (!slug || !newPassword) {
    console.error('Usage: node scripts/reset-admin-password.js <facility-slug> <new-password>');
    process.exit(1);
  }
  if (newPassword.length < 8) {
    console.error('New password must be at least 8 characters.');
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (check your .env).');
    process.exit(1);
  }

  const supabase = createClient(url, key);
  const hash = await bcrypt.hash(newPassword, 10);

  const { data, error } = await supabase
    .from('facilities')
    .update({ admin_password_hash: hash, admin_login_fail_count: 0, admin_login_locked_until: null })
    .eq('id', slug)
    .select('id, name');

  if (error) {
    console.error('Failed to update password:', error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.error(`No facility found with id="${slug}".`);
    process.exit(1);
  }

  console.log(`Password updated for "${data[0].name}" (${data[0].id}). Any active lockout was also cleared.`);
}

main();
