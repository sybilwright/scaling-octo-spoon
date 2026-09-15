-- Run in the Supabase SQL editor. Adds:
--  1. An is_admin flag on profiles (defaults false -- you set your own row
--     to true manually, once, after running this).
--  2. A monthly_stats table: one row per user per bid month, holding the
--     confirmed SDO bonus hours/dollars and total confirmed credit hours
--     the tool computed for them that month. Upserted on every save, so it
--     always reflects the latest numbers for that bid month -- not a
--     running counter, a current snapshot.

alter table profiles add column is_admin boolean not null default false;

create table monthly_stats (
  user_id uuid references auth.users(id) not null,
  email text, -- set by the client from its own session at write time, for
              -- display only -- profiles.email isn't readable cross-user,
              -- this avoids needing a broader RLS grant just to show who's who.
  bid_year integer not null,
  bid_month integer not null, -- 1-12
  hourly_rate numeric,
  confirmed_bonus_hours numeric not null default 0,
  confirmed_bonus_dollars numeric not null default 0,
  total_confirmed_credit_hours numeric not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, bid_year, bid_month)
);

alter table monthly_stats enable row level security;

create policy "Users can read their own monthly stats"
  on monthly_stats for select
  using (auth.uid() = user_id);

create policy "Users can insert their own monthly stats"
  on monthly_stats for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own monthly stats"
  on monthly_stats for update
  using (auth.uid() = user_id);

-- Lets an admin (you) read every user's rows, on top of the self-only
-- policy above -- Postgres ORs multiple SELECT policies together.
create policy "Admins can read all monthly stats"
  on monthly_stats for select
  using (exists (select 1 from profiles where id = auth.uid() and is_admin));

-- After running this file, make your own account an admin (replace the
-- email), e.g.:
--   update profiles set is_admin = true where email = 'avesallen19@gmail.com';
