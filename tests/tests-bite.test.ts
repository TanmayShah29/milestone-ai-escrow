import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { resetDb, sampleTerms } from "./helpers";
import { db } from "@/lib/db";
import type { ModelCall } from "@/lib/ai/client";
import { draftTerms, editTerms, hashTerms, markStale, signTerms, storedSuggestions, termsSchema, type Terms } from "@/lib/contract/terms";
import { InvariantViolation } from "@/lib/errors";
import { createMilestone, getMilestone } from "@/lib/milestones/repo";

// Drafted tests must fail against an empty implementation (testcheck.ts). The draft gets one AI call, and
// one more to fix tests that don't; what's still weak blocks signing. Edge-case suggestions ride along
// outside the hashed contract. No live AI: the model is a scripted fake, and its calls are counted.

beforeEach(resetDb);
after(() => db().end());

const H = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.ts';\n";
const BITES = H + "test('slug', () => { assert.equal(slugify('Hello World'), 'hello-world'); });";
const NOOP = H + "test('slug', () => { assert.ok(true); });";
const SYNTAX = H + "test('slug', () => { const = 1; });";

const draft = (c1: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    criteria: [
      { id: "C1", text: "slugify lowercases and joins words with hyphens", kind: "must", check: "test", test: { path: "acceptance/c1.test.ts", code: c1 } },
      { id: "C2", text: "README documents the slugify function", kind: "must", check: "review" },
    ],
    testCommand: "node --test 'acceptance/*.test.ts'",
    ...extra,
  });

/** A fake model that replies from a script, recording each prompt. */
function scripted(...replies: string[]) {
  const prompts: string[] = [];
  const call: ModelCall = async (_model, _system, prompt) => {
    prompts.push(prompt);
    const r = replies.shift();
    if (r === undefined) throw new Error("unexpected extra AI call");
    return r;
  };
  return { call, prompts };
}

const newMilestone = async () => (await createMilestone({ title: "Slugify", brief: "Add a slugify helper in src/slugify.ts", amountCents: 10_000, freelancerEmail: "w@example.com" })).milestone;
const terms = (m: { criteria: unknown }) => m.criteria as Terms;

