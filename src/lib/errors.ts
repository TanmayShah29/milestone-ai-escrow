// Domain errors shared by the money flow and the contract (mapped to HTTP in src/lib/http.ts).
export class InProgress extends Error {}
export class OutcomeUnknown extends Error {}
export class InvariantViolation extends Error {}
