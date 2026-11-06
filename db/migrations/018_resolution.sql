-- The resolution desk (src/lib/resolution/, V2_PLAN §3.G): either side may lock a decision for a named
-- arbitrator by funding a small fee hold; the other side has 72 h to match it. The arbitrator's signed award
-- is the only input to settlement. One lock per milestone.

create table locks (
  id                bigserial primary key,
  milestone_id      uuid not null unique references milestones (id) on delete cascade,
  locked_by         text not null check (locked_by in ('client', 'worker')),
  prior_state       text not null check (prior_state in ('PASSED', 'HUMAN_CHECK')),
  prior_share_bps   integer,
  fee_cents         integer not null check (fee_cents > 0),
  -- opening: the locker's fee hold isn't authorized yet · locked: waiting for the other side to match ·
  -- arbitration: with the arbitrator · awarded: signed award, fees settling · closed: all settled ·
  -- stood: not matched in time, or the arbitrator was silent: the earlier decision stands · ended: the
  -- milestone's hold ended (expired, voided) or the lock lapsed before it took effect
  status            text not null default 'opening' check (status in ('opening', 'locked', 'arbitration', 'awarded', 'closed', 'stood', 'ended')),
  statements        jsonb not null default '{}',   -- { client?: text, worker?: text }, up to 2,000 characters each
  locked_at         timestamptz,
  match_by          timestamptz,
  rule_by           timestamptz,
  pack              jsonb,                         -- the evidence pack (pack.ts); its hash goes in the proof chain
  pack_hash         text,
  draft             jsonb,                         -- the AI's draft award: shown only, never settles anything
  draft_error       text,
  award             jsonb,                         -- { shareBps, reasons, statement, signature, keyId, at }
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- A party's fee hold: a PayPal authorization of fee_cents, captured from the side the award goes against
-- and paid out to the arbitrator, voided for the other side.
create table fee_holds (
  id                 bigserial primary key,
  milestone_id       uuid not null references milestones (id) on delete cascade,
  role               text not null check (role in ('client', 'worker')),
  order_id           text,
  approve_url        text,
  authorization_id   text,
  authorized_cents   integer,
  status             text not null default 'open' check (status in ('open', 'authorized', 'captured', 'voided')),
  capture_id         text,
  captured_cents     integer,
  payout_batch_id    text,
  payout_cents       integer,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (milestone_id, role)
);
