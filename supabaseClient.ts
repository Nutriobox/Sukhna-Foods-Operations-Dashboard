import { createClient, SupabaseClient } from "@supabase/supabase-js";

// A single browser Supabase client, or null when the app hasn't been
// configured yet. When null, the dashboard runs on the built-in seed data
// so `npm run dev` works out of the box before Supabase is wired up.
let client: SupabaseClient | null = null;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (url && key && url.startsWith("http")) {
  client = createClient(url, key);
}

export const supabase = client;
export const supabaseReady = !!client;
