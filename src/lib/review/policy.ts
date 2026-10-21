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

function flags(v: Verdict): string[] {
  const out: string[] = [];
  if (v.tampering.length) out.push(`PR changes protected files: ${v.tampering.join(", ")}`);
  if (v.injection.detected) out.push("PR contains text aimed at the AI reviewer");
  return out;
}
