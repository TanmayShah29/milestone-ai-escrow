import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { resetDb, sampleTerms } from "./helpers";
import { db } from "@/lib/db";
import { draftTerms, editTerms, hashTerms, markStale, signTerms, type Terms } from "@/lib/contract/terms";
import { InvariantViolation } from "@/lib/money/flow";
import { createMilestone, getMilestone } from "@/lib/milestones/repo";

// A criterion's text and its test are one promise: editing the text without the test must not be signable.

beforeEach(resetDb);
after(() => db().end());

const edited = (t: Terms, text: string): Terms => ({ ...t, criteria: t.criteria.map((c) => (c.id === "C1" ? { ...c, text } : c)) });
const newText = "Settings page has a dark mode toggle that persists across reloads. Surrounding whitespace is trimmed";

describe("stale tests (pure)", () => {
  it("marks a tested criterion stale when its text changes and its code doesn't", () => {
    const out = markStale(sampleTerms, edited(sampleTerms, newText));
    assert.equal(out.criteria[0]!.testStale, true);
    assert.equal(out.criteria[1]!.testStale, undefined);
  });

  it("ignores a stale flag sent by the client, and keeps it until the code changes", () => {
    const stale = markStale(sampleTerms, edited(sampleTerms, newText));
    const cleared = { ...stale, criteria: stale.criteria.map((c) => ({ ...c, testStale: undefined })) };
    assert.equal(markStale(stale, cleared).criteria[0]!.testStale, true);
    const rewritten = { ...stale, criteria: stale.criteria.map((c, i) => (i === 0 ? { ...c, test: { path: c.test!.path, code: "import test from 'node:test';\ntest('trim', () => {});" } } : c)) };
    assert.equal(markStale(stale, rewritten).criteria[0]!.testStale, undefined);
    const forged = { ...sampleTerms, criteria: sampleTerms.criteria.map((c) => ({ ...c, testStale: true as const })) };
    assert.equal(markStale(sampleTerms, forged).criteria.some((c) => c.testStale), false);
  });

  it("switching to AI review drops the test and the flag", () => {
    const stale = markStale(sampleTerms, edited(sampleTerms, newText));
    const out = markStale(stale, { ...stale, criteria: stale.criteria.map((c, i) => (i === 0 ? { ...c, check: "review" as const } : c)) });
    assert.equal(out.criteria[0]!.test, undefined);
    assert.equal(out.criteria[0]!.testStale, undefined);
  });

  it("unchanged terms hash the same as before the flag existed", () => {
    const m = { id: "00000000-0000-0000-0000-000000000000", title: "t", amount_cents: 100, currency: "USD" as const, freelancer_email: "w@example.com", repo: null };
    assert.equal(hashTerms(m, markStale(sampleTerms, sampleTerms)), hashTerms(m, sampleTerms));
    assert.notEqual(hashTerms(m, markStale(sampleTerms, edited(sampleTerms, newText))), hashTerms(m, edited(sampleTerms, newText)));
  });
});

describe("stale tests (contract)", () => {
  it("signing is refused while a test is stale, by either side", async () => {
    const { milestone } = await createMilestone({ title: "t", brief: "", amountCents: 100, freelancerEmail: "w@example.com" });
    await editTerms(milestone.id, sampleTerms);
    const m = await editTerms(milestone.id, edited(sampleTerms, newText));
    assert.equal((m.criteria as Terms).criteria[0]!.testStale, true);
    for (const role of ["client", "worker"] as const) {
      await assert.rejects(signTerms(milestone.id, role, m.criteria_hash!), (e: Error) => e instanceof InvariantViolation && /C1's test no longer matches its text/.test(e.message));
    }
  });

  it("switching the stale criterion to AI review makes the terms signable", async () => {
    const { milestone } = await createMilestone({ title: "t", brief: "", amountCents: 100, freelancerEmail: "w@example.com" });
    await editTerms(milestone.id, sampleTerms);
    const stale = await editTerms(milestone.id, edited(sampleTerms, newText));
    const terms = stale.criteria as Terms;
    const m = await editTerms(milestone.id, { ...terms, criteria: terms.criteria.map((c, i) => (i === 0 ? { ...c, check: "review" as const, test: undefined, testStale: undefined } : c)) });
    await signTerms(milestone.id, "client", m.criteria_hash!);
    assert.equal((await signTerms(milestone.id, "worker", m.criteria_hash!)).state, "AGREED");
  });

  it("drafting with stale tests rewrites only those tests, in one call, keeping the client's text", async () => {
    const { milestone } = await createMilestone({ title: "t", brief: "Dark mode", amountCents: 100, freelancerEmail: "w@example.com" });
    await editTerms(milestone.id, sampleTerms);
    await editTerms(milestone.id, edited(sampleTerms, newText));
    let calls = 0;
    let prompt = "";
    // A test that bites (fails against an empty implementation), so the test check asks for no second call.
    const code = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { saveTheme } from '../src/theme.ts';\ntest('trims', () => { assert.equal(saveTheme(' dark '), 'dark'); });";
    const m = await draftTerms(milestone.id, {}, async (_model, _sys, p) => {
      calls++;
      prompt = p;
      return JSON.stringify({ tests: [{ id: "C1", code }] });
    });
    assert.equal(calls, 1);
    assert.match(prompt, /Surrounding whitespace is trimmed/);
    const c1 = (m.criteria as Terms).criteria[0]!;
    assert.equal(c1.text, newText);
    assert.deepEqual(c1.test, { path: "acceptance/c1.test.ts", code });
    assert.equal(c1.testStale, undefined);
    assert.deepEqual((m.criteria as Terms).criteria[1], sampleTerms.criteria[1]);
    await signTerms(milestone.id, "client", m.criteria_hash!);
    assert.equal((await getMilestone(milestone.id)).client_signed_hash, m.criteria_hash);
  });
});
