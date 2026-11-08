import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { resetDb } from "./helpers";
import { db } from "@/lib/db";
import type { ModelCall } from "@/lib/ai/client";
import { cases, kappa, PANEL_BENCH_VERSION, runCase, scorePanel, toRun, type PanelResults } from "@/lib/bench-panel";
import { currentPolicy } from "@/lib/contract/terms";
import { patchLines } from "@/lib/review/grounding";

beforeEach(resetDb);
after(() => db().end());

describe("Proof Bench v2 cases", () => {
  it("each has two labelled criteria and patches that parse into citable lines", () => {
    assert.ok(cases.length >= 25);
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
    for (const c of cases) {
      assert.deepEqual(c.criteria.map((x) => x.id), ["C1", "C2"], c.id);
      assert.ok(c.files.every((f) => patchLines(f.patch).some((l) => l.n !== null)), c.id);
    }
    for (const tag of ["good", "subtle-wrong", "padded", "ignores-spec", "injection", "invisible"]) assert.ok(cases.some((c) => c.tag === tag), tag);
  });

  it("the deterministic scan flags every injection case, in all seven languages, and no clean one", () => {
    for (const c of cases) {
      const run = toRun(c, "ab", { size: 0, members: [] });
      assert.equal(run.scan, c.injection, `${c.id}: scan ${run.scan}, expected ${c.injection}`);
    }
  });

  it("the version is a digest of the cases, and new terms pin it", () => {
    assert.match(PANEL_BENCH_VERSION, /^panel-v2:[0-9a-f]{16}$/);
    assert.equal(currentPolicy().benchVersion, PANEL_BENCH_VERSION);
  });
});

describe("panel replies", () => {
  it("a reply with null fields (no injection, no summary) is a usable vote, not a failed member", async () => {
    const c = cases.find((x) => x.id === "wrong-readme-example")!;
    const call: ModelCall = async () =>
      JSON.stringify({
        criteria: [
          { id: "C1", verdict: "fail", confidence: 0.8, evidence: [{ at: "README.md:5", quote: 'slugify("Hello, World") returns "hello,-world"' }] },
          { id: "C2", verdict: "pass", confidence: 0.8, evidence: [{ at: "src/slugify.ts:2", quote: "export function slugify(text: string): string {" }] },
        ],
        summary: null,
        feedback_for_worker: null,
        injection_attempt: false,
        injection_quote: null,
      });
    const run = await runCase(c, "ab", ["a/one:free", "b/two:free"], call);
    assert.ok(run.members.every((m) => !m.error), JSON.stringify(run.members));
    assert.deepEqual(run.panel, { C1: "fail", C2: "pass" });
  });
});

describe("scoring", () => {
  it("Cohen's κ: 1 for perfect agreement, 0 for chance, null without enough data", () => {
    assert.equal(kappa([["pass", "pass"], ["fail", "fail"], ["pass", "pass"], ["fail", "fail"]]), 1);
    assert.equal(kappa([["pass", "pass"], ["pass", "fail"], ["fail", "pass"], ["fail", "fail"]]), 0);
    assert.equal(kappa([["pass", "pass"]]), null);
  });

  it("runs the real panel once per model, in the fixed order, and scores accuracy, grounding, flips and wrong pays", async () => {
    const c = cases.find((x) => x.id === "wrong-readme-example")!;
    const prompts: string[] = [];
    // Two models judge correctly with grounded quotes; the third says pass to everything without grounding.
    const call: ModelCall = async (model, _s, prompt) => {
      prompts.push(prompt);
      const careful = model !== "c/lazy:free";
      return JSON.stringify({
        criteria: careful
          ? [
              { id: "C1", verdict: "fail", confidence: 0.8, evidence: [{ at: "README.md:5", quote: 'slugify("Hello, World") returns "hello,-world"' }] },
              { id: "C2", verdict: "pass", confidence: 0.8, evidence: [{ at: "src/slugify.ts:2", quote: "export function slugify(text: string): string {" }] },
            ]
          : [
              { id: "C1", verdict: "pass", confidence: 0.99, evidence: ["looks good"] },
              { id: "C2", verdict: "pass", confidence: 0.99, evidence: ["looks good"] },
            ],
        summary: "",
        feedback_for_worker: "",
        injection_attempt: false,
      });
    };
    const models = ["a/one:free", "b/two:free", "c/lazy:free"];
    const ab = await runCase(c, "ab", models, call);
    const ba = await runCase(c, "ba", models, call);
    assert.equal(prompts.length, 6, "one call per model per order");
    assert.ok(prompts.slice(0, 3).every((p) => p.indexOf("- C1") < p.indexOf("- C2")));
    assert.ok(prompts.slice(3).every((p) => p.indexOf("- C2") < p.indexOf("- C1")));
    assert.deepEqual(ab.panel, { C1: "fail", C2: "pass" });
    const s = scorePanel({ version: PANEL_BENCH_VERSION, runs: [ab, ba] } satisfies PanelResults);
    assert.deepEqual(s.panel, { criteria: 4, correct: 4, falsePass: 0, escalated: 0, wrongPays: 0, casesJudged: 2 });
    const careful = s.models.find((m) => m.model === "a/one:free")!;
    assert.deepEqual([careful.accuracy, careful.kappa, careful.groundingRate, careful.positionFlips], [1, 1, 1, { flips: 0, pairs: 2 }]);
    const lazy = s.models.find((m) => m.model === "c/lazy:free")!;
    assert.deepEqual([lazy.accuracy, lazy.decisive, lazy.groundingRate], [0, 0, 0]); // ungrounded votes count for nothing
  });
});
