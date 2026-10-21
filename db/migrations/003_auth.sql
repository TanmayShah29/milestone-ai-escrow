-- Access control. Each milestone has two capability tokens (client, worker); only their SHA-256
-- hashes are stored. Platforms (marketplaces, AI agents) call the API with a key, also stored hashed.

create table platforms (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  api_key_hash  text not null unique,
  created_at    timestamptz not null default now()
);

alter table milestones
  add column platform_id        uuid references platforms(id),
  add column client_token_hash  text,
  add column worker_token_hash  text;

create index milestones_platform_idx on milestones (platform_id, created_at);
