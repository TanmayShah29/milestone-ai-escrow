-- Trusted-runner runs (src/lib/review/runner.ts): one per milestone and review (the first review of a
-- commit, or a second review after an objection). The nonce is random and goes into the signed results,
-- so a result can't be replayed from another run.

create table runner_runs (
  id            bigserial primary key,
  milestone_id  uuid not null references milestones (id) on delete cascade,
  run_key       text not null,                -- head sha, or "<sha>:second:<ms>" for an objection's review
  head_sha      text not null,
  nonce         text not null unique,
  status        text not null default 'dispatched' check (status in ('dispatched', 'done', 'failed')),
  run_id        bigint,
  results       jsonb,                        -- the attested results.json, after every check passed
  rekor_index   bigint,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (milestone_id, run_key)
);
