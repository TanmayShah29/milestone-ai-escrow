-- When the milestone last entered HUMAN_CHECK. After an objection (contested_at set), the client has
-- 72 hours from this moment to decide; then the money releases to the worker (see tick in review/run.ts).
alter table milestones
  add column human_check_at  timestamptz;

update milestones set human_check_at = updated_at where state = 'HUMAN_CHECK';
