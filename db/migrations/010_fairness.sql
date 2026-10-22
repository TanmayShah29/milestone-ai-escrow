-- Fairness and money lifecycle: reasons the worker can read, the actual fees behind a payout, and when a
-- hold ended without a capture (voided or expired).
alter table milestones
  add column objection_reason  text,
  add column changes_reason    text,
  add column paypal_fee_cents  integer,
  add column payout_fee_cents  integer,
  add column hold_ended_at     timestamptz;
