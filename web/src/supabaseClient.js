import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy web/.env.example to web/.env and fill in your Supabase project's values."
  );
}

// persistSession: false -- the session lives only in memory for the current
// page load. Nothing is written to any storage, so every fresh page open
// (a new tab, a refresh, reopening the link later) always lands on the sign-in
// screen and requires logging in again, even for the account that was just
// using it. Within a single page load (no reload), login still holds for as
// long as the tab stays open, subject to the idle-timeout sign-out in App.jsx.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
  },
});
