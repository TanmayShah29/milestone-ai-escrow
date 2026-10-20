-- Every verified PayPal webhook, keyed by PayPal's event id so a redelivery is a no-op (money rule 6).
create table webhook_events (
  id            text primary key,
  event_type    text not null,
  resource_id   text,
  milestone_id  uuid references milestones(id),
  status        text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  error         text,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

create index webhook_events_milestone_idx on webhook_events (milestone_id, received_at);
