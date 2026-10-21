-- One review per (milestone, commit): a commit is never reviewed twice. While CI is still running the row
-- is 'pending'; once the verdict is in it is 'done' and the decision is final for that commit.
create table reviews (
  id            bigserial primary key,
  milestone_id  uuid not null references milestones(id),
  head_sha      text not null,
  status        text not null check (status in ('pending', 'done')),
  verdict       jsonb,
  decision      text check (decision in ('PASSED', 'CHANGES_REQUESTED', 'HUMAN_CHECK')),
  reasons       jsonb,
  model         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (milestone_id, head_sha)
);

alter table milestones
  add column verifier          text not null default 'code_pr' check (verifier in ('code_pr', 'rubric_text')),
  add column deliverable_text  text,
  add column release_after     timestamptz;
