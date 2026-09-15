-- Run this in the Supabase SQL editor AFTER schema.sql, when you're ready to
-- start wiring up billing (adding-user-accounts.md section 7). Safe to run
-- once; re-running will error on the already-added column, same as
-- schema.sql does on re-run -- that's expected, not a problem.

-- Correlates a profile with its Stripe customer, so the webhook can find the
-- right user from subscription events that only carry a Stripe customer id
-- (not a Supabase user id).
alter table profiles add column stripe_customer_id text unique;
