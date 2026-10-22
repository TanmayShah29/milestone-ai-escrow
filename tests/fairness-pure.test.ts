import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { canonical, contractDocument, hashTerms, markStale, termsSchema, type Terms } from "@/lib/contract/terms";
import { subjectiveWords, termsWarnings } from "@/lib/contract/warnings";
import { clientLinkUrl, markLinkSaved, needsLinkReminder } from "@/lib/client/links";
import { writeDemo } from "@/lib/client/demo";

// Contract fairness without a database: old fingerprints stay put, new ones cover the policy and who wrote
// each test, subjective must-haves are warned about, and the client is reminded to save their link.

const m = { id: "00000000-0000-0000-0000-000000000001", title: "Dark mode", amount_cents: 30_000, currency: "USD" as const, freelancer_email: "w@example.com", repo: "acme/web" };
const NOOP = "import test from 'node:test';\ntest('c1', () => {});";
const old: Terms = {
  criteria: [
    { id: "C1", text: "Settings page has a dark mode toggle that persists across reloads", kind: "must", check: "test", test: { path: "acceptance/c1.test.ts", code: NOOP }, testWeak: true, weakReason: "passes against an empty implementation" },
    { id: "C2", text: "Toggle is reachable by keyboard", kind: "nice", check: "review" },
  ],
  testCommand: "node --test 'acceptance/*.test.ts'",
};
// Computed with the contract code at 0fcaa9f, before the policy and the testBy label existed.
const OLD_HASH = "fd54f3afad8b52b44ee2a42b1a651f744788fa1aa495917071d46b8250be79b4";
const policy = { platformFeeBps: 500, objectionWindowSeconds: 172_800 };

describe("contract document", () => {
  it("terms stored before this change hash exactly as they did when signed", () => {
    assert.equal(hashTerms(m, old), OLD_HASH);
    // As read back from the database: the stored JSON (with suggestions beside it) parsed again.
    const stored = JSON.parse(JSON.stringify({ ...old, suggestions: [{ text: "empty input returns empty", why: "edge" }] }));
    assert.equal(hashTerms(m, termsSchema.parse(stored)), OLD_HASH);
    assert.equal("policy" in contractDocument(m, old), false);
  });

  it("a policy written at save time is in the document and the hash", () => {
    const doc = contractDocument(m, { ...old, policy });
    assert.deepEqual(doc.policy, policy);
    assert.match(canonical(doc), /"policy":\{"objectionWindowSeconds":172800,"platformFeeBps":500\}/);
    assert.notEqual(hashTerms(m, { ...old, policy }), OLD_HASH);
    assert.notEqual(hashTerms(m, { ...old, policy: { ...policy, platformFeeBps: 1000 } }), hashTerms(m, { ...old, policy }));
    assert.notEqual(hashTerms(m, { ...old, policy: { ...policy, objectionWindowSeconds: 120 } }), hashTerms(m, { ...old, policy }));
  });

  it("an edit keeps the stored policy and ignores one sent by the client", () => {
    const prev = { ...old, policy };
    const forged = { ...old, policy: { ...policy, platformFeeBps: 0 } };
    assert.deepEqual(markStale(prev, forged).policy, policy);
    assert.equal(markStale(old, forged).policy, undefined);
  });
});

