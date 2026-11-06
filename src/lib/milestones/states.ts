// Milestone states and the transitions code may make (docs/MILESTONE_PLAN.md).

export const STATES = [
  "DRAFT",
  "AGREED",
  "FUNDED",
  "SUBMITTED",
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "HUMAN_CHECK",
  "PASSED",
  "CONTESTED",
  "RELEASED",
  "PAID_OUT",
  "PAYOUT_FAILED",
  "DISPUTE",
  "CANCELLED",
  // The resolution desk (resolution/desk.ts): a decision locked for the arbitrator by a funded fee hold.
  "LOCKED",
  "ARBITRATION",
  // An open bounty (bounties/bounty.ts): funded from a mandate, waiting for a worker to claim it.
  "OFFERED",
] as const;

export type MilestoneState = (typeof STATES)[number];

// CANCELLED from every pre-capture hold state: the client may void from FUNDED, CHANGES_REQUESTED and
// HUMAN_CHECK (flow.ts cancelHold checks which), and a hold PayPal voided or expired ends the milestone
// from any of them (flow.ts endHoldIfGone). Never after a capture.
const TRANSITIONS: Record<MilestoneState, readonly MilestoneState[]> = {
  DRAFT: ["AGREED", "CANCELLED", "OFFERED"],
  AGREED: ["FUNDED", "CANCELLED"],
  FUNDED: ["SUBMITTED", "CANCELLED", "OFFERED"], // OFFERED: a bounty claim lapsed with no work submitted
  SUBMITTED: ["IN_REVIEW", "PASSED", "CANCELLED"], // PASSED directly only via the dev route until the reviewer exists
  IN_REVIEW: ["CHANGES_REQUESTED", "HUMAN_CHECK", "PASSED", "CANCELLED"],
  CHANGES_REQUESTED: ["SUBMITTED", "CANCELLED"],
  HUMAN_CHECK: ["PASSED", "CHANGES_REQUESTED", "CANCELLED", "LOCKED"],
  PASSED: ["RELEASED", "CONTESTED", "CANCELLED", "LOCKED"],
  // One second review on the same commit: pass → back to PASSED with release_after = objection + 72 h
  // (releaseFunds only runs from PASSED); fail → CHANGES_REQUESTED; no usable verdict in 72 h → HUMAN_CHECK.
  CONTESTED: ["PASSED", "CHANGES_REQUESTED", "HUMAN_CHECK", "CANCELLED"],
  RELEASED: ["PAID_OUT", "PAYOUT_FAILED", "DISPUTE"], // a PayPal dispute can only open on captured money
  PAID_OUT: ["DISPUTE"],
  PAYOUT_FAILED: [],
  DISPUTE: [],
  CANCELLED: [],
  // Not matched in 72 h: the earlier decision (PASSED or HUMAN_CHECK) stands. Matched: ARBITRATION.
  LOCKED: ["ARBITRATION", "PASSED", "HUMAN_CHECK", "CANCELLED"],
  // A signed award: PASSED at its share, or CANCELLED (void) at 0%. A silent arbitrator: the earlier decision.
  ARBITRATION: ["PASSED", "HUMAN_CHECK", "CANCELLED"],
  // Claimed: the worker signed and takes the hold (FUNDED). Unclaimed past its deadline: voided.
  OFFERED: ["FUNDED", "CANCELLED"],
};

export function canTransition(from: MilestoneState, to: MilestoneState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransition extends Error {
  constructor(
    readonly from: MilestoneState,
    readonly to: MilestoneState,
  ) {
    super(`cannot move a milestone from ${from} to ${to}`);
  }
}

export function assertTransition(from: MilestoneState, to: MilestoneState): void {
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);
}
