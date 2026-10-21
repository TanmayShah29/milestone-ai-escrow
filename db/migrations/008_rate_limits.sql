-- Rate limits for the public demo: one row per counted request. The key names the limit and who it
-- counts (a sha256 of the caller's IP, or a milestone id), never a raw IP. Old rows are pruned as we go.
create table rate_events (
  key         text not null,
  created_at  timestamptz not null default now()
);

create index rate_events_key_idx on rate_events (key, created_at);
