import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { resetDb, seedMilestone } from "./helpers";
import { attackTerms, storedAttack } from "@/lib/contract/attack";
import { contractDocument, hashTerms, canonical, termsSchema, type Terms } from "@/lib/contract/terms";
import { db } from "@/lib/db";
import type { ModelCall } from "@/lib/ai/client";
import { getMilestone } from "@/lib/milestones/repo";

// The attack, with the sandbox for real and the AI scripted. The model's claims never decide: running does.

const test1 = (body: string) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { double } from '../src/double.ts';\ntest('t', () => {\n${body}\n});`;
const WEAK = test1("  assert.equal(double(2), 4);");
const STRONG = test1("  assert.equal(double(2), 4);\n  assert.equal(double(21), 42);");
const NICE = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { double } from '../src/double.ts';\ntest('n', () => { assert.equal(double(1), 2); });";
const terms = (code = WEAK): Terms => ({
  criteria: [
    { id: "C1", text: "double(n) returns twice n for any number", kind: "must", check: "test", test: { path: "acceptance/c1.test.ts", code } },
    { id: "C2", text: "double(1) is 2", kind: "nice", check: "test", test: { path: "acceptance/c2.test.ts", code: NICE } },
  ],
  testCommand: "node --test 'acceptance/*.test.ts'",
});

const HARDCODED = "export function double(n: number): number {\n  return 4;\n}\n";
const REAL = "export function double(n: number): number {\n  return n * 2;\n}\n";
const PROBE = test1("  assert.equal(double(7), 14);");
const attackReply = (code: string) => JSON.stringify({ files: [{ path: "src/double.ts", code }], explanation: "It always returns 4.", probe: PROBE });

async function draft(t: Terms = terms(), fields: Record<string, unknown> = {}) {
  const base = { id: "00000000-0000-0000-0000-000000000000", title: "Test milestone", amount_cents: 30_000, currency: "USD", freelancer_email: "freelancer@example.com", repo: null };
  const id = await seedMilestone({ state: "DRAFT", criteria: JSON.stringify(t), ...fields });
  const m = await getMilestone(id);
  const hash = hashTerms({ ...base, id, currency: m.currency }, t);
  await db().query("update milestones set criteria_hash = $2 where id = $1", [id, hash]);
  return id;
}

/** Replies in order, keyed on nothing: the first call is the attack, the second the hardening. */
const scripted = (...replies: string[]): ModelCall & { count: () => number } => {
  let i = 0;
  const call: ModelCall = async () => replies[i++] ?? "{}";
  return Object.assign(call, { count: () => i });
};

beforeEach(resetDb);
after(() => db().end());

describe("attackTerms", () => {
  it("hardens: a hardcoded fake passes, the tests are rewritten, and the same fake then fails", async () => {
    const id = await draft();
    const before = await getMilestone(id);
    const call = scripted(attackReply(HARDCODED), JSON.stringify({ tests: [{ id: "C1", code: STRONG }] }));
    const m = await attackTerms(id, { call });
    const a = storedAttack(m)!;
    assert.equal(a.status, "hardened");
    assert.deepEqual(a.caughtBy, ["C1"]);
    assert.equal(call.count(), 2);
    assert.notEqual(m.criteria_hash, before.criteria_hash);
    assert.equal(a.terms, m.criteria_hash);
    const saved = termsSchema.parse(m.criteria);
    assert.equal(saved.criteria[0]!.test!.code, STRONG);
    assert.equal(saved.criteria[1]!.test!.code, NICE, "only must-have tests are attacked and rewritten");
  });

  it("survives: a must-have test fails on the fake, with one AI call and the terms untouched", async () => {
    const id = await draft(terms(STRONG));
    const before = await getMilestone(id);
    const call = scripted(attackReply(HARDCODED));
    const m = await attackTerms(id, { call });
    assert.equal(storedAttack(m)!.status, "survived");
    assert.deepEqual(storedAttack(m)!.caughtBy, ["C1"]);
    assert.equal(call.count(), 1);
    assert.equal(m.criteria_hash, before.criteria_hash);
  });

  it("doesn't count correct code as a cheat: the probe passes, so nothing is rewritten", async () => {
    const id = await draft();
    const before = await getMilestone(id);
    const m = await attackTerms(id, { call: scripted(attackReply(REAL)) });
    assert.equal(storedAttack(m)!.status, "survived");
    assert.deepEqual(storedAttack(m)!.caughtBy, []);
    assert.equal(m.criteria_hash, before.criteria_hash);
  });

  it("reports breakable, and keeps the terms and signatures, when a rewrite doesn't beat the fake", async () => {
    const id = await draft();
    const before = await getMilestone(id);
    await db().query("update milestones set worker_signed_hash = $2 where id = $1", [id, before.criteria_hash]);
    const m = await attackTerms(id, { call: scripted(attackReply(HARDCODED), JSON.stringify({ tests: [{ id: "C1", code: WEAK }] })) });
    assert.equal(storedAttack(m)!.status, "breakable");
    assert.equal(m.criteria_hash, before.criteria_hash);
    assert.equal(m.worker_signed_hash, before.criteria_hash);
  });

  it("rejects a rewrite that passes on empty code, even though it beats the fake", async () => {
    const id = await draft();
    const noop = "import test from 'node:test';\nimport { double } from '../src/double.ts';\ntest('t', () => { double(1); throw new Error('never'); });";
    const m = await attackTerms(id, { call: scripted(attackReply(HARDCODED), JSON.stringify({ tests: [{ id: "C1", code: noop }] })), check: async () => new Map([["C1", { kind: "weak", reason: "passes" }]]) });
    assert.equal(storedAttack(m)!.status, "breakable");
    assert.equal(termsSchema.parse(m.criteria).criteria[0]!.test!.code, WEAK);
  });

  it("keeps the attack out of the fingerprint and the public contract", async () => {
    const id = await draft(terms(STRONG));
    const m = await attackTerms(id, { call: scripted(attackReply(HARDCODED)) });
    const parsed = termsSchema.parse(m.criteria);
    assert.equal("attack" in parsed, false);
    assert.doesNotMatch(canonical(contractDocument(m, parsed)), /always returns 4/);
  });

  it("refuses agreed terms, and client-written tests are neither attacked nor run", async () => {
    const agreed = await draft(terms(), { state: "AGREED" });
    await assert.rejects(attackTerms(agreed, { call: scripted() }), /before both sides agree/);
    const t = terms();
    t.criteria[0]!.testBy = "client";
    const mine = await draft(t);
    await assert.rejects(attackTerms(mine, { call: scripted() }), /No AI-written must-have test/);
  });

  it("rejects fake files outside the source folders before anything runs", async () => {
    const id = await draft();
    const bad = JSON.stringify({ files: [{ path: "../../etc/x.ts", code: HARDCODED }], explanation: "x", probe: PROBE });
    await assert.rejects(attackTerms(id, { call: scripted(bad, bad, bad, bad, bad, bad) }));
  });
});
