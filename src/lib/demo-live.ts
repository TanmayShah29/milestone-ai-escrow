import { createHash } from "node:crypto";
import type { Terms } from "@/lib/contract/terms";
import { db, withMilestoneLock } from "@/lib/db";
import { seed } from "@/lib/demo";
import { getMilestone, type Milestone } from "@/lib/milestones/repo";
import { feeBps } from "@/lib/money/amounts";
import { cancelHold, defaultDeps, fundWithTestCard } from "@/lib/money/flow";
import { githubPrWriter, type GitHub, type GitHubPrWriter } from "@/lib/review/github";
import { acceptanceCheckName, CI_APP } from "@/lib/review/verifiers";
import { defaultReviewDeps, submitDeliverable, tick, type ReviewDeps } from "@/lib/review/run";
import type { Verdict } from "@/lib/review/policy";
import { configuredModels, openRouterCall, type ModelCall } from "@/lib/ai/client";

// Judge "run it live": one click runs the real flow on sandbox. A real PayPal hold on a test card, a real PR
// from a branch prepared in the demo repo, real CI on the signed tests, a real AI review of the one criterion
// no test can check, then fixed rules capture and pay out, or catch the cheat with the money still held.
// The AI criterion is a nice-to-have, so it can never decide the money, and free-model limits can't stall a
// run: a busy model falls back to the last AI verdict on the same commit, then to "unclear" (liveAiCall).
// Each poll from the page moves the run one idempotent step; this code only calls the same functions a client
// and a worker would. A closed page leaves the rest to the /api/tick sweep.

export type LiveKind = "honest" | "cheat";
export type LiveRun = {
  id: string;
  kind: LiveKind;
  milestone_id: string;
  pr_url: string | null;
  status: "running" | "done" | "failed";
  outcome: "paid" | "caught" | "person" | null;
  error: string | null;
  failures: number;
  advanced_at: Date;
  created_at: Date;
};
export type LiveDeps = { review: ReviewDeps; writer: GitHubPrWriter };

const OWNER = "TanmayShah29";
const REPO = "milestone-demo";
const BRANCH: Record<LiveKind, string> = { honest: "live/honest", cheat: "live/cheat" };
const AMOUNT_CENTS = 1200;
/** Signed in this deal's terms, so a judge sees the release without waiting two minutes. */
const WINDOW_SECONDS = 30;
const MIN_STEP_MS = 2_000;
/** A step can wait on a model for up to 90 s; polls that arrive meanwhile only read progress. */
const STEP_LEASE_MS = 120_000;
const ABANDONED_AFTER_MS = 90_000; // no page has polled for this long, so another judge may take the branch
const DEADLINE_MS = 10 * 60_000;
const MAX_FAILURES = 5; // consecutive; each funding retry also moves on to the next sandbox test card
const OLD_HOLD_MS = 60 * 60_000;
export const MAX_RUNS_PER_HOUR = 20;

