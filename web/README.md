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

## What's not here yet

Billing (Stripe checkout + webhook) and the beta→trial cutover script —
that's Phase 4 in `../ROADMAP.md`, deliberately later. Every new signup
currently gets `subscription_status = 'beta'`, so `hasAccess` always returns
true and the upgrade screen never shows.
