import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terms } from "@/lib/contract/terms";
import type { Milestone } from "@/lib/milestones/repo";
import type { CheckRun, GitHub, PrFile } from "@/lib/review/github";
import { decide } from "@/lib/review/policy";
import { acceptanceCheckName, citedTerms, harnessEscapes, termsLineProblem, verifyCodePr } from "@/lib/review/verifiers";

// The code_pr verifier must only trust CI that provably ran the signed contract on the PR's commit.
// No database: the verifier is called directly with a fake GitHub. Only tested criteria, so no AI call.

const SIGNED = "a".repeat(64);
const FORGED = "b".repeat(64);
const SHA = "abc1234";
const PR_URL = "https://github.com/acme/web/pull/7";

const terms: Terms = {
  criteria: [{ id: "C1", text: "slugify works", kind: "must", check: "test", test: { path: "acceptance/c1.test.ts", code: "import test from 'node:test';\ntest('c1', () => {});" } }],
};
const milestone = { id: "m1", pr_url: PR_URL, criteria_hash: SIGNED } as Milestone;

const run = (name: string, conclusion: string | null, o: Partial<CheckRun> = {}): CheckRun => ({
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  url: `https://ci/${name}`,
  startedAt: new Date().toISOString(),
  app: "github-actions",
  headSha: SHA,
  workflowRunId: 1,
  ...o,
});

function fakeGitHub(body: string, runs: CheckRun[], files: PrFile[] = [{ filename: "src/slugify.ts", status: "added", additions: 1, deletions: 0, patch: "+export const slugify = (s: string) => s;" }]) {
  const calls: string[] = [];
  const gh: GitHub = {
    async pr(owner, repo, n) {
      calls.push("pr");
      return { number: n, title: "Add slugify", body, state: "open", merged: false, headSha: SHA, baseRepo: `${owner}/${repo}`, htmlUrl: PR_URL };
    },
    async files() {
      calls.push("files");
      return files;
    },
    async checkRuns() {
      calls.push("checks");
      return runs;
    },
    async comment() {},
  };
  return { gh, calls };
}

async function verdictFor(body: string, runs: CheckRun[], files?: PrFile[]) {
  const { gh, calls } = fakeGitHub(body, runs, files);
  const r = await verifyCodePr(milestone, terms, { github: gh });
  return { r, calls, decision: r.status === "done" ? decide(r.verdict).decision : "PENDING" };
}

describe("the Milestone-Terms line", () => {
  it("must appear exactly once and name the signed terms", () => {
    assert.deepEqual(citedTerms(`Adds slugify.\n\nMilestone-Terms: ${SIGNED}`), { count: 1, hash: SIGNED });
    assert.equal(termsLineProblem(`Milestone-Terms: ${SIGNED}\r\n`, SIGNED), undefined);
    assert.match(termsLineProblem("no terms here", SIGNED)!, /no Milestone-Terms line/);
    assert.match(termsLineProblem(`Milestone-Terms: ${FORGED}\nMilestone-Terms: ${SIGNED}`, SIGNED)!, /more than one/);
    assert.match(termsLineProblem(`Milestone-Terms: ${SIGNED}\n<!-- milestone-terms: ${FORGED} -->`, SIGNED)!, /more than one/);
    assert.match(termsLineProblem(`Milestone-Terms: ${FORGED}`, SIGNED)!, /other than the signed/);
    assert.match(termsLineProblem(`Milestone-Terms: ${SIGNED}ff`, SIGNED)!, /other than the signed/);
    assert.match(termsLineProblem(`Milestone-Terms: ${SIGNED}`, null)!, /other than the signed/);
  });
});

