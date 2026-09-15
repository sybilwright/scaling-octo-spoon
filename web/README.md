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

1. In Stripe, create a recurring **Price** for the subscription. Copy its id
   (`price_...`).
2. Run `../supabase/billing_schema.sql` in the Supabase SQL editor (adds a
   `stripe_customer_id` column to `profiles`).
3. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) locally,
   then from the repo root:
   ```
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_PRICE_ID=price_... APP_URL=https://sdoscheduletool.vercel.app
   supabase functions deploy create-checkout-session
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
   (`--no-verify-jwt` on the webhook only — Stripe calls it directly, not
   through a logged-in user, so it can't send a Supabase auth token.)
4. In the Stripe dashboard, add a webhook endpoint pointing at
   `https://<project-ref>.functions.supabase.co/stripe-webhook`, subscribed
   to `checkout.session.completed`, `invoice.payment_succeeded`,
   `invoice.payment_failed`, and `customer.subscription.deleted`. Copy its
   signing secret (`whsec_...`) and set it too:
   ```
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   ```
5. The app already has a **Subscribe** button (shown whenever `hasAccess`
   returns false) wired to call `create-checkout-session` and redirect to
   Stripe Checkout — nothing else to build there.
6. When ready to actually cut everyone over from unlimited beta access to a
   real trial, run `../scripts/cutover-to-trialing.mjs` once (see that file
   for usage). After that, update the `handle_new_user` trigger (or add an
   edge function called right after signup) so *new* signups also get
   `trialing` + a computed `trial_ends_at` instead of defaulting to `beta` —
   deliberately not done yet, so beta access stays unlimited until you
   decide to make that change.
