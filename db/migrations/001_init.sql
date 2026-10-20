-- Milestones, money-action claims and the audit log.
-- Amounts are integer cents (money rule 7). Every PayPal id lives on the milestone row (rule 4).

create table milestones (
  id                        uuid primary key default gen_random_uuid(),
  title                     text not null,
  brief                     text not null default '',
  amount_cents              integer not null check (amount_cents > 0),
  currency                  text not null default 'USD' check (currency = 'USD'),
  client_email              text,
  freelancer_email          text not null,
  state                     text not null default 'DRAFT',
  pr_url                    text,

  paypal_order_id           text unique,
  approve_url               text,
  paypal_authorization_id   text,
  authorized_cents          integer,
  authorization_expires_at  timestamptz,
  reauth_count              integer not null default 0,
  paypal_capture_id         text,
  capture_status            text,
  captured_cents            integer,
  fee_cents                 integer,
  payout_cents              integer,
  paypal_payout_batch_id    text,
  paypal_payout_item_id     text,
  payout_status             text,
  paypal_refund_id          text,
  paypal_dispute_id         text,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- One row per attempted money-moving write. The row is the claim: it is inserted before the PayPal
-- call, and the partial unique index stops a second live claim for the same (milestone, action).
-- A refused call releases its claim by moving it to 'failed', so a later attempt can claim again.
create table money_actions (
  id            bigserial primary key,
  milestone_id  uuid not null references milestones(id),
  action        text not null,
  attempt       integer not null,
  request_id    text not null unique,
  status        text not null check (status in ('pending', 'succeeded', 'failed', 'unknown')),
  paypal_id     text,
  error         jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index money_actions_live_uq
  on money_actions (milestone_id, action)
  where status in ('pending', 'succeeded', 'unknown');

create table audit_log (
  id               bigserial primary key,
  milestone_id     uuid references milestones(id),
  actor            text not null,
  event            text not null,
  from_state       text,
  to_state         text,
  paypal_id        text,
  paypal_debug_id  text,
  detail           jsonb,
  created_at       timestamptz not null default now()
);

create index audit_log_milestone_idx on audit_log (milestone_id, created_at);