describe("code_pr verifier: which CI results count", () => {
  const body = `Adds slugify.\n\nMilestone-Terms: ${SIGNED}`;

  it("passes on a green GitHub Actions run of the signed contract", async () => {
    const { decision } = await verdictFor(body, [run("contract", "success"), run(acceptanceCheckName("C1", SIGNED), "success")]);
    assert.equal(decision, "PASSED");
  });

  it("a forged contract listed first in the description is blocked before CI is even read", async () => {
    const { r, calls, decision } = await verdictFor(`Milestone-Terms: ${FORGED}\nMilestone-Terms: ${SIGNED}`, [
      run("contract", "success"),
      run(acceptanceCheckName("C1", FORGED), "success"),
    ]);
    assert.equal(decision, "CHANGES_REQUESTED");
    assert.ok(r.status === "done" && r.verdict.blocked);
    assert.deepEqual(calls, ["pr"]);
  });

  it("green checks for another contract don't count, nor do old unnamed ones", async () => {
    const { r } = await verdictFor(body, [run("contract", "success"), run(acceptanceCheckName("C1", FORGED), "success"), run("acceptance (C1)", "success")]);
    assert.equal(r.status, "pending");
  });

  it("only GitHub Actions runs on the PR's head commit count", async () => {
    const name = acceptanceCheckName("C1", SIGNED);
    assert.equal((await verdictFor(body, [run("contract", "success"), run(name, "success", { app: "some-other-app" })])).r.status, "pending");
    assert.equal((await verdictFor(body, [run("contract", "success"), run(name, "success", { app: null })])).r.status, "pending");
    assert.equal((await verdictFor(body, [run("contract", "success"), run(name, "success", { headSha: "0ther" })])).r.status, "pending");
  });

  it("a fake check run from another app can't outvote a real failure", async () => {
    const name = acceptanceCheckName("C1", SIGNED);
    const later = new Date(Date.now() + 60_000).toISOString();
    const { decision } = await verdictFor(body, [run(name, "failure"), run(name, "success", { app: "evil-app", startedAt: later })]);
    assert.equal(decision, "CHANGES_REQUESTED");
  });

  it("the latest run of the signed contract decides (a re-run)", async () => {
    const name = acceptanceCheckName("C1", SIGNED);
    const earlier = new Date(Date.now() - 60_000).toISOString();
    assert.equal((await verdictFor(body, [run(name, "failure", { startedAt: earlier }), run(name, "success")])).decision, "PASSED");
    assert.equal((await verdictFor(body, [run(name, "success", { startedAt: earlier }), run(name, null)])).r.status, "pending");
  });

  it("a signed run that never shows up ends unclear (a person decides), never passed", async () => {
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    const { decision } = await verdictFor(body, [run("contract", "success", { startedAt: old }), run(acceptanceCheckName("C1", FORGED), "success", { startedAt: old })]);
    assert.equal(decision, "HUMAN_CHECK");
  });
});

describe("code that escapes the test harness", () => {
  it("is flagged, so a green run still goes to a person", async () => {
    const files: PrFile[] = [{ filename: "src/slugify.mjs", status: "added", additions: 2, deletions: 0, patch: '+process.exit(0);\n+export function slugify(s) { return "WRONG"; }' }];
    const { r, decision } = await verdictFor(`Milestone-Terms: ${SIGNED}`, [run("contract", "success"), run(acceptanceCheckName("C1", SIGNED), "success")], files);
    assert.equal(decision, "HUMAN_CHECK");
    assert.ok(r.status === "done" && r.verdict.tampering.includes("src/slugify.mjs (ends the process)"));
  });

  it("flags the cheap tricks and leaves ordinary code and the worker's own tests alone", () => {
    const f = (filename: string, patch: string): PrFile => ({ filename, status: "added", additions: 1, deletions: 0, patch });
    assert.deepEqual(
      harnessEscapes([
        f("src/a.ts", "+process.exitCode = 0;"),
        f("src/b.ts", '+import assert from "node:assert/strict";\n+assert.equal = () => {};'),
        f("src/c.ts", '+import { readFileSync } from "node:fs";\n+readFileSync("/proc/self/environ");'),
        f("src/d.ts", "+appendFileSync(process.env.GITHUB_OUTPUT, 'x');"),
        f("src/e.ts", '+import { register } from "node:module";'),
        f("src/ok.ts", '+export const slugify = (s: string) => s.toLowerCase();\n+if (process.env.NODE_ENV === "test") console.log("module");'),
        f("tests/slugify.test.ts", '+import { test } from "node:test";\n+import assert from "node:assert/strict";'),
        f(".github/workflows/x.yml", "+run: exit 0"),
      ]),
      ["src/a.ts (ends the process)", "src/b.ts (touches the test runner)", "src/c.ts (reads /proc)", "src/d.ts (writes CI files)", "src/e.ts (hooks the module loader)"],
    );
  });
});