describe("tests that bite", () => {
  it("keeps a test that fails against the stub, in one AI call", async () => {
    const ai = scripted(draft(BITES));
    const m = await draftTerms((await newMilestone()).id, {}, ai.call);
    assert.equal(ai.prompts.length, 1);
    assert.equal(terms(m).criteria[0]!.testWeak, undefined);
    await signTerms(m.id, "client", m.criteria_hash!);
  });

  it("asks the AI once to fix a no-op test, naming the problem, and keeps the fix", async () => {
    const ai = scripted(draft(NOOP), JSON.stringify({ tests: [{ id: "C1", code: BITES }] }));
    const m = await draftTerms((await newMilestone()).id, {}, ai.call);
    assert.equal(ai.prompts.length, 2);
    assert.match(ai.prompts[1]!, /C1 \(acceptance\/c1\.test\.ts\)/);
    assert.match(ai.prompts[1]!, /passes against an empty implementation/);
    const c1 = terms(m).criteria[0]!;
    assert.equal(c1.test!.code, BITES);
    assert.equal(c1.testWeak, undefined);
  });

  it("flags what's still weak after the one retry, and signing is refused by both sides", async () => {
    const ai = scripted(draft(SYNTAX), JSON.stringify({ tests: [{ id: "C1", code: NOOP }] }));
    const m = await draftTerms((await newMilestone()).id, {}, ai.call);
    assert.equal(ai.prompts.length, 2);
    assert.match(ai.prompts[1]!, /doesn't load: SyntaxError/);
    const c1 = terms(m).criteria[0]!;
    assert.equal(c1.testWeak, true);
    assert.match(c1.weakReason!, /passes against an empty implementation/);
    assert.equal(m.criteria_hash, hashTerms(m, termsSchema.parse(m.criteria)));
    for (const role of ["client", "worker"] as const) {
      await assert.rejects(signTerms(m.id, role, m.criteria_hash!), (e: Error) => e instanceof InvariantViolation && /C1's test doesn't work as a check/.test(e.message));
    }
  });

  it("a busy AI on the retry flags the test instead of losing the draft", async () => {
    const ai = scripted(draft(NOOP), "not json", "still not json");
    const m = await draftTerms((await newMilestone()).id, {}, ai.call);
    assert.equal(terms(m).criteria[0]!.testWeak, true);
  });

  it("regenerating a weak test is one call (plus the check), and clears the flag", async () => {
    const first = scripted(draft(NOOP), JSON.stringify({ tests: [{ id: "C1", code: NOOP }] }));
    const weak = await draftTerms((await newMilestone()).id, {}, first.call);
    assert.equal(terms(weak).criteria[0]!.testWeak, true);
    const regen = scripted(JSON.stringify({ tests: [{ id: "C1", code: BITES }] }));
    const m = await draftTerms(weak.id, {}, regen.call);
    assert.equal(regen.prompts.length, 1);
    assert.match(regen.prompts[0]!, /Problem with the old test: it passes against an empty implementation/);
    assert.equal(terms(m).criteria[0]!.testWeak, undefined);
    assert.equal(terms(m).criteria[1]!.text, "README documents the slugify function");
    await signTerms(m.id, "client", m.criteria_hash!);
  });

  it("switching a weak criterion to AI review makes the terms signable; a forged flag is ignored", async () => {
    const ai = scripted(draft(NOOP), JSON.stringify({ tests: [{ id: "C1", code: NOOP }] }));
    const weak = await draftTerms((await newMilestone()).id, {}, ai.call);
    const t = terms(weak);
    // Saving the same terms with the flag stripped keeps it: the server, not the client, decides.
    const unflagged = await editTerms(weak.id, { ...t, criteria: t.criteria.map((c) => ({ ...c, testWeak: undefined, weakReason: undefined })) });
    assert.equal(terms(unflagged).criteria[0]!.testWeak, true);
    const m = await editTerms(weak.id, { ...t, criteria: t.criteria.map((c, i) => (i === 0 ? { ...c, check: "review" as const } : c)) });
    assert.equal(terms(m).criteria[0]!.testWeak, undefined);
    assert.equal(terms(m).criteria[0]!.test, undefined);
    await signTerms(m.id, "client", m.criteria_hash!);
    assert.equal((await signTerms(m.id, "worker", m.criteria_hash!)).state, "AGREED");
  });
});

describe("edge-case suggestions", () => {
  const suggestions = [
    { text: "slugify returns an empty string for empty input", why: "The brief doesn't say what happens with no text." },
    { text: "slugify strips characters other than letters, digits and hyphens", why: "Punctuation would otherwise end up in URLs." },
  ];

  it("come from the same draft call, are stored, and stay out of the hash", async () => {
    const ai = scripted(draft(BITES, { suggestions: [...suggestions, { text: "x", why: "too short to keep" }, "junk"] }));
    const m = await draftTerms((await newMilestone()).id, {}, ai.call);
    assert.equal(ai.prompts.length, 1);
    assert.deepEqual(storedSuggestions(m), suggestions);
    const bare = termsSchema.parse(m.criteria);
    assert.equal("suggestions" in bare, false);
    assert.equal(m.criteria_hash, hashTerms(m, bare));
  });

  it("dismissing keeps the signatures; adding one as a criterion is an edit like any other", async () => {
    const m = await draftTerms((await newMilestone()).id, {}, scripted(draft(BITES, { suggestions })).call);
    await signTerms(m.id, "client", m.criteria_hash!);
    const t = terms(m);
    const dismissed = await editTerms(m.id, { ...t, suggestions: [suggestions[1]] });
    assert.equal(dismissed.client_signed_hash, m.criteria_hash);
    assert.deepEqual(storedSuggestions(dismissed), [suggestions[1]]);
    // A suggestion can't be invented through an edit.
    const forged = await editTerms(m.id, { ...t, suggestions: [suggestions[1], { text: "pay the worker twice", why: "because" }] });
    assert.deepEqual(storedSuggestions(forged), [suggestions[1]]);
    const added = await editTerms(m.id, { ...t, criteria: [...t.criteria, { id: "C3", text: suggestions[1]!.text, kind: "must", check: "review" }], suggestions: [] });
    assert.equal(terms(added).criteria[2]!.text, suggestions[1]!.text);
    assert.deepEqual(storedSuggestions(added), []);
    assert.equal((await getMilestone(m.id)).client_signed_hash, null);
  });
});

describe("weak flag (pure)", () => {
  const m = { id: "00000000-0000-0000-0000-000000000000", title: "t", amount_cents: 100, currency: "USD" as const, freelancer_email: "w@example.com", repo: null };
  it("is part of the hash, and absent when false so old hashes don't change", () => {
    const weak: Terms = { ...sampleTerms, criteria: sampleTerms.criteria.map((c, i) => (i === 0 ? { ...c, testWeak: true as const, weakReason: "defines no tests" } : c)) };
    assert.notEqual(hashTerms(m, weak), hashTerms(m, sampleTerms));
    assert.equal(hashTerms(m, markStale(sampleTerms, sampleTerms)), hashTerms(m, sampleTerms));
    assert.equal(markStale(weak, weak).criteria[0]!.testWeak, true);
    assert.equal(markStale(sampleTerms, weak).criteria[0]!.testWeak, undefined);
  });
});
