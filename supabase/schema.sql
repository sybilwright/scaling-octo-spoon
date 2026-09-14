-- Run this in the Supabase SQL editor for your project.
-- See adding-user-accounts.md sections 2 and 7 for the full explanation.

-- One row per user, the whole planner state as one JSON blob.
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

-- Who this user is and what their access level is, kept separate from
-- planner_state so an access check never has to load someone's schedule data.
create table profiles (
  id uuid references auth.users(id) primary key,
  email text,
  subscription_status text not null default 'beta', -- 'beta' | 'trialing' | 'active' | 'expired' | 'canceled'
  trial_ends_at timestamptz, -- only meaningful when subscription_status = 'trialing'
  created_at timestamptz not null default now()
);

-- Auto-create a profile row whenever someone signs up.
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
-- ever be changed server-side (by a billing webhook or the cutover script), never directly from the
-- browser -- otherwise anyone could flip their own access on via dev tools.
