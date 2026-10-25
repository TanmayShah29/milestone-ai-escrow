-- Privacy: links expire after a milestone closes, personal data can be erased, and raw webhook
-- payloads are pruned once PayPal can no longer redeliver them (src/lib/privacy.ts).

alter table milestones
  add column closed_at  timestamptz,
  add column erased_at  timestamptz;

update milestones set closed_at = updated_at where state in ('PAID_OUT', 'CANCELLED');

-- The event id stays (a redelivery is still recognised); only the payload is emptied.
alter table webhook_events add column pruned_at timestamptz;

create index webhook_events_unpruned_idx on webhook_events (received_at) where pruned_at is null;
