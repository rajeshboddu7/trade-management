-- Run this once in the Supabase SQL Editor for your project.
-- Creates one table that mirrors the app's existing localStorage keys
-- (trades / positions / prefs), scoped per user via Row Level Security.

create table if not exists app_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table app_state enable row level security;

create policy "Users can manage their own state"
  on app_state
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
