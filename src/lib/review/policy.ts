// The decision policy: deterministic code, never the model (money rule 1). The verifier gathers evidence;
// this turns it into PASSED (release after the objection window), CHANGES_REQUESTED or HUMAN_CHECK.

export type CriterionVerdict = {
  id: string;
  kind: "must" | "nice";
  source: "test" | "ai";
  verdict: "pass" | "fail" | "unclear";
  confidence: number; // 0..1; 1 for a CI result
  evidence: string[];
};

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
};

export type Decision = "PASSED" | "CHANGES_REQUESTED" | "HUMAN_CHECK";

export const CONFIDENCE_FLOOR = 0.8;

export function decide(v: Verdict): { decision: Decision; reasons: string[] } {
  if (v.blocked) return { decision: "CHANGES_REQUESTED", reasons: [v.blocked, ...flags(v)] };
  const musts = v.criteria.filter((c) => c.kind === "must");
  const failed = musts.filter((c) => c.verdict === "fail");
  if (failed.length) {
    return { decision: "CHANGES_REQUESTED", reasons: [`${failed.map((c) => c.id).join(", ")} failed`, ...flags(v)] };
  }
  if (v.tampering.length || v.injection.detected) return { decision: "HUMAN_CHECK", reasons: flags(v) };
  const shaky = musts.filter((c) => c.verdict === "unclear" || c.confidence < CONFIDENCE_FLOOR);
  if (shaky.length) return { decision: "HUMAN_CHECK", reasons: [`${shaky.map((c) => c.id).join(", ")} unclear or below ${CONFIDENCE_FLOOR} confidence`] };
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
type TimeoutInput = Pick<Verdict, "tampering" | "injection"> & { criteria: (Pick<CriterionVerdict, "verdict" | "confidence"> & { kind: string })[] };

export function humanTimeoutOutcome(v: TimeoutInput | null | undefined): { outcome: TimeoutOutcome; reasons: string[] } {
  if (!v || !Array.isArray(v.tampering) || !Array.isArray(v.criteria) || typeof v.injection?.detected !== "boolean") {
    return { outcome: "wait", reasons: ["there is no usable review verdict on record, so the rules can't settle this on their own"] };
  }
  const tampering = (v?.tampering ?? []).filter((t) => !isProceduralFlag(t));
  const procedural = (v?.tampering ?? []).filter(isProceduralFlag);
  if (tampering.length || v?.injection?.detected) return { outcome: "void", reasons: flags({ tampering, injection: v?.injection ?? { detected: false, quotes: [] } }) };
  if (procedural.length) {
    const musts = (v?.criteria ?? []).filter((c) => c.kind === "must");
    const allPassed = musts.length > 0 && musts.every((c) => c.verdict === "pass" && c.confidence >= CONFIDENCE_FLOOR);
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
