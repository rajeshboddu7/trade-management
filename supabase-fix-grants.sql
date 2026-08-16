-- Fixes "permission denied for table app_state": creating a table via the SQL
-- Editor doesn't auto-grant base table access the way the dashboard UI does.
-- Row Level Security (already set up) controls which ROWS you can touch;
-- this grant controls whether the authenticated role can touch the table at all.

grant select, insert, update, delete on table app_state to authenticated;
