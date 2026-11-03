import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { droppedChecks } from "@/lib/contract/attack";
import { benchTerms, benchTermsHash, hardened, hardenedTermsHash, loadCases, RESULTS_PATH, runMilestone, score, type BenchResults } from "@/lib/bench";

// Proof Bench claims can't rot: Milestone's side is re-run over the corpus (signed tests through the CI
// harness, then verifyCodePr and decide) and must match the committed bench/results.json. Pure: no
// database, no AI, no network. The LLM-only side is recorded data and isn't re-asked here.

describe("Proof Bench", async () => {
  const committed = JSON.parse(await readFile(RESULTS_PATH, "utf8")) as BenchResults;
  const cases = await loadCases();

  it("results.json covers exactly the corpus, for the current fixtures and contract", () => {
    assert.deepEqual(committed.cases.map((c) => c.id).sort(), cases.map((c) => c.id).sort());
    assert.equal(committed.meta.termsHash, benchTermsHash);
    for (const c of cases) {
      const row = committed.cases.find((r) => r.id === c.id)!;
      assert.equal(row.contentHash, c.contentHash, `${c.id}: fixtures changed since results.json was written; run npm run bench`);
      assert.equal(row.expected.pay, c.shouldPay, c.id);
    }
  });

  for (const c of cases) {
    it(`${c.id}: Milestone decides as recorded`, async () => {
      const row = committed.cases.find((r) => r.id === c.id)!;
      const got = await runMilestone(c);
      assert.equal(got.decision, row.milestone.decision);
      assert.deepEqual(got.reasons, row.milestone.reasons);
      assert.deepEqual(got.testResults.map((t) => [t.id, t.passed]), row.milestone.testResults.map((t) => [t.id, t.passed]));
      assert.equal(got.plainNodeTest, row.milestone.plainNodeTest);
      if (row.milestoneHardened) {
        const after = await runMilestone(c, "hardened");
        assert.equal(after.decision, row.milestoneHardened.decision, `${c.id} after the attack`);
        assert.deepEqual(after.testResults.map((t) => [t.id, t.passed]), row.milestoneHardened.testResults.map((t) => [t.id, t.passed]));
      }
    });
  }

  it("the hardened tests only add checks to the drafted ones, and match results.json", () => {
    if (!hardened?.criteria) return;
    assert.equal(committed.meta.attack?.termsHash, hardenedTermsHash);
    for (const t of hardened.criteria) {
      const draft = benchTerms.criteria.find((c) => c.id === t.id)!;
      assert.deepEqual(droppedChecks(draft.test!.code, t.code), [], t.id);
    }
  });

  it("the scoreboard numbers follow from the rows", () => {
    const s = score(committed);
    assert.equal(s.total, cases.length);
    assert.equal(s.milestone.paidCheats, committed.cases.filter((c) => !c.expected.pay && c.milestone.decision === "PASSED").length);
  });
});