const test = (name: string, body: string) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { initials } from '../src/initials.ts';\n\ntest('${name}', () => {\n${body}\n});`;

/** The live demo's contract (also the Proof Bench contract, bench/). */
export const criteria: Terms["criteria"] = [
  { id: "C1", text: "src/initials.ts exports initials(name: string): string, and initials('Ada Lovelace') returns 'AL'.", kind: "must", check: "test", test: { path: "acceptance/c1.test.ts", code: test("first letters", "  assert.equal(initials('Ada Lovelace'), 'AL');") } },
  { id: "C2", text: "Letters are uppercased and any run of whitespace separates words.", kind: "must", check: "test", test: { path: "acceptance/c2.test.ts", code: test("case and whitespace", "  assert.equal(initials('  grace   brewster\\thopper '), 'GBH');") } },
  { id: "C3", text: "Empty or whitespace-only input returns an empty string.", kind: "must", check: "test", test: { path: "acceptance/c3.test.ts", code: test("blank input", "  assert.equal(initials(''), '');\n  assert.equal(initials(' \\t '), '');") } },
  { id: "C4", text: "src/initials.ts starts with a comment that truthfully says, in plain words, what the function returns.", kind: "nice", check: "review" },
];

// The AI step of a live run. One model only (the fallbacks are slow reasoning models, and a judge is watching).
// A reply is kept per exact prompt, which names the commit's diff: when the model is busy or slow, the last
// reply for the same commit stands in, and with none, C4 is "unclear", which a nice-to-have can afford.
async function rememberedReply(key: string): Promise<string | undefined> {
  const { rows } = await db().query<{ reply: string }>("select reply from live_ai_replies where prompt_hash = $1", [key]);
  return rows[0]?.reply;
}

export function liveAiCall(live: ModelCall): ModelCall {
  return async (model, system, prompt, maxOutputTokens) => {
    const key = createHash("sha256").update(`${system}\n${prompt}`).digest("hex");
    try {
      const reply = await live(model, system, prompt, maxOutputTokens);
      await db().query("insert into live_ai_replies (prompt_hash, reply, model) values ($1, $2, $3) on conflict (prompt_hash) do update set reply = excluded.reply, model = excluded.model, created_at = now()", [key, reply, model]);
      return reply;
    } catch (err) {
      const kept = await rememberedReply(key);
      if (kept) return kept;
      console.warn(`live run AI review fell back to unclear: ${String(err).slice(0, 200)}`);
      return JSON.stringify({
        criteria: criteria.filter((c) => !c.test).map((c) => ({ id: c.id, verdict: "unclear", confidence: 0, evidence: ["the free AI model was busy, so this nice-to-have was not judged"] })),
        summary: "",
        feedback_for_worker: "",
        injection_attempt: false,
      });
    }
  };
}

function defaults(): LiveDeps {
  const review = defaultReviewDeps();
  const models = configuredModels().slice(0, 1);
  return { review: { ...review, aiCall: liveAiCall(review.aiCall ?? openRouterCall), models }, writer: githubPrWriter() };
}

/** Runs started in the last hour (a global brake on the free tier and the sandbox). */
export async function liveRunsLastHour(): Promise<number> {
  const { rows } = await db().query<{ n: string }>("select count(*) as n from live_runs where created_at > now() - interval '1 hour'");
  return Number(rows[0]!.n);
}

/** Is a run of this kind going? Clears runs nobody is watching, so a closed tab doesn't block the next judge. */
export async function liveRunBusy(kind: LiveKind): Promise<boolean> {
  await db().query("update live_runs set status = 'failed', error = 'This run stopped because its page was closed.' where status = 'running' and advanced_at < now() - make_interval(secs => $1)", [ABANDONED_AFTER_MS / 1000]);
  const { rows } = await db().query("select 1 from live_runs where kind = $1 and status = 'running'", [kind]);
  return rows.length > 0;
}

export type StartedRun = { runId: string; milestoneId: string; title: string; client: string; worker: string };

/** Sets up the deal, signed by both sides, or returns undefined when another run of this kind got there first. */
export async function startLiveRun(kind: LiveKind, deps: { money?: Parameters<typeof cancelHold>[1] } = {}): Promise<StartedRun | undefined> {
  await voidOldHolds(deps.money).catch((err: unknown) => console.warn(`live run hold cleanup failed: ${String(err).slice(0, 200)}`));
  const now = Date.now();
  const title = kind === "honest" ? "Add an initials helper (honest worker)" : "Add an initials helper (cheating worker)";
  const seeded = await seed({
    title,
    brief: "Add src/initials.ts exporting initials(name: string): string.",
    cents: AMOUNT_CENTS,
    created: now,
    due: now + 86_400_000,
    terms: { criteria, testCommand: "node --test 'acceptance/*.test.ts'", policy: { platformFeeBps: feeBps(), objectionWindowSeconds: WINDOW_SECONDS } },
    history: [["terms:agreed", "AGREED", now]],
    set: { state: "AGREED" },
  });
  try {
    // advanced_at is set back so the page's first poll moves straight on to funding.
    const { rows } = await db().query<{ id: string }>("insert into live_runs (kind, milestone_id, advanced_at) values ($1, $2, now() - interval '3 seconds') returning id", [kind, seeded.id]);
    return { runId: rows[0]!.id, milestoneId: seeded.id, title, client: seeded.client, worker: seeded.worker };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return undefined;
    throw err;
  }
}

/** Sandbox holds from finished runs go back after an hour, so they don't pile up on the test cards. */
async function voidOldHolds(money = defaultDeps()): Promise<void> {
  const { rows } = await db().query<{ id: string }>(
    `select m.id from live_runs r join milestones m on m.id = r.milestone_id
      where r.status <> 'running' and r.created_at < now() - make_interval(secs => $1) and m.paypal_authorization_id is not null and m.paypal_capture_id is null
        and m.state in ('FUNDED', 'SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED', 'HUMAN_CHECK', 'PASSED')
      order by r.created_at limit 2`,
    [OLD_HOLD_MS / 1000],
  );
  for (const { id } of rows) await cancelHold(id, money, { actor: "system" });
}

async function closePrs(kind: LiveKind, writer: GitHubPrWriter): Promise<void> {
  for (const n of await writer.openPrNumbers(OWNER, REPO, BRANCH[kind])) await writer.closePr(OWNER, REPO, n);
}

async function openPr(run: LiveRun, m: Milestone, writer: GitHubPrWriter): Promise<string> {
  await closePrs(run.kind, writer); // left by a run whose page was closed; a branch can have one open PR
  const url = await writer.createPr(OWNER, REPO, {
    title: run.kind === "honest" ? "Add initials helper" : "Add initials helper (quick version)",
    body: `Opened by a live Milestone demo run for judges. This PR closes when the run ends.\n\nMilestone-Terms: ${m.criteria_hash}`,
    head: BRANCH[run.kind],
    base: "main",
  });
  await db().query("update live_runs set pr_url = $2 where id = $1", [run.id, url]);
  return url;
}

function outcomeOf(state: string): { status: "done"; outcome: "paid" | "caught" | "person" } | { status: "failed"; error: string } | undefined {
  if (state === "PAID_OUT") return { status: "done", outcome: "paid" };
  if (state === "CHANGES_REQUESTED") return { status: "done", outcome: "caught" };
  if (state === "HUMAN_CHECK") return { status: "done", outcome: "person" };
  if (state === "CANCELLED") return { status: "failed", error: "PayPal ended the hold before the run finished." };
  if (state === "PAYOUT_FAILED") return { status: "failed", error: "The hold was captured, but PayPal returned the sandbox payout." };
  return undefined;
}

async function step(run: LiveRun, deps: LiveDeps): Promise<void> {
  try {
    const m = await withMilestoneLock(run.milestone_id, async () => {
      let m = await getMilestone(run.milestone_id);
      if (m.state === "AGREED") m = await fundWithTestCard(m.id, deps.review.money);
      if (m.state === "FUNDED") m = await submitDeliverable(m.id, { prUrl: run.pr_url ?? (await openPr(run, m, deps.writer)) }, deps.review);
      return tick(m.id, deps.review);
    });
    const end = outcomeOf(m.state);
    if (end) {
      await db().query("update live_runs set status = $2, outcome = $3, error = $4, failures = 0 where id = $1", [run.id, end.status, end.status === "done" ? end.outcome : null, end.status === "failed" ? end.error : null]);
      await closePrs(run.kind, deps.writer).catch((err: unknown) => console.warn(`live run PR close failed: ${String(err).slice(0, 200)}`));
    } else if (Date.now() - new Date(run.created_at).getTime() > DEADLINE_MS) {
      await db().query("update live_runs set status = 'failed', error = 'GitHub or PayPal took too long, so this run stopped.' where id = $1", [run.id]);
    } else if (run.failures) {
      await db().query("update live_runs set failures = 0 where id = $1", [run.id]);
    }
  } catch (err) {
    console.warn(`live run ${run.id} step failed: ${String(err).slice(0, 300)}`);
    const giveUp = run.failures + 1 >= MAX_FAILURES;
    await db().query("update live_runs set failures = failures + 1, status = case when $2 then 'failed' else status end, error = case when $2 then $3 else error end where id = $1", [
      run.id,
      giveUp,
      "PayPal's sandbox or GitHub isn't answering right now, so this run stopped.",
    ]);
  }
}

/** One poll: move the run a step (at most one every MIN_STEP_MS, whoever asks) and report where it stands. */
export async function advanceLiveRun(id: string, deps: LiveDeps = defaults()): Promise<LiveProgress | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  const { rows } = await db().query<LiveRun>(
    "update live_runs set advanced_at = now() + make_interval(secs => $3) where id = $1 and status = 'running' and advanced_at <= now() - make_interval(secs => $2) returning *",
    [id, MIN_STEP_MS / 1000, STEP_LEASE_MS / 1000],
  );
  if (rows[0]) {
    try {
      await step(rows[0], deps);
    } finally {
      await db().query("update live_runs set advanced_at = now() where id = $1", [id]);
    }
  }
  return liveProgress(id, deps.review.github);
}

// ---------------------------------------------------------------------------------------------
// What the page shows. Public to anyone holding the run id: no emails or link tokens.

export type LiveStep = {
  key: string;
  label: string;
  state: "done" | "active" | "todo" | "failed" | "skipped";
  detail?: string;
  id?: string; // a PayPal id or fingerprint, set in mono
  links?: { label: string; href: string }[];
  until?: string; // the objection window's end, for a countdown
};
/** Where the money is: on the client's card, held at PayPal, or with the worker. */
export type MoneyAt = "client" | "hold" | "worker";
export type LiveProgress = {
  id: string;
  kind: LiveKind;
  status: LiveRun["status"];
  outcome: LiveRun["outcome"];
  error: string | null;
  milestoneId: string;
  amountCents: number;
  payoutCents: number | null; // what reached the worker, once paid
  moneyAt: MoneyAt;
  steps: LiveStep[];
};
/** GitHub's live state of each signed test while CI runs, by criterion id. */
export type CiLive = Record<string, "queued" | "running" | "passed" | "failed">;

const money = (c: number | null | undefined) => (c == null ? "" : `$${(c / 100).toFixed(2)}`);
const urlIn = (s: string) => /https:\/\/\S+/.exec(s)?.[0];

/** "$10.39 to the worker: $12.00 − $0.80 PayPal fee − …", from the amounts stored at capture. */
export function payoutLine(m: Pick<Milestone, "captured_cents" | "payout_cents" | "paypal_fee_cents" | "payout_fee_cents" | "fee_cents" | "payout_status">): string {
  const parts = [
    m.paypal_fee_cents ? `${money(m.paypal_fee_cents)} PayPal fee` : "",
    m.payout_fee_cents ? `${money(m.payout_fee_cents)} payout fee` : "",
    m.fee_cents ? `${money(m.fee_cents)} platform fee` : "",
  ].filter(Boolean);
  const sum = parts.length && m.captured_cents != null ? `: ${money(m.captured_cents)} − ${parts.join(" − ")}` : " after fees";
  return `${money(m.payout_cents)} to the worker${sum}. PayPal says ${m.payout_status ?? "pending"}.`;
}

export function buildSteps(run: Pick<LiveRun, "status" | "pr_url">, m: Milestone, review: { verdict: Verdict | null; reasons: string[] | null; decision: string | null } | undefined, ci: CiLive = {}): LiveStep[] {
  const decided = !!review?.decision;
  const passed = review?.decision === "PASSED";
  const stopped = decided && !passed; // the money never moves past the decision
  const held = !!m.paypal_authorization_id;
  const steps: LiveStep[] = [
    { key: "terms", label: "Both sides signed the terms", state: "done", detail: "Three tests decide the payment. An AI reviewer checks a fourth, nice-to-have point. It can't move money.", ...(m.criteria_hash ? { id: m.criteria_hash.slice(0, 16), links: [{ label: "Signed contract", href: `/api/contracts/${m.criteria_hash}` }] } : {}) },
    { key: "hold", label: `PayPal holds ${money(m.amount_cents)}`, state: held ? "done" : "active", detail: held ? "An authorization on a sandbox test card. Nothing is charged yet." : "Placing the hold…", ...(held ? { id: m.paypal_authorization_id! } : {}) },
    { key: "pr", label: "The worker opens a pull request", state: run.pr_url ? "done" : held ? "active" : "todo", ...(run.pr_url ? { links: [{ label: "Pull request on GitHub", href: run.pr_url }] } : {}) },
  ];
  const all = review?.verdict?.criteria ?? [];
  const criteria = all.filter((c) => c.source === "test");
  const word = (v: string) => (v === "pass" ? "passed" : v === "fail" ? "failed" : "unclear");
  const liveIds = Object.keys(ci);
  const ciDone = decided || (liveIds.length > 0 && liveIds.every((k) => ci[k] === "passed" || ci[k] === "failed"));
  steps.push({
    key: "ci",
    label: "GitHub Actions runs the signed tests",
    state: ciDone ? "done" : run.pr_url ? "active" : "todo",
    ...(decided
      ? { detail: criteria.map((c) => `${c.id} ${word(c.verdict)}`).join(" · ") }
      : liveIds.length
        ? { detail: liveIds.map((k) => `${k} ${ci[k]}`).join(" · ") }
        : run.pr_url
          ? { detail: "Starting the jobs. Usually about a minute." }
          : {}),
    ...(decided ? { links: criteria.flatMap((c) => { const href = urlIn(c.evidence[0] ?? ""); return href ? [{ label: `Test log (${c.id})`, href }] : []; }) } : run.pr_url ? { links: [{ label: "Watch the checks", href: `${run.pr_url}/checks` }] } : {}),
  });
  const ai = all.find((c) => c.source === "ai");
  const model = review?.verdict?.model;
  steps.push({
    key: "ai",
    label: "The AI reviewer checks what tests can't",
    state: decided ? "done" : ciDone ? "active" : "todo",
    ...(decided && ai
      ? {
          detail: ai.verdict === "unclear" && ai.confidence === 0
            ? "The free AI model was busy, so C4 wasn't judged. It's a nice-to-have, so the payment doesn't wait on it."
            : `C4 ${word(ai.verdict)}${ai.evidence[0] ? `: “${ai.evidence[0].slice(0, 160)}”` : ""}${review?.verdict?.injection?.detected ? ". It also reports text aimed at the reviewer" : ""}`,
          ...(model ? { id: model } : {}),
        }
      : ciDone
        ? { detail: "Reading the diff for C4, and for any text aimed at the reviewer. A free model can take 30 seconds." }
        : {}),
  });
  const quotes = review?.verdict?.injection?.quotes ?? [];
  steps.push({
    key: "decision",
    label: !decided ? "Fixed rules decide" : passed ? "Fixed rules: passed" : m.state === "HUMAN_CHECK" ? "Fixed rules: a person must decide" : "Fixed rules: not paid",
    state: !decided ? "todo" : passed ? "done" : "failed",
    ...(decided ? { detail: [...(review?.reasons ?? []), ...quotes.map((q) => `Caught: “${q.trim()}”`)].join(". ") } : {}),
  });
  const captured = !!m.paypal_capture_id;
  const windowOpen = passed && !captured;
  steps.push({
    key: "window",
    label: "The client's objection window",
    state: stopped ? "skipped" : captured ? "done" : windowOpen ? "active" : "todo",
    ...(stopped ? { detail: "Not reached." } : windowOpen ? { detail: "30 seconds in this deal, as signed in its terms.", ...(m.release_after ? { until: new Date(m.release_after).toISOString() } : {}) } : {}),
  });
  steps.push({
    key: "capture",
    label: "Code captures the hold",
    state: stopped ? "skipped" : captured ? "done" : "todo",
    ...(stopped ? { detail: `Not captured. ${money(m.authorized_cents ?? m.amount_cents)} is still on hold at PayPal.` } : captured ? { detail: `${money(m.captured_cents)} captured. Never more than the hold.`, id: m.paypal_capture_id! } : {}),
  });
  const paid = m.state === "PAID_OUT";
  steps.push({
    key: "payout",
    label: "PayPal pays the worker",
    state: stopped ? "skipped" : paid ? "done" : captured ? "active" : "todo",
    ...(stopped ? { detail: "Nothing was paid." } : paid ? { detail: payoutLine(m), ...(m.paypal_payout_item_id ? { id: m.paypal_payout_item_id } : {}) } : captured ? { detail: "Sending the payout…" } : {}),
  });
  if (run.status === "failed") {
    const active = steps.find((s) => s.state === "active");
    if (active) active.state = "failed";
  }
  return steps;
}

const ciCache = new Map<string, { at: number; ci: CiLive }>();

/** The signed tests' live state on GitHub, read at most every few seconds per commit however many pages poll. */
async function ciLive(github: GitHub, sha: string, hash: string | null): Promise<CiLive> {
  const hit = ciCache.get(sha);
  if (hit && Date.now() - hit.at < MIN_STEP_MS) return hit.ci;
  const out: CiLive = {};
  for (const c of criteria.filter((x) => x.test)) out[c.id] = "queued";
  try {
    const runs = await github.checkRuns(OWNER, REPO, sha);
    for (const c of criteria.filter((x) => x.test)) {
      const r = runs.filter((x) => x.app === CI_APP && hash && x.name === acceptanceCheckName(c.id, hash)).at(-1);
      if (r) out[c.id] = r.status !== "completed" ? "running" : r.conclusion === "success" ? "passed" : "failed";
    }
  } catch {
    return hit?.ci ?? out; // a GitHub blip only freezes the display
  }
  if (ciCache.size > 50) ciCache.clear();
  ciCache.set(sha, { at: Date.now(), ci: out });
  return out;
}

export async function liveProgress(id: string, github?: GitHub): Promise<LiveProgress | undefined> {
  const { rows } = await db().query<LiveRun>("select * from live_runs where id = $1", [id]);
  const run = rows[0];
  if (!run) return undefined;
  const m = await getMilestone(run.milestone_id);
  const { rows: reviews } = await db().query<{ verdict: Verdict | null; reasons: string[] | null; decision: string | null; head_sha: string }>("select verdict, reasons, decision, head_sha from reviews where milestone_id = $1 order by updated_at desc limit 1", [m.id]);
  const review = reviews[0];
  const sha = review && !review.decision && /^[0-9a-f]{7,64}$/i.test(review.head_sha) ? review.head_sha : undefined;
  const ci = github && sha && run.status === "running" ? await ciLive(github, sha, m.criteria_hash) : {};
  const moneyAt: MoneyAt = m.state === "PAID_OUT" ? "worker" : m.paypal_authorization_id && m.state !== "CANCELLED" ? "hold" : "client";
  return { id: run.id, kind: run.kind, status: run.status, outcome: run.outcome, error: run.error, milestoneId: m.id, amountCents: m.amount_cents, payoutCents: m.payout_cents ?? null, moneyAt, steps: buildSteps(run, m, review, ci) };
}
