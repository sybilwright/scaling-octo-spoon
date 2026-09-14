# Adding User Accounts — Implementation Spec

Goal: turn this from "one shared tool with local save/load" into "an app where each person logs in and sees only their own data." This doc is meant to be handed to Claude Code as a starting checklist.

## Why Supabase

Supabase gives you a hosted Postgres database + authentication + a JS client library, with a free tier that's plenty for this. It avoids building a custom backend/server — the browser talks to Supabase directly, and Supabase enforces "you can only touch your own data" via a database-level security rule (Row Level Security), not application code you have to get right yourself.

## 1. Supabase project setup

- Create a free project at supabase.com.
- Under Authentication → Providers, enable **Email** (password-based) to start. Google/Microsoft sign-in can be added later the same way if wanted.
- Grab the project URL and anon/public API key from Project Settings → API — these go in the app (the anon key is safe to expose client-side; it only grants what your RLS policies allow).

## 2. Database schema

One table is enough to start:

```sql
create table planner_state (
  user_id uuid references auth.users(id) primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table planner_state enable row level security;

create policy "Users can read their own state"
  on planner_state for select
  using (auth.uid() = user_id);

create policy "Users can write their own state"
  on planner_state for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own state"
  on planner_state for update
  using (auth.uid() = user_id);
```

`data` holds the exact same JSON shape the tool already builds in `serializePlannerState()` — this schema change is small on purpose. One row per user, the whole planner state as one JSON blob, same as the current save/load system, just relocated.

## 3. Auth screen

Add a simple gate in front of the planner:

