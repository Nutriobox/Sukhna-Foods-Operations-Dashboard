// Uploads the processed rows to Supabase.
const { createClient } = require('@supabase/supabase-js');

async function uploadToSupabase(rows) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env');

  const supabase = createClient(url, key);
  // TODO(confirm table name + columns once schema exists):
  const { error } = await supabase.from('vehicle_movement').upsert(rows);
  if (error) throw new Error('Supabase upload failed: ' + error.message);
  return rows.length;
}

module.exports = { uploadToSupabase };
