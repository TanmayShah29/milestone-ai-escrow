import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { resetDb, sampleTerms } from "./helpers";
import { db } from "@/lib/db";
import type { ModelCall } from "@/lib/ai/client";
import { currentPolicy, draftTerms, editTerms, hashTerms, signTerms, termsSchema, type Terms } from "@/lib/contract/terms";
import type { TestToCheck } from "@/lib/contract/testcheck";
import { InvariantViolation } from "@/lib/errors";
import { createMilestone, getMilestone } from "@/lib/milestones/repo";

// Contract fairness against the database: a test the client writes is checked like an AI-written one and
// labelled as theirs; terms saved now fingerprint the fee, objection window and due date, while terms
// saved before keep their hash. No live AI: drafts come from a fake model.

beforeEach(resetDb);
after(() => db().end());

const H = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.ts';\n";
const BITES = H + "test('slug', () => { assert.equal(slugify('Hello World'), 'hello-world'); });";
const NOOP = H + "test('slug', () => { assert.ok(true); });";
const BITES_2 = H + "test('slug', () => { assert.equal(slugify('A  B'), 'a-b'); });";

const terms = (m: { criteria: unknown }) => m.criteria as Terms;
const newMilestone = async () => (await createMilestone({ title: "Slugify", brief: "Add a slugify helper in src/slugify.ts", amountCents: 10_000, freelancerEmail: "w@example.com" })).milestone;
const withC1 = (t: Terms, code: string): Terms => ({ ...t, criteria: t.criteria.map((c) => (c.id === "C1" ? { ...c, check: "test" as const, test: { path: "acceptance/c1.test.ts", code } } : c)) });
const aiDraft: ModelCall = async () =>
  JSON.stringify({
    criteria: [
      { id: "C1", text: "slugify lowercases and joins words with hyphens", kind: "must", check: "test", test: { path: "acceptance/c1.test.ts", code: BITES } },
      { id: "C2", text: "README documents the slugify function", kind: "must", check: "review" },
    ],
    testCommand: "node --test 'acceptance/*.test.ts'",
  });
const bites = async () => new Map();

