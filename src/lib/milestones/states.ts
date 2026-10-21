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

const TRANSITIONS: Record<MilestoneState, readonly MilestoneState[]> = {
  DRAFT: ["AGREED", "CANCELLED"],
  AGREED: ["FUNDED", "CANCELLED"],
  FUNDED: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["IN_REVIEW", "PASSED"], // PASSED directly only via the dev route until the reviewer exists
  IN_REVIEW: ["CHANGES_REQUESTED", "HUMAN_CHECK", "PASSED"],
  CHANGES_REQUESTED: ["SUBMITTED"],
  HUMAN_CHECK: ["PASSED", "CHANGES_REQUESTED"],
  PASSED: ["RELEASED", "CONTESTED"],
  // One second review on the same commit: pass → back to PASSED with release_after = objection + 72 h
  // (releaseFunds only runs from PASSED); fail → CHANGES_REQUESTED; no usable verdict in 72 h → HUMAN_CHECK.
  CONTESTED: ["PASSED", "CHANGES_REQUESTED", "HUMAN_CHECK"],
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
