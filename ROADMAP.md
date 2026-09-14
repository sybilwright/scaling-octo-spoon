# SDO Schedule Planner — Handoff Roadmap

This is the entry point. Read this first, then follow the links below in order. Everything here reflects decisions already made — nothing in this doc is still open for debate except where explicitly marked.

## What's in this handoff

| File | What it is |
|---|---|
| `day-off-pay-planner.jsx` | The actual tool. Single React component, feature-complete for solo (non-account) use. |
| `sdo-schedule-planner.html` | The same tool, pre-compiled to plain JS and wrapped for standalone browser use (no build step, no install). Kept in sync with the `.jsx` — see the regeneration steps in `CLAUDE.md`. |
| `CLAUDE.md` | Everything about how the tool itself works — the SDO/pay math, the swap/trade/drop mechanics, the parsers, the architectural patterns, and a running list of real bugs that were found and fixed (so they don't get reintroduced). Read this before changing any scheduling logic. |
| `adding-user-accounts.md` | The full spec for turning this into a multi-user, subscription-gated app: database schema, auth, the access-gate pattern, and the exact trial-length rule. Read this before touching accounts/billing. |
| `video-tutorial-script.md` | A narration script for a product walkthrough video, if that's still wanted — unrelated to the build work below. |

## Current state

The tool itself is done and tested — every feature has been verified against real pasted FLICA data or hand-constructed edge cases before shipping, not just eyeballed. It works today as a single-user, no-login artifact (`.jsx` in Claude, or the standalone `.html` anywhere else), saving progress to `localStorage`/artifact storage.

**Nothing about the scheduling logic needs to change for the work below.** Accounts and billing are additive — they change *where the save data lives and who can see it*, not how SDO, swaps, trades, or any recommendation is computed.

## The plan, in order

### Phase 1 — Accounts (do this first)
Follow `adding-user-accounts.md` sections 1–4:
1. Create the Supabase project, `planner_state` table, and its row-level security policies.
2. Build a login/signup screen that gates the existing `<DayOffPayPlanner />` component.
3. Swap the three storage functions (`savePlannerState`, `loadPlannerState`, `clearSavedState`) from `window.storage` to Supabase calls. Nothing else in the component changes.
4. Test with two separate accounts, not one — confirm account B never sees account A's data. This is the check that actually proves the security policy works.

### Phase 2 — Subscription gate (build this at the same time as Phase 1, not after)
Follow `adding-user-accounts.md` section 7. This is infrastructure that should exist from day one of real accounts, even though it stays invisible during beta:
1. Add the `profiles` table (`subscription_status`, `trial_ends_at`) alongside `planner_state`.
2. Every signup gets `subscription_status = 'beta'` by default — free, unlimited, for now.
3. Gate the app on `hasAccess(profile)`, not just "logged in." During beta this always returns true, so it's invisible — but it's real and live from the start.

### Phase 3 — Hosting
Once accounts work, the tool can no longer be a single downloadable file — it needs a live Supabase connection. Deploy to Vercel or Netlify (either has a free tier and deploys straight from a GitHub repo). This is also the point where the `.jsx`/`.html` pair stops being the source of truth — the deployed repo becomes it. Bring the repo back to a Claude conversation (or keep working in Claude Code) for any further changes rather than the standalone files from this point forward.

### Phase 4 — Billing (later, when ready to actually launch paid access)
Follow `adding-user-accounts.md` section 7, "When you actually turn on billing later." Concretely, in order:
1. Add Stripe checkout + a webhook that sets `subscription_status = 'active'`/`'expired'`/`'canceled'` on payment events.
2. Run the one-time cutover: every existing `'beta'` user moves to `'trialing'` with `trial_ends_at` computed by the exact rule below — **not** grandfathered, **not** cut off immediately.
3. Wire the same trial calculation into the signup flow for all new users going forward.
4. Email beta users ahead of the cutover, and again a few days before their individual trial ends.

## Decisions already made (don't relitigate these)

- **Beta users will be asked to subscribe.** No permanent free grandfathering.
- **Trial length is not a flat day-count.** The rule: sign up on or before the 17th of a month → free through the end of that same month. Sign up after the 17th → free through the end of the *following* month instead. This guarantees nobody's trial ends abruptly mid-month or with only a few days left — a late-month signup rolls forward into a full extra month. The exact `computeTrialEnd()` function (tested against month/year rollover and leap years) is in `adding-user-accounts.md` section 7.
- **Trial validity is checked live against the clock**, not flipped by a background job the moment it expires. No cron/scheduled task needed — `hasAccess` just compares `trial_ends_at` to `now()` every time.
- **`subscription_status`/`trial_ends_at` are never writable by the client** — only by a server-side webhook or an admin script. This is enforced at the database level (no RLS update policy for those columns), not just left to application code to get right.

## What NOT to do

- Don't refactor the scheduling logic while doing any of the above — it's tested and working. If Phase 1–4 work surfaces a genuine bug in the scheduler itself, fix that as its own isolated change and note it in `CLAUDE.md`, don't bundle it into the accounts work.
- Don't build a custom auth/backend server. Supabase covers auth + database; that combination is the whole point of keeping this simple.
- Don't set up a cron job for trial expiry. The live-check approach in `adding-user-accounts.md` deliberately avoids needing one.
