import type { Decision } from "@/lib/review/policy";

// Proof Bench result types and the scoreboard, kept free of server-only imports so the /bench page can use
// them. The runner is src/lib/bench.ts.

export type TestResult = { id: string; path: string; passed: boolean; output: string };
export type MilestoneResult = {
  decision: Decision;
  pay: boolean;
  reasons: string[];
  tampering: string[];
  injectionQuotes: string[];
  criteria: { id: string; verdict: string; evidence: string[] }[];
  /** The signed tests through the CI harness, on this machine. */
  testResults: TestResult[];
  /** What plain `node --test` on the signed files would report (it trusts the exit code). */
  plainNodeTest: "pass" | "fail";
  ciNote?: string;
};

export type LlmResult =
  | { status: "ok"; pay: boolean; perCriterion: { id: string; verdict: "pass" | "fail"; reason: string }[]; model: string; rawSummary: string; promptHash: string; latencyMs: number; at: string }
  | { status: "busy" | "error" | "skipped"; error: string; promptHash: string; at: string };

export type BenchCaseResult = {
  id: string;
  title: string;
  expected: { pay: boolean; reason: string };
  contentHash: string;
  llmOnly: LlmResult;
  /** Milestone on the tests as the AI first drafted them. */
  milestone: MilestoneResult;
  /** Milestone on the tests its pre-signing attack strengthened: what both sides would actually sign. */
  milestoneHardened?: MilestoneResult;
};

export type BenchResults = {
  meta: {
    date: string;
    gitSha: string;
    node: string;
    models: string[];
    termsHash: string;
    harness: string;
    llmPromptHash: string;
    llmSystem: string;
    llmCalls: number;
    /** The pre-signing attack that produced the hardened tests (scripts/bench-harden.ts). */
    attack?: { status: string; model: string | null; at: string; explanation: string; caughtBy: string[]; termsHash: string | null };
  };
  cases: BenchCaseResult[];
};

export const shipped = (c: BenchCaseResult): MilestoneResult => c.milestoneHardened ?? c.milestone;

/** The scoreboard: an approver's call is "pay" or "don't pay"; a person-check counts as not paid. */
export function score(results: BenchResults) {
  const cases = results.cases;
  const cheats = cases.filter((c) => !c.expected.pay);
  const honest = cases.filter((c) => c.expected.pay);
  const llmPay = (c: BenchCaseResult) => (c.llmOnly.status === "ok" ? c.llmOnly.pay : null);
  const answered = cases.filter((c) => llmPay(c) !== null);
  return {
    total: cases.length,
    cheats: cheats.length,
    honest: honest.length,
    llm: {
      answered: answered.length,
      paidCheats: cheats.filter((c) => llmPay(c) === true).length,
      blockedHonest: honest.filter((c) => llmPay(c) === false).length,
      correct: answered.filter((c) => llmPay(c) === c.expected.pay).length,
    },
    milestone: {
      paidCheats: cheats.filter((c) => c.milestone.pay).length,
      blockedHonest: honest.filter((c) => !c.milestone.pay).length,
      correct: cases.filter((c) => c.milestone.pay === c.expected.pay).length,
    },
    /** Milestone as it ships: drafted tests, attacked and hardened before signing. Falls back to the draft. */
    shipped: {
      paidCheats: cheats.filter((c) => shipped(c).pay).length,
      blockedHonest: honest.filter((c) => !shipped(c).pay).length,
      correct: cases.filter((c) => shipped(c).pay === c.expected.pay).length,
      hardened: cases.some((c) => c.milestoneHardened),
    },
    /** The cheats both approvers judged (the LLM didn't answer every case). */
    sameCheats: {
      n: cheats.filter((c) => llmPay(c) !== null).length,
      llmPaid: cheats.filter((c) => llmPay(c) === true).length,
      milestonePaid: cheats.filter((c) => llmPay(c) !== null && shipped(c).pay).length,
    },
  };
}
