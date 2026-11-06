-- The earned share a PASSED decision settles on (policy-2 pay schedule, src/lib/review/policy.ts): the
-- release captures share_bps of the amount with final_capture, and PayPal releases the rest of the hold.
-- Null on milestones decided before this, which capture the full amount as they always did.

alter table milestones add column share_bps integer check (share_bps between 1 and 10000);
