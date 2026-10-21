-- The contract: AI-drafted acceptance criteria (with test code where testable), fingerprinted by a
-- SHA-256 hash that each side signs. Funding requires both signatures on the current hash.
alter table milestones
  add column repo                text,
  add column stack               text,
  add column criteria            jsonb,
  add column criteria_hash       text,
  add column criteria_model      text,
  add column client_signed_hash  text,
  add column client_signed_at    timestamptz,
  add column worker_signed_hash  text,
  add column worker_signed_at    timestamptz;

create index milestones_criteria_hash_idx on milestones (criteria_hash);

-- Every model call, for the daily free-tier budget and the status banner.
create table ai_calls (
  id          bigserial primary key,
  purpose     text not null,
  model       text not null,
  ok          boolean not null,
  status      integer,
  error       text,
  latency_ms  integer,
  created_at  timestamptz not null default now()
);

create index ai_calls_created_idx on ai_calls (created_at);
