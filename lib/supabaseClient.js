const { createClient } = require('@supabase/supabase-js');

let client = null;

// A single shared server-side client, authenticated with the service_role
// key. This key must never be exposed to the browser -- it bypasses Row
// Level Security, which is exactly why every database/storage call in this
// app happens here on the server, never from public/app.js or admin.js.
function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required.');
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

module.exports = { getSupabase };
