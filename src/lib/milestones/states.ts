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
  "PARTIAL_REFUND",
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
  CONTESTED: ["PARTIAL_REFUND", "DISPUTE", "RELEASED"],
  RELEASED: ["PAID_OUT", "PAYOUT_FAILED"],
  PAID_OUT: [],
  PAYOUT_FAILED: [],
  PARTIAL_REFUND: [],
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
