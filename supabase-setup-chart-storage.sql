-- One-time setup for trade-chart screenshots (daily-timeframe entry/exit charts).
-- Run this in the Supabase SQL Editor (same place you ran the earlier setup scripts).
--
-- Storage layout: one PNG per trade at "<user_id>/<trade_id>.png". The bucket is
-- private (not public) -- charts are personal trading data, so the app reads them
-- back via short-lived signed URLs rather than a permanent public link.

insert into storage.buckets (id, name, public)
values ('trade-charts', 'trade-charts', false)
on conflict (id) do nothing;

-- Mirrors the app_state RLS pattern: a user can only touch files under their own
-- user_id folder. storage.foldername(name) splits "user_id/trade_id.png" into
-- ['user_id', 'trade_id.png'], so [1] is the user_id segment.
create policy "Users manage their own trade chart files"
on storage.objects for all
using (
  bucket_id = 'trade-charts'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'trade-charts'
  and (storage.foldername(name))[1] = auth.uid()::text
);
