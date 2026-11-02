-- Judge "run it live": one real run (hold, PR, CI, capture, payout) per row (src/lib/demo-live.ts).

create table live_runs (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('honest', 'cheat')),
  milestone_id uuid not null references milestones (id) on delete cascade,
  pr_url       text,
  status       text not null default 'running' check (status in ('running', 'done', 'failed')),
  outcome      text check (outcome in ('paid', 'caught', 'person')),
  error        text,
  failures     int not null default 0,
  advanced_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- A run reuses its prepared branch, and GitHub allows one open PR per branch: one running run per kind.
create unique index live_runs_one_running_idx on live_runs (kind) where status = 'running';
create index live_runs_created_idx on live_runs (created_at);
