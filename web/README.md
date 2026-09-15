# SDO Schedule Planner — web app

The accounts-enabled version of `day-off-pay-planner.jsx`, gated behind Supabase
auth and a subscription check (see `../adding-user-accounts.md`). Scheduling
logic is unchanged from the standalone `.jsx`/`.html` pair at the repo root —
only where save data lives and who can see it is different.

## Setup

1. Create a free project at [supabase.com](https://supabase.com).
2. In the Supabase SQL editor, run `../supabase/schema.sql` to create the
   `planner_state` and `profiles` tables, their RLS policies, and the
   new-user trigger.
3. Under Authentication → Providers, enable **Email**.
4. Copy `.env.example` to `.env` and fill in your project's URL and anon key
   (Project Settings → API).
5. `npm install`
6. `npm run dev`

## What's here

- `src/supabaseClient.js` — Supabase client, reads `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` from the environment.
- `src/Auth.jsx` — email/password login + signup + forgot-password form.
- `src/access.js` — `hasAccess(profile)`, the live trial/subscription check
  from `adding-user-accounts.md` section 7.
- `src/App.jsx` — the gate: signed out → `Auth`; signed in but no access →
  an upgrade screen; signed in with access → `DayOffPayPlanner`.
- `src/DayOffPayPlanner.jsx` — the planner itself. Copied from the repo
  root's `.jsx`; the only changes are the three storage functions
  (`savePlannerState`/`loadPlannerState`/`clearSavedState`), which now read
  and write `planner_state` in Supabase instead of `window.storage`.

## Billing (Phase 4 — turning it on)

The plumbing is built (see `../supabase/functions/`), but nothing is wired
up to real Stripe credentials yet, and every signup still defaults to
`subscription_status = 'beta'` (unlimited free access). To actually flip
billing on:

Two ways to deploy the two functions in `../supabase/functions/`: the
Supabase CLI (faster if you have a terminal), or the dashboard's built-in
function editor (no terminal needed — each function file is written to be
self-contained/copy-pasteable for exactly this). Dashboard steps:

1. In Stripe, create a recurring **Price** for the subscription. Copy its id
   (`price_...`).
2. Run `../supabase/billing_schema.sql` in the Supabase SQL editor (adds a
   `stripe_customer_id` column to `profiles`).
3. In the Supabase dashboard, go to **Edge Functions** → **Deploy a new
   function**. Name it exactly `create-checkout-session`, paste in the full
   contents of `../supabase/functions/create-checkout-session/index.ts`, and
   deploy.
4. Repeat for `stripe-webhook`, pasting
   `../supabase/functions/stripe-webhook/index.ts`. After deploying, open
   that function's settings and turn **off** "Enforce JWT Verification" —
   Stripe calls this directly, not through a logged-in user, so it can't
   send a Supabase auth token.
5. Still in Edge Functions, find **Manage secrets** (or **Secrets**) and add:
   - `STRIPE_SECRET_KEY` — from the Stripe dashboard
   - `STRIPE_PRICE_ID` — the price id from step 1
   - `APP_URL` — `https://sdoscheduletool.vercel.app`
   (`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are
   already available automatically — don't set those.)
6. Each deployed function has its own URL shown in the dashboard, something
   like `https://<project-ref>.functions.supabase.co/stripe-webhook`. In the
   Stripe dashboard, add a webhook endpoint pointing at that URL, subscribed
   to `checkout.session.completed`, `invoice.payment_succeeded`,
   `invoice.payment_failed`, and `customer.subscription.deleted`. Stripe
   shows you a signing secret (`whsec_...`) for it — add that as one more
   secret, `STRIPE_WEBHOOK_SECRET`, back in step 5's secrets panel.
7. The app already has a **Subscribe** button (shown whenever `hasAccess`
   returns false) wired to call `create-checkout-session` and redirect to
   Stripe Checkout — nothing else to build there.
8. When ready to actually cut everyone over from unlimited beta access to a
   real trial, run `../scripts/cutover-to-trialing.mjs` once (see that file
   for usage). After that, update the `handle_new_user` trigger (or add an
   edge function called right after signup) so *new* signups also get
   `trialing` + a computed `trial_ends_at` instead of defaulting to `beta` —
   deliberately not done yet, so beta access stays unlimited until you
   decide to make that change.
