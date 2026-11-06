-- The platform API (V2_PLAN §3.J): signed outbound webhooks, policy hooks that can only block, and
-- Idempotency-Key on our own POSTs.

alter table platforms
  add column webhook_url     text,
  add column webhook_secret  text,                       -- the HMAC key, shown to the platform once
  add column hooks           jsonb not null default '{}'; -- platform/hooks.ts: limits it sets on itself

-- The outbox: one row per audit event of a platform's milestone, written in the same transaction as the
-- audit row, delivered by the tick with retries (platform/outbound.ts).
create table outbound_events (
  id            bigserial primary key,
  platform_id   uuid not null references platforms (id) on delete cascade,
  milestone_id  uuid references milestones (id) on delete cascade,
  event         text not null,
  payload       jsonb not null,
  attempts      integer not null default 0,
  next_at       timestamptz not null default now(),
  delivered_at  timestamptz,
  given_up_at   timestamptz,
  last_status   integer,
  last_error    text,
  created_at    timestamptz not null default now()
);
create index outbound_events_due on outbound_events (next_at) where delivered_at is null and given_up_at is null;

-- A POST with an Idempotency-Key: the first response is stored and replayed for 24 hours (platform/idempotency.ts).
create table idempotency_keys (
  scope         text not null,
  key           text not null,
  request_hash  text not null,
  status        integer,               -- null while the first request is still running
  response      jsonb,
  created_at    timestamptz not null default now(),
  primary key (scope, key)
);
