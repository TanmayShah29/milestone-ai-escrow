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
] as const;

export type MilestoneState = (typeof STATES)[number];

// CANCELLED from every pre-capture hold state: the client may void from FUNDED, CHANGES_REQUESTED and
// HUMAN_CHECK (flow.ts cancelHold checks which), and a hold PayPal voided or expired ends the milestone
// from any of them (flow.ts endHoldIfGone). Never after a capture.
const TRANSITIONS: Record<MilestoneState, readonly MilestoneState[]> = {
  DRAFT: ["AGREED", "CANCELLED"],
  AGREED: ["FUNDED", "CANCELLED"],
  FUNDED: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["IN_REVIEW", "CANCELLED"],
  IN_REVIEW: ["CHANGES_REQUESTED", "HUMAN_CHECK", "PASSED", "CANCELLED"],
  CHANGES_REQUESTED: ["SUBMITTED", "CANCELLED"],
  HUMAN_CHECK: ["PASSED", "CHANGES_REQUESTED", "CANCELLED"],
  // CHANGES_REQUESTED: commits were pushed after approval, so the approved commit is not what would be paid (review/run.ts).
  PASSED: ["RELEASED", "CONTESTED", "CHANGES_REQUESTED", "CANCELLED"],
  // One second review on the same commit: pass → back to PASSED with release_after = objection + 72 h
  // (releaseFunds only runs from PASSED); fail → CHANGES_REQUESTED; no usable verdict in 72 h → HUMAN_CHECK.
  CONTESTED: ["PASSED", "CHANGES_REQUESTED", "HUMAN_CHECK", "CANCELLED"],
  RELEASED: ["PAID_OUT", "PAYOUT_FAILED", "DISPUTE"], // a PayPal dispute can only open on captured money
  PAID_OUT: ["DISPUTE"],
  PAYOUT_FAILED: [],
  DISPUTE: [],
  CANCELLED: [],
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
