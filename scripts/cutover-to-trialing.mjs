// One-time cutover script (adding-user-accounts.md section 7, step 2). Run
// this ONCE, when you're ready to actually turn on billing: it moves every
// existing 'beta' user to 'trialing', with trial_ends_at computed from
// today's date using the same day-17 rule as new signups will use going
// forward.
//
// Usage:
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node scripts/cutover-to-trialing.mjs
//
// SUPABASE_SERVICE_ROLE_KEY is the secret key from Supabase Project Settings
// -> API -- NOT the anon/publishable key. Never commit it or put it in the
// web app's .env; run this script locally with it as a one-off env var.

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.");
  process.exit(1);
}

function computeTrialEnd(signupDate) {
  const day = signupDate.getDate();
  let year = signupDate.getFullYear();
  let month = signupDate.getMonth(); // 0-indexed
  if (day > 17) {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  const lastDay = new Date(year, month + 1, 0);
  lastDay.setHours(23, 59, 59, 999);
  return lastDay;
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

const trialEndsAt = computeTrialEnd(new Date()).toISOString();

const { data, error } = await supabase
  .from("profiles")
  .update({ subscription_status: "trialing", trial_ends_at: trialEndsAt })
  .eq("subscription_status", "beta")
  .select("id, email");

if (error) {
  console.error("Cutover failed:", error);
  process.exit(1);
}

console.log(`Moved ${data.length} beta user(s) to trialing, trial_ends_at = ${trialEndsAt}`);
data.forEach((row) => console.log(`  - ${row.email ?? row.id}`));