describe("test author label", () => {
  const ai: Terms = { ...old, criteria: old.criteria.map((c) => ({ ...c, testWeak: undefined, weakReason: undefined })) };
  const BITES = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { t } from '../src/theme.ts';\ntest('c1', () => { assert.equal(t(), 'dark'); });";
  const withCode = (t: Terms, code: string): Terms => ({ ...t, criteria: t.criteria.map((c) => (c.test ? { ...c, test: { ...c.test, code } } : c)) });

  it("is set when the client writes or changes a test, and is part of the hash", () => {
    const changed = markStale(ai, withCode(ai, BITES));
    assert.equal(changed.criteria[0]!.testBy, "client");
    assert.equal(changed.criteria[1]!.testBy, undefined);
    const fresh = markStale(undefined, ai);
    assert.equal(fresh.criteria[0]!.testBy, "client");
    const unlabeled = { ...changed, criteria: changed.criteria.map((c) => ({ ...c, testBy: undefined })) };
    assert.notEqual(hashTerms(m, changed), hashTerms(m, unlabeled));
  });

  it("is absent for AI-written tests, so their hashes don't change, and can't be forged either way", () => {
    assert.equal(markStale(ai, ai).criteria[0]!.testBy, undefined);
    assert.equal(hashTerms(m, markStale(ai, ai)), hashTerms(m, ai));
    // A client claiming the AI's test as theirs: stripped (the code didn't change).
    const claimed = { ...ai, criteria: ai.criteria.map((c) => ({ ...c, testBy: "client" as const })) };
    assert.equal(markStale(ai, claimed).criteria.some((c) => c.testBy), false);
    // A client dropping the label from their own unchanged test: kept.
    const theirs = markStale(ai, withCode(ai, BITES));
    const dropped = { ...theirs, criteria: theirs.criteria.map((c) => ({ ...c, testBy: undefined })) };
    assert.equal(markStale(theirs, dropped).criteria[0]!.testBy, "client");
  });

  it("goes with the test when the criterion switches to AI review", () => {
    const theirs = markStale(ai, withCode(ai, BITES));
    const review = markStale(theirs, { ...theirs, criteria: theirs.criteria.map((c, i) => (i === 0 ? { ...c, check: "review" as const } : c)) });
    assert.equal(review.criteria[0]!.test, undefined);
    assert.equal(review.criteria[0]!.testBy, undefined);
  });
});

describe("subjective must-haves", () => {
  it("finds taste words, whole words only", () => {
    assert.deepEqual(subjectiveWords("Code is clean and of good quality, following best practices"), ["clean", "good", "quality", "best practices"]);
    assert.deepEqual(subjectiveWords("Meets the client's expectations with a polished, professional look"), ["expectations", "polished", "professional"]);
    assert.deepEqual(subjectiveWords("cleanup() removes temp files; goodbye() logs out"), []);
  });

  it("warns on review-only must-haves, not on tested or nice-to-have ones", () => {
    const w = termsWarnings(
      [
        { id: "C1", text: "The code is clean", kind: "must", check: "review" },
        { id: "C2", text: "Returns good results for empty input", kind: "must", check: "test" },
        { id: "C3", text: "Nice, polished README", kind: "nice", check: "review" },
        { id: "C4", text: "README lists every command", kind: "must", check: "review" },
      ],
      "code_pr",
    );
    assert.deepEqual(w.subjective, [{ id: "C1", words: ["clean"] }]);
    assert.equal(w.noTestedMust, false);
  });

  it("warns when code work has no tested must-have; text deliverables never do", () => {
    const criteria = [{ id: "C1", text: "README lists every command", kind: "must" as const, check: "review" as const }];
    assert.equal(termsWarnings(criteria, "code_pr").noTestedMust, true);
    assert.equal(termsWarnings(criteria, "rubric_text").noTestedMust, false);
  });
});

describe("save your client link", () => {
  const store = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  beforeEach(() => store.clear());

  it("reminds a client until they dismiss it, per milestone; never a worker", () => {
    const h = { id: "m1", title: "t", client: "mct_a", shareWorker: "mwt_b" };
    assert.equal(needsLinkReminder(h), true);
    assert.equal(needsLinkReminder({ id: "m2", title: "t", worker: "mwt_c" }), false);
    markLinkSaved("m1");
    assert.equal(needsLinkReminder(h), false);
    assert.equal(needsLinkReminder({ ...h, id: "m3" }), true);
    // The dismissal store holds ids only, never a token.
    assert.doesNotMatch(store.get("milestone:link-saved")!, /mct_|mwt_/);
  });

  it("skips judge-mode demos, and survives broken storage", () => {
    writeDemo({ milestones: [{ id: "d1" }] } as unknown as Parameters<typeof writeDemo>[0]);
    assert.equal(needsLinkReminder({ id: "d1", title: "t", client: "mct_a", worker: "mwt_b" }), false);
    store.set("milestone:link-saved", "{not json");
    assert.equal(needsLinkReminder({ id: "m1", title: "t", client: "mct_a" }), true);
    markLinkSaved("m1");
    assert.equal(needsLinkReminder({ id: "m1", title: "t", client: "mct_a" }), false);
  });

  it("builds the full client link from the stored token", () => {
    assert.equal(clientLinkUrl("https://app.test", { id: "m1", title: "t", client: "mct_a" }), "https://app.test/milestones/m1?t=mct_a");
    assert.equal(clientLinkUrl("https://app.test", { id: "m1", title: "t", worker: "mwt_b" }), undefined);
  });
});
