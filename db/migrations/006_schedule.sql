-- Scheduling for the Gantt: a due date for the work, and an optional predecessor milestone (payment
-- tranches: this milestone's work waits on the previous one being paid out).
alter table milestones
  add column due_at              timestamptz not null default (now() + interval '7 days'),
  add column after_milestone_id  uuid references milestones(id);