describe("client-written tests", () => {
  it("a client's no-op test is flagged weak by the static check (never run on the server), and blocks signing", async () => {
    const m = await draftTerms((await newMilestone()).id, {}, aiDraft, bites);
    const edited = await editTerms(m.id, withC1(terms(m), NOOP));
    const c1 = terms(edited).criteria[0]!;
    assert.equal(c1.testWeak, true);
    assert.match(c1.weakReason!, /never uses it/);
    assert.equal(c1.testBy, "client");
    await assert.rejects(signTerms(m.id, "worker", edited.criteria_hash!), (e: Error) => e instanceof InvariantViolation && /C1's test doesn't work as a check/.test(e.message));
  });

  it("a client's test that bites is signable, labelled as theirs, and the label is in the hash", async () => {
    const m = await draftTerms((await newMilestone()).id, {}, aiDraft, bites);
    assert.equal(terms(m).criteria[0]!.testBy, undefined); // AI-written: no label
    const edited = await editTerms(m.id, withC1(terms(m), BITES_2));
    const t = termsSchema.parse(edited.criteria);
    assert.equal(t.criteria[0]!.testBy, "client");
    assert.equal(t.criteria[0]!.testWeak, undefined);
    assert.equal(edited.criteria_hash, hashTerms(edited, t));
    assert.notEqual(edited.criteria_hash, hashTerms(edited, { ...t, criteria: t.criteria.map((c) => ({ ...c, testBy: undefined })) }));
    await signTerms(m.id, "client", edited.criteria_hash!);
    assert.equal((await signTerms(m.id, "worker", edited.criteria_hash!)).state, "AGREED");
  });

  it("checks only the tests the edit added or changed, and ignores a forged label", async () => {
    const m = await draftTerms((await newMilestone()).id, {}, aiDraft, bites);
    const seen: TestToCheck[][] = [];
    const check = async (tests: TestToCheck[]) => {
      seen.push(tests);
      return new Map();
    };
    // Unchanged AI test, with a label the client sent: nothing is checked and the label is dropped.
    const t = terms(m);
    const claimed = await editTerms(m.id, { ...t, criteria: t.criteria.map((c) => ({ ...c, testBy: "client" })) }, { check });
    assert.equal(seen.length, 0);
    assert.equal(terms(claimed).criteria[0]!.testBy, undefined);
    assert.equal(claimed.criteria_hash, m.criteria_hash);
    // A new test on C2 (client-written), C1 untouched: only C2 is checked.
    const added = await editTerms(m.id, { ...t, criteria: t.criteria.map((c) => (c.id === "C2" ? { ...c, check: "test" as const, test: { path: "acceptance/c2.test.ts", code: BITES_2 } } : c)) }, { check });
    assert.deepEqual(seen.map((s) => s.map((x) => x.id)), [["C2"]]);
    assert.deepEqual(terms(added).criteria.map((c) => c.testBy), [undefined, "client"]);
  });

  it("an AI rewrite of a client's weak test drops the label", async () => {
    const m = await draftTerms((await newMilestone()).id, {}, aiDraft, bites);
    await editTerms(m.id, withC1(terms(m), NOOP), { check: async (tests) => new Map(tests.map((x) => [x.id, { kind: "weak" as const, reason: "passes against an empty implementation" }])) });
    const regen = await draftTerms(m.id, {}, async () => JSON.stringify({ tests: [{ id: "C1", code: BITES }] }), bites);
    const c1 = terms(regen).criteria[0]!;
    assert.equal(c1.testBy, undefined);
    assert.equal(c1.testWeak, undefined);
  });
});

describe("policy in the fingerprint", () => {
  it("terms saved now include the fee and objection window, and the hash covers them", async () => {
    const m = await draftTerms((await newMilestone()).id, {}, aiDraft, bites);
    const t = termsSchema.parse(m.criteria);
    assert.deepEqual(t.policy, currentPolicy());
    assert.equal(t.policy!.platformFeeBps, 500);
    assert.equal(m.criteria_hash, hashTerms(m, t));
    assert.notEqual(m.criteria_hash, hashTerms(m, { ...t, policy: undefined }));
  });

  it("a policy sent by the client is ignored", async () => {
    const m = await draftTerms((await newMilestone()).id, {}, aiDraft, bites);
    const t = terms(m);
    const forged = await editTerms(m.id, { ...t, policy: { ...t.policy!, platformFeeBps: 0 } }, { check: bites });
    assert.equal(terms(forged).policy!.platformFeeBps, 500);
    assert.equal(forged.criteria_hash, m.criteria_hash);
  });

  it("a contract signed before the policy existed keeps its hash and signatures through a no-op save", async () => {
    const { milestone } = await createMilestone({ title: "t", brief: "", amountCents: 1_000, freelancerEmail: "w@example.com" });
    const hash = hashTerms(milestone, sampleTerms);
    const suggestions = [{ text: "toggle state survives a private window", why: "edge" }];
    await db().query("update milestones set criteria = $2, criteria_hash = $3, client_signed_hash = $3 where id = $1", [milestone.id, JSON.stringify({ ...sampleTerms, suggestions }), hash]);
    // Dismissing the suggestion re-saves the same terms: no policy is added, nothing is re-checked.
    const m = await editTerms(milestone.id, { ...sampleTerms, suggestions: [] }, { check: async () => assert.fail("nothing changed, so nothing should be checked") });
    assert.equal(m.criteria_hash, hash);
    assert.equal(m.client_signed_hash, hash);
    assert.equal(terms(m).policy, undefined);
    assert.equal((await getMilestone(milestone.id)).criteria_hash, hash);
  });
});
