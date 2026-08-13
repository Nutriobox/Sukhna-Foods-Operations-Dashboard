// Uploads the trip rows to Supabase (replaces that day's rows each run).
const { createClient } = require('@supabase/supabase-js');

async function uploadToSupabase(rows, runDate) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.log('Supabase not configured (.env) — skipping website upload.'); return 0; }

  const supabase = createClient(url, key);
  const mapped = rows.map((r) => ({
    run_date: runDate,
    sr_no: r['Sr No.'],
    vehicle: r['Vehicle No.'],
    driver: r['Driver Name'] || null,
    attendant: r['Attendant Name'] || null,
    start_dest: r['Start Destination'],
    finish_dest: r['Finished Destination'],
    dispatch_time: r['Dispatch Time'],
    loc_30: r['After 30 Min Location'], time_30: r['Time '],
    loc_60: r['After 1 Hr Location'],   time_60: r['Time'],
    loc_90: r['After 1 Hr 30 Min Location'], time_90: r['Time '],
    loc_120: r['After 2 Hr Location'],  time_120: r['Time'],
    outlet_reached: r['Outlet Reached Location'],
    total_travel: r['Total Travel Time '],
    time_at_outlet: r['Time Spent at Outlet'],
    remarks: r['Remarks'],
  }));

  await supabase.from('vehicle_movement').delete().eq('run_date', runDate);
  if (mapped.length) {
    const { error } = await supabase.from('vehicle_movement').insert(mapped);
    if (error) throw new Error('Supabase upload failed: ' + error.message);
  }
  return mapped.length;
}
module.exports = { uploadToSupabase };
