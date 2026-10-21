-- Objections: when the client objected, so the second review and the 72-hour rule have a clock.
-- (paypal_dispute_id already exists from 001_init.)
alter table milestones
  add column contested_at  timestamptz;
