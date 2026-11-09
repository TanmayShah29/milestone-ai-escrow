// The decision policy: deterministic code, never the model (money rule 1). The verifier gathers evidence;
// this turns it into PASSED (release after the objection window), CHANGES_REQUESTED or HUMAN_CHECK.

export type CriterionVerdict = {
  id: string;
  kind: "must" | "nice";
  source: "test" | "ai";
  verdict: "pass" | "fail" | "unclear";
  confidence: number; // 0..1; 1 for a CI result. Shown; under policy-2 it never decides.
  evidence: string[];
  /** How strong the evidence behind a pass or fail is (policy-2): E2 a bound CI result, E1 panel agreement. */
  level?: EvidenceLevel;
  /** The panel's grounded votes for this criterion (policy-2). */
  votes?: { pass: number; fail: number; of: number };
};

/**
 * Evidence levels, weakest first (V2_PLAN §3.2): E0 a claim nobody checked, E1 AI panel agreement grounded
 * in the diff, E2 CI bound to the milestone workflow, E3 the trusted runner's signed result.
 */
export const EVIDENCE_LEVELS = ["E0", "E1", "E2", "E3"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
const rank = (l: EvidenceLevel) => EVIDENCE_LEVELS.indexOf(l);

/** One panel member's vote on one criterion (panel.ts). */
export type PanelVote = {
  model: string;
  id: string;
  verdict: "pass" | "fail" | "unclear";
  confidence: number;
  grounded: boolean;
  evidence: string[];
  problems?: string[];
};
/** Who judged what: each member's model, the order it saw the criteria in, and its votes. */
export type PanelRecord = { size: number; members: { model: string; order: string[]; votes: PanelVote[]; injection: boolean; error?: string }[] };

export type Verdict = {
  criteria: CriterionVerdict[];
  summary: string;
  feedbackForWorker: string;
  injection: { detected: boolean; quotes: string[] };
  tampering: string[]; // files the PR changed that it must not (CI config, acceptance tests), or code that escapes the test harness
  /** Set when the work could not be checked against the signed terms at all (e.g. the PR cites other terms). Never passes. */
  blocked?: string;
  model: string | null;
  headSha: string | null;
  /** Set when the AI panel judged (policy-2). */
  panel?: PanelRecord;
  /** Set when the tested criteria came from the trusted runner (E3): its run and the Rekor log entry. */
  runner?: { runId: number | null; rekorIndex: number | null; url: string };
};

export type Decision = "PASSED" | "CHANGES_REQUESTED" | "HUMAN_CHECK";

export const CONFIDENCE_FLOOR = 0.8;
export const POLICY_1 = "policy-1";
export const POLICY_2 = "policy-2";
/** The decision policy new terms pin (contract/terms.ts currentPolicy). Signed terms keep theirs. */
export const POLICY_VERSION = POLICY_2;
/** The verifier's version, pinned the same way: bump it when what a verifier checks changes. */
export const VERIFIER_VERSION = "2";

/**
 * What the signed terms pinned (their `policy`, plus each criterion's evidenceFloor); absent on
 * contracts saved before pins existed, which decide by policy-1.
 */
export type Pins = {
  policyVersion?: string;
  confidenceFloor?: number;
  reviewModels?: string[];
  floors?: Record<string, EvidenceLevel>;
  paySchedule?: { mustBaseBps: number; niceBonusBps: Record<string, number> };
};

/** `shareBps` (policy-2, PASSED only): the earned share of the amount the release captures. */
export type Outcome = { decision: Decision; reasons: string[]; shareBps?: number };

/** The decision, by the policy version the signed terms pinned. Terms that pin none decide by policy-1. */
export function decide(v: Verdict, pins: Pins = {}): Outcome {
  const version = pins.policyVersion ?? POLICY_1;
  if (version === POLICY_2) return decide2(v, pins);
  if (version === POLICY_1) return decide1(v, pins);
  return { decision: "HUMAN_CHECK", reasons: [`the signed terms pin ${version}, a decision policy this server doesn't have`] };
}

/** The floor a criterion needs when the terms set none: E2 for a tested one (CI), E1 for the panel. */
export function defaultFloor(source: CriterionVerdict["source"]): EvidenceLevel {
  return source === "test" ? "E2" : "E1";
}

/**
 * policy-2: nothing settles on evidence below its floor (V2_PLAN P1, §3.F).
 *  - a must-have that failed with evidence at or above its floor → CHANGES_REQUESTED;
 *  - tampering or text aimed at the reviewer (from the scan or any panel member) → HUMAN_CHECK;
 *  - a must-have unclear, or passed below its floor → HUMAN_CHECK;
 *  - every must-have passed at or above its floor → PASSED.
 * Self-reported confidence plays no part, and neither do models the terms don't name (panel.ts tally).
 */
function decide2(v: Verdict, pins: Pins): Outcome {
  if (v.blocked) return { decision: "CHANGES_REQUESTED", reasons: [v.blocked, ...flags(v)] };
  const floorOf = (c: CriterionVerdict) => pins.floors?.[c.id] ?? defaultFloor(c.source);
  const atFloor = (c: CriterionVerdict) => c.level !== undefined && rank(c.level) >= rank(floorOf(c));
  const musts = v.criteria.filter((c) => c.kind === "must");
  const failed = musts.filter((c) => c.verdict === "fail" && atFloor(c));
  if (failed.length) {
    return { decision: "CHANGES_REQUESTED", reasons: [`${failed.map((c) => c.id).join(", ")} failed`, ...flags(v)] };
  }
  if (v.tampering.length || v.injection.detected) return { decision: "HUMAN_CHECK", reasons: flags(v) };
  if (musts.length === 0) return { decision: "HUMAN_CHECK", reasons: ["no must-have criteria to check"] };
  const short = musts.filter((c) => !(c.verdict === "pass" && atFloor(c)));
  if (short.length) {
    return {
      decision: "HUMAN_CHECK",
      reasons: short.map((c) => (c.verdict === "unclear" ? `${c.id} unclear` : `${c.id} ${c.verdict === "pass" ? "passed" : "failed"} on ${c.level ?? "unlevelled"} evidence, below its ${floorOf(c)} floor`)),
    };
  }
  const { shareBps, missed } = earnedShare(v, pins);
  return {
    decision: "PASSED",
    reasons: ["every must-have criterion passed at or above its evidence floor", ...(missed.length ? [`pays ${shareBps / 100}%: ${missed.join(", ")} not met`] : [])],
    shareBps,
  };
}

/**
 * The share the must-haves earn plus the bonus of each nice-to-have met at its floor (policy-2 pay
 * schedule). Without a schedule: all of it. Assumes the must-haves are met; decide2 checks that first.
 */
export function earnedShare(v: Pick<Verdict, "criteria">, pins: Pins): { shareBps: number; missed: string[] } {
  const s = pins.paySchedule;
  if (!s) return { shareBps: 10_000, missed: [] };
  let share = s.mustBaseBps;
  const missed: string[] = [];
  for (const [id, bonus] of Object.entries(s.niceBonusBps)) {
    const c = v.criteria.find((x) => x.id === id);
    const met = !!c && c.verdict === "pass" && c.level !== undefined && rank(c.level) >= rank(pins.floors?.[id] ?? defaultFloor(c.source));
    if (met) share += bonus;
    else missed.push(id);
  }
  return { shareBps: Math.min(share, 10_000), missed };
}

/** policy-1, exactly as signed before Nov 5: one model, its confidence against the floor. */
function decide1(v: Verdict, pins: Pins): { decision: Decision; reasons: string[] } {
  if (v.blocked) return { decision: "CHANGES_REQUESTED", reasons: [v.blocked, ...flags(v)] };
  const floor = pins.confidenceFloor ?? CONFIDENCE_FLOOR;
  const musts = v.criteria.filter((c) => c.kind === "must");
  const failed = musts.filter((c) => c.verdict === "fail");
  if (failed.length) {
    return { decision: "CHANGES_REQUESTED", reasons: [`${failed.map((c) => c.id).join(", ")} failed`, ...flags(v)] };
  }
  if (v.tampering.length || v.injection.detected) return { decision: "HUMAN_CHECK", reasons: flags(v) };
  // A model both sides didn't sign up for may answer when every pinned one is gone (free models come and
  // go): its verdict is shown, but it can't pay on its own.
  if (v.model && pins.reviewModels?.length && !pins.reviewModels.includes(v.model)) {
    return { decision: "HUMAN_CHECK", reasons: [`reviewed by ${v.model}, which the signed terms don't name (${pins.reviewModels.join(", ")})`] };
  }
  const shaky = musts.filter((c) => c.verdict === "unclear" || c.confidence < floor);
  if (shaky.length) return { decision: "HUMAN_CHECK", reasons: [`${shaky.map((c) => c.id).join(", ")} unclear or below ${floor} confidence`] };
  if (musts.length === 0) return { decision: "HUMAN_CHECK", reasons: ["no must-have criteria to check"] };
  return { decision: "PASSED", reasons: ["every must-have criterion passed"] };
}

/**
 * Entries in `tampering` that send work to a person without being tampering: a CI result that couldn't
 * be tied to the milestone workflow (verifiers.ts: "CI result for C1 not trusted: …", which a transient
 * GitHub error can also cause), or a PR too large to scan fully ("the pull request changes N files; …").
 * Anything else (a protected path, a harness escape, or any entry this doesn't recognise) is tampering.
 */
export function isProceduralFlag(entry: string): boolean {
  return /^CI result for \S+ not trusted: /.test(entry) || /^the pull request changes \S+ files; only the first \d+ can be scanned$/.test(entry);
}

export type TimeoutOutcome = "release" | "void" | "wait";

/**
 * What fixed rules do with a HUMAN_CHECK the client leaves undecided past its deadline:
 *  - tampering (protected files, harness escapes) or text aimed at the reviewer → "void": the hold goes
 *    back to the client; such work is never paid by default;
 *  - only procedural flags (untrusted CI, a PR too large to scan) → "release" if every must-have still
 *    passed with full confidence, otherwise "wait" (nothing automatic; the client must decide);
 *  - no flags (low confidence, an unfinished second review) → "release" to the worker.
 * No verdict on record, or one that isn't shaped like a verdict, → "wait": money never moves on missing evidence.
 */
type TimeoutInput = Pick<Verdict, "tampering" | "injection"> & { criteria: (Pick<CriterionVerdict, "verdict" | "confidence"> & Partial<Pick<CriterionVerdict, "id" | "source" | "level">> & { kind: string })[] };

export function humanTimeoutOutcome(v: TimeoutInput | null | undefined, pins: Pins = {}): { outcome: TimeoutOutcome; reasons: string[] } {
  if (!v || !Array.isArray(v.tampering) || !Array.isArray(v.criteria) || typeof v.injection?.detected !== "boolean") {
    return { outcome: "wait", reasons: ["there is no usable review verdict on record, so the rules can't settle this on their own"] };
  }
  const tampering = (v?.tampering ?? []).filter((t) => !isProceduralFlag(t));
  const procedural = (v?.tampering ?? []).filter(isProceduralFlag);
  if (tampering.length || v?.injection?.detected) return { outcome: "void", reasons: flags({ tampering, injection: v?.injection ?? { detected: false, quotes: [] } }) };
  if (procedural.length) {
    const musts = (v?.criteria ?? []).filter((c) => c.kind === "must");
    // policy-2 confirms a must-have by its evidence floor, policy-1 by the model's confidence.
    const confirmed =
      pins.policyVersion === POLICY_2
        ? (c: (typeof musts)[number]) => c.level !== undefined && rank(c.level) >= rank(pins.floors?.[c.id ?? ""] ?? defaultFloor(c.source ?? "ai"))
        : (c: (typeof musts)[number]) => c.confidence >= CONFIDENCE_FLOOR;
    const allPassed = musts.length > 0 && musts.every((c) => c.verdict === "pass" && confirmed(c));
    return allPassed
      ? { outcome: "release", reasons: ["every must-have passed; the review was held only for a check it couldn't complete", ...procedural] }
      : { outcome: "wait", reasons: ["the rules can't settle this on their own: a must-have wasn't confirmed and a check couldn't be completed", ...procedural] };
  }
  return { outcome: "release", reasons: ["the review flagged no tampering or text aimed at the reviewer"] };
}

function flags(v: Pick<Verdict, "tampering" | "injection">): string[] {
  const out: string[] = [];
  if (v.tampering?.length) out.push(`PR changes protected files: ${v.tampering.join(", ")}`);
  if (v.injection?.detected) out.push("PR contains text aimed at the AI reviewer");
  return out;
}
