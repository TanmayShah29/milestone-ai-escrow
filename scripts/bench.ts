// Proof Bench: runs both approvers over bench/cases and writes bench/results.json.
//   npm run bench               re-run Milestone's side; reuse cached LLM answers for unchanged cases
//   npm run bench -- --fresh    ask the LLM again for every case
//   npm run bench -- --budget 4 at most 4 model calls this run (fallthrough to a fallback model counts)
//   npm run bench -- --no-llm   Milestone's side only (no key, no database needed)
//   npm run bench -- --only honest,stub-confident
// The LLM side needs OPENROUTER_API_KEY, AI_MODEL (+ fallbacks) and DATABASE_URL (the app's AI client logs
// each call and enforces AI_DAILY_CAP). See bench/README.md for the method.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { AiBusy, configuredModels, generateJson, openRouterCall, type ModelCall } from "@/lib/ai/client";
import {
  benchTermsHash,
  hardened,
  hardenedTermsHash,
  LLM_SYSTEM,
  llmPrompt,
  llmPromptHash,
  llmReplySchema,
  loadCases,
  RESULTS_PATH,
  runMilestone,
  score,
  type BenchCaseResult,
  type BenchResults,
  type LlmResult,
} from "@/lib/bench";

class BudgetSpent extends Error {}

function args() {
  const a = process.argv.slice(2);
  const val = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    fresh: a.includes("--fresh"),
    noLlm: a.includes("--no-llm"),
    budget: Number(val("--budget") ?? "14"),
    only: val("--only")?.split(",").filter(Boolean),
  };
}

async function previous(): Promise<BenchResults | undefined> {
  try {
    return JSON.parse(await readFile(RESULTS_PATH, "utf8")) as BenchResults;
  } catch {
    return undefined;
  }
}

async function main() {
  const opts = args();
  const prev = await previous();
  const cases = (await loadCases()).filter((c) => !opts.only || opts.only.includes(c.id));
  let calls = 0;
  const counted: ModelCall = async (...a) => {
    if (calls >= opts.budget) throw new BudgetSpent(`the bench's budget of ${opts.budget} model calls is spent`);
    calls++;
    return openRouterCall(...a);
  };

  const out: BenchCaseResult[] = [];
  for (const c of cases) {
    const milestone = await runMilestone(c);
    const milestoneHardened = hardened?.criteria ? await runMilestone(c, "hardened") : undefined;
    const cached = prev?.cases.find((p) => p.id === c.id);
    let llmOnly: LlmResult | undefined;
    if (cached && cached.contentHash === c.contentHash && cached.llmOnly.promptHash === llmPromptHash && (cached.llmOnly.status === "ok" || opts.noLlm) && !opts.fresh) {
      llmOnly = cached.llmOnly;
    } else if (opts.noLlm) {
      llmOnly = { status: "error", error: "not run (--no-llm)", promptHash: llmPromptHash, at: new Date().toISOString() };
    } else {
      const started = Date.now();
      const at = new Date().toISOString();
      try {
        const { value, model } = await generateJson({ purpose: "bench", system: LLM_SYSTEM, prompt: llmPrompt(c), schema: llmReplySchema, maxOutputTokens: 3000, call: counted });
        llmOnly = { status: "ok", pay: value.pay, perCriterion: value.criteria, model, rawSummary: value.summary, promptHash: llmPromptHash, latencyMs: Date.now() - started, at };
      } catch (err) {
        // A busy free tier is recorded, not fatal: the next run asks again for this case only.
        const status = err instanceof BudgetSpent ? "skipped" : err instanceof AiBusy ? "busy" : "error";
        llmOnly = cached?.llmOnly.status === "ok" && cached.contentHash === c.contentHash ? cached.llmOnly : { status, error: String(err).replace(/^Error: /, "").slice(0, 300), promptHash: llmPromptHash, at };
      }
    }
    const row: BenchCaseResult = { id: c.id, title: c.title, expected: { pay: c.shouldPay, reason: c.reason }, contentHash: c.contentHash, llmOnly, milestone, ...(milestoneHardened ? { milestoneHardened } : {}) };
    out.push(row);
    const llm = llmOnly.status === "ok" ? (llmOnly.pay ? "pay" : "don't pay") : llmOnly.status;
    console.log(`${c.id.padEnd(22)} expected ${c.shouldPay ? "pay" : "don't pay"}; LLM-only ${llm}${llmOnly.status === "ok" ? ` (${llmOnly.model})` : ""}; Milestone ${milestone.decision}${milestoneHardened ? ` (after attack: ${milestoneHardened.decision})` : ""}`);
  }

  // Cases not re-run with --only keep their previous rows.
  const rows = opts.only && prev ? [...prev.cases.filter((p) => !opts.only!.includes(p.id)), ...out].sort((a, b) => a.id.localeCompare(b.id)) : out;
  const results: BenchResults = {
    meta: {
      date: new Date().toISOString(),
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      node: process.version,
      models: configuredModels(),
      termsHash: benchTermsHash,
      harness: "bench/harness/run-tests.mjs, copied from TanmayShah29/milestone-demo .github/milestone/run-tests.mjs at 163c3705",
      llmPromptHash,
      llmSystem: LLM_SYSTEM,
      llmCalls: (prev && !opts.fresh ? prev.meta.llmCalls : 0) + calls,
      ...(hardened ? { attack: { status: hardened.status, model: hardened.model, at: hardened.at, explanation: hardened.explanation, caughtBy: hardened.caughtBy, termsHash: hardenedTermsHash ?? null } } : {}),
    },
    cases: rows,
  };
  await writeFile(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
  const s = score(results);
  console.log(`\n${calls} model call(s) this run.`);
  console.log(`LLM-only: paid ${s.llm.paidCheats} of ${s.cheats} cheats, blocked ${s.llm.blockedHonest} of ${s.honest} honest (${s.llm.answered} of ${s.total} answered).`);
  console.log(`Milestone (drafted tests): paid ${s.milestone.paidCheats} of ${s.cheats} cheats, blocked ${s.milestone.blockedHonest} of ${s.honest} honest.`);
  console.log(`Milestone (after the attack): paid ${s.shipped.paidCheats} of ${s.cheats} cheats, blocked ${s.shipped.blockedHonest} of ${s.honest} honest.`);
}

main()
  .then(async () => {
    if (!args().noLlm && process.env.DATABASE_URL) await (await import("@/lib/db")).db().end();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