- Not logged in → show a small login/signup form (email + password, a toggle between the two modes, and a "forgot password" link — Supabase's `resetPasswordForEmail` handles the email flow).
- Logged in → render `<DayOffPayPlanner />` as it exists today, unchanged.

Supabase's client SDK covers all of this directly:
```js
const { data, error } = await supabase.auth.signUp({ email, password });
const { data, error } = await supabase.auth.signInWithPassword({ email, password });
await supabase.auth.signOut();
supabase.auth.onAuthStateChange((event, session) => { /* update logged-in state */ });
```

## 4. What changes inside the existing component

This is the part that matters most for keeping the rest of the app untouched. Three functions currently talk to `window.storage` — swap only these:

- **`savePlannerState()`** — currently `window.storage.set(STORAGE_KEY, JSON.stringify(serializePlannerState()))`. Becomes an upsert into `planner_state` for the current user:
  ```js
  await supabase.from('planner_state').upsert({
    user_id: session.user.id,
    data: serializePlannerState(),
    updated_at: new Date().toISOString(),
  });
  ```
- **`loadPlannerState()`** — currently `window.storage.get(STORAGE_KEY)`. Becomes:
  ```js
  const { data } = await supabase.from('planner_state').select('data').eq('user_id', session.user.id).single();
  ```
- **`clearSavedState()`** — currently `window.storage.delete(STORAGE_KEY)`. Becomes a delete or an upsert with `data: {}`.

Nothing else in the ~3000-line component needs to change. `serializePlannerState()` and the `if (d.xxx) setXxx(...)` restore logic are already storage-agnostic — they just build/read a plain JS object. The 30+ pieces of state that get saved and restored today keep working exactly as they are; only *where* that object lives changes.

## 5. Suggested build order (for Claude Code)

1. Set up the Supabase project, table, and RLS policies (step 1-2 above) — do this first and confirm it works with Supabase's own dashboard before touching the app.
2. Install `@supabase/supabase-js`, set up the client with your project URL/key (as environment variables, not hardcoded).
3. Build the login/signup screen as a separate, simple component. Get auth working end-to-end (signup, login, logout, session persistence on refresh) *before* touching the planner at all.
4. Wire the three save/load functions to Supabase as described in step 4.
5. Test the full loop: sign up as a test user, make some changes in the planner, refresh the page, confirm the same data loads back. Then create a second test account and confirm it sees a *blank* planner, not the first user's data — this is the check that actually proves the security policy is working, not just that saving/loading works.

## 6. Things to decide before starting

- **Hosting**: this stops being a single downloadable file once it needs a live Supabase connection and (ideally) hidden API keys. Vercel or Netlify are natural fits for a React app like this — both have free tiers and deploy straight from a GitHub repo.
- **Multiple bases/rates/etc.**: right now the tool assumes one person, one base, one hourly rate. If this is ever meant for more than one person's actual use, decide whether that's still true per-account (probably yes, keep it simple) or whether some things (like a shared Reserve Grid or Open Time board) should eventually be shared across users rather than pasted individually by each person — that's a bigger design question, not necessary to solve before shipping logins.
- **Migrating existing data**: if there's an existing save in the standalone HTML's `localStorage` (or a prior Claude.ai artifact save) that should carry over, that's a one-time manual step — export it, log in as the right user, import it — rather than something the app needs to automate.

## 7. Building in the subscription gate now (so beta → paid isn't a retrofit)

You mentioned this will eventually be subscription-based, with everyone — beta testers included — getting a free month before payment starts. The right move is to build the *access check* into the app from day one — during beta it always passes, but the gate itself already exists, so turning on billing later means changing values per user, not restructuring how login works.

### Add a `profiles` table (separate from `planner_state`)

Keep "who is this user and what's their access level" separate from "what's their saved schedule data" — cleaner, and it means access checks never have to load someone's entire schedule data just to decide whether to show it to them.

```sql
create table profiles (
  id uuid references auth.users(id) primary key,
  email text,
  subscription_status text not null default 'beta', -- 'beta' | 'trialing' | 'active' | 'expired' | 'canceled'
  trial_ends_at timestamptz, -- only meaningful when subscription_status = 'trialing'
  created_at timestamptz not null default now()
);

-- auto-create a profile row whenever someone signs up
create function public.handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table profiles enable row level security;
create policy "Users can read their own profile" on profiles for select using (auth.uid() = id);
-- Deliberately NO update policy here for the client. subscription_status and trial_ends_at must only
-- ever be changed server-side (by a billing webhook or the cutover script below), never directly from
-- the browser — otherwise anyone could just flip their own access on via the browser dev tools.
```

### Gate the app on access, not just login — and check the trial date live

Right now the plan is "logged in → show the planner." Change that to "logged in AND has access → show the planner; logged in but no access → show an upgrade/subscribe screen instead." A `'trialing'` status only counts as access if the trial hasn't actually run out yet, so that has to be checked against the clock, not just the status string:

```js
function hasAccess(profile) {
  if (!profile) return false;
  if (profile.subscription_status === 'beta') return true;
  if (profile.subscription_status === 'active') return true;
  if (profile.subscription_status === 'trialing') {
    return profile.trial_ends_at && new Date(profile.trial_ends_at) > new Date();
  }
  return false; // 'expired', 'canceled', or anything else
}
```

Checking the date live like this — instead of relying on some background job to flip `'trialing'` to `'expired'` the moment a trial ends — means there's no cron job or scheduled task to build and maintain. The status only ever gets written by a webhook or the one-time cutover script; whether it currently *grants* access is always computed fresh, every time, from the actual current time. Simpler and can't silently drift out of sync.

During beta, every new signup gets `subscription_status = 'beta'` automatically (the table default), so `hasAccess` always returns true and nobody notices the gate is there. That's the point — it's live infrastructure from day one, just invisible until you need it.

### When you actually turn on billing later

1. Add a real checkout flow (Stripe is the standard choice) and a webhook (a small serverless function — a Vercel API route or a Supabase Edge Function both work) that sets `subscription_status = 'active'` when a payment succeeds, and `'expired'`/`'canceled'` when one fails or is canceled.
2. **Decision made**: beta testers will be asked to subscribe once billing launches, and everyone — beta testers and brand-new signups alike — gets a free trial before any payment is required, running on this exact rule: **sign up on or before the 17th of a month, and the trial runs through the end of that same month; sign up after the 17th, and it runs through the end of the following month instead.** This guarantees nobody ever gets a trial that abruptly ends in the middle of a month or with only a few days of runway — a late-month signup rolls forward into a full extra month instead. Two confirming examples: signing up February 1st gives free access through February 28th (the 1st is before the 17th, so it's covered through the end of that same month); signing up January 26th *also* gives free access through February 28th (the 26th is past the 17th, so it rolls to the end of the following month instead of ending January 31st with only 5 days of trial).

   ```js
   function computeTrialEnd(signupDate) {
     const day = signupDate.getDate();
     let year = signupDate.getFullYear();
     let month = signupDate.getMonth(); // 0-indexed
     if (day > 17) {
       month += 1;
       if (month > 11) { month = 0; year += 1; }
     }
     // Day 0 of "next month" in JS Date is the last day of the target month.
     const lastDay = new Date(year, month + 1, 0);
     lastDay.setHours(23, 59, 59, 999);
     return lastDay;
   }
   ```

   At cutover, apply this per existing beta user based on *today's* date (since that's effectively their trial "signup" moment) rather than a flat offset:
   ```sql
   -- Run from application code (or a one-off script) rather than pure SQL, since the day-17 branching
   -- reads far more clearly in JS than as a single SQL date expression. For each beta user:
   update profiles
   set subscription_status = 'trialing', trial_ends_at = $1  -- computeTrialEnd(new Date()) from above
   where subscription_status = 'beta';
   ```
   From that point on, new signups should get the same treatment at signup time — call `computeTrialEnd(new Date())` right after signup (in application code, not the database trigger, since this branching logic is awkward to express as a single SQL expression) and write the result to `trial_ends_at` along with `subscription_status = 'trialing'`. Once someone's `trial_ends_at` passes with no active subscription behind it, `hasAccess` starts returning false on its own — no separate step needed to "end" a trial. Worth sending beta users a heads-up (email) before running the cutover, and probably again a few days before their individual trial actually ends, so nobody is surprised mid-schedule-planning.

The app code doesn't change at cutover time — only which values the rows contain, and only the signup flow needs a small update going forward. That's the whole benefit of building the gate now.

## 8. What NOT to change

Everything documented in `CLAUDE.md` about the tool's actual scheduling logic — the SDO math, swap/trade mechanics, the parsers, the preferences — is unaffected by any of this. Accounts are purely about *where the save data lives and who can see it*, not how the tool works. Resist the urge to refactor scheduling logic while doing this; keep it a clean, isolated change.
