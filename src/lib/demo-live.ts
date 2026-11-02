import type { Terms } from "@/lib/contract/terms";
import { db, withMilestoneLock } from "@/lib/db";
import { seed } from "@/lib/demo";
import { getMilestone, type Milestone } from "@/lib/milestones/repo";
import { feeBps } from "@/lib/money/amounts";
import { cancelHold, defaultDeps, fundWithTestCard } from "@/lib/money/flow";
import { githubPrWriter, type GitHubPrWriter } from "@/lib/review/github";
import { defaultReviewDeps, submitDeliverable, tick, type ReviewDeps } from "@/lib/review/run";
import type { Verdict } from "@/lib/review/policy";

// Judge "run it live": one click runs the real flow on sandbox. A real PayPal hold on a test card, a real PR
// from a branch prepared in the demo repo, real CI on the signed tests, then fixed rules capture and pay out,
// or catch the cheat with the money still held. Every criterion is a test, so no AI call is in the path and
// free-model limits can't break it. Each poll from the page moves the run one idempotent step; this code only
// calls the same functions a client and a worker would. A closed page leaves the rest to the /api/tick sweep.

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
const ABANDONED_AFTER_MS = 90_000; // no page has polled for this long, so another judge may take the branch
const DEADLINE_MS = 10 * 60_000;
const MAX_FAILURES = 5; // consecutive; each funding retry also moves on to the next sandbox test card
const OLD_HOLD_MS = 60 * 60_000;
export const MAX_RUNS_PER_HOUR = 20;

const test = (name: string, body: string) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { initials } from '../src/initials.ts';\n\ntest('${name}', () => {\n${body}\n});`;

const criteria: Terms["criteria"] = [
  { id: "C1", text: "src/initials.ts exports initials(name: string): string, and initials('Ada Lovelace') returns 'AL'.", kind: "must", check: "test", test: { path: "acceptance/c1.test.ts", code: test("first letters", "  assert.equal(initials('Ada Lovelace'), 'AL');") } },
  { id: "C2", text: "Letters are uppercased and any run of whitespace separates words.", kind: "must", check: "test", test: { path: "acceptance/c2.test.ts", code: test("case and whitespace", "  assert.equal(initials('  grace   brewster\\thopper '), 'GBH');") } },
  { id: "C3", text: "Empty or whitespace-only input returns an empty string.", kind: "must", check: "test", test: { path: "acceptance/c3.test.ts", code: test("blank input", "  assert.equal(initials(''), '');\n  assert.equal(initials(' \\t '), '');") } },
];

const defaults = (): LiveDeps => ({ review: defaultReviewDeps(), writer: githubPrWriter() });

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
    "update live_runs set advanced_at = now() where id = $1 and status = 'running' and advanced_at <= now() - make_interval(secs => $2) returning *",
    [id, MIN_STEP_MS / 1000],
  );
  if (rows[0]) await step(rows[0], deps);
  return liveProgress(id);
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
export type LiveProgress = {
  id: string;
  kind: LiveKind;
  status: LiveRun["status"];
  outcome: LiveRun["outcome"];
  error: string | null;
  milestoneId: string;
  amountCents: number;
  steps: LiveStep[];
};

const money = (c: number | null | undefined) => (c == null ? "" : `$${(c / 100).toFixed(2)}`);
const urlIn = (s: string) => /https:\/\/\S+/.exec(s)?.[0];

export function buildSteps(run: Pick<LiveRun, "status" | "pr_url">, m: Milestone, review: { verdict: Verdict | null; reasons: string[] | null; decision: string | null } | undefined): LiveStep[] {
  const decided = !!review?.decision;
  const passed = review?.decision === "PASSED";
  const stopped = decided && !passed; // the money never moves past the decision
  const held = !!m.paypal_authorization_id;
  const steps: LiveStep[] = [
    { key: "terms", label: "Both sides signed the terms", state: "done", detail: "Three tests decide. No AI is involved in this run.", ...(m.criteria_hash ? { id: m.criteria_hash.slice(0, 16), links: [{ label: "Signed contract", href: `/api/contracts/${m.criteria_hash}` }] } : {}) },
    { key: "hold", label: `PayPal holds ${money(m.amount_cents)}`, state: held ? "done" : "active", detail: held ? "An authorization on a sandbox test card. Nothing is charged yet." : "Placing the hold…", ...(held ? { id: m.paypal_authorization_id! } : {}) },
    { key: "pr", label: "The worker opens a pull request", state: run.pr_url ? "done" : held ? "active" : "todo", ...(run.pr_url ? { links: [{ label: "Pull request on GitHub", href: run.pr_url }] } : {}) },
  ];
  const criteria = review?.verdict?.criteria ?? [];
  steps.push({
    key: "ci",
    label: "GitHub Actions runs the signed tests",
    state: decided ? "done" : run.pr_url ? "active" : "todo",
    ...(decided ? { detail: criteria.map((c) => `${c.id} ${c.verdict === "pass" ? "passed" : c.verdict === "fail" ? "failed" : "unclear"}`).join(" · ") } : run.pr_url ? { detail: "Usually about a minute." } : {}),
    ...(decided ? { links: criteria.flatMap((c) => { const href = urlIn(c.evidence[0] ?? ""); return href ? [{ label: `${c.id} log`, href }] : []; }) } : run.pr_url ? { links: [{ label: "Watch the checks", href: `${run.pr_url}/checks` }] } : {}),
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
    ...(stopped ? { detail: `Not captured. ${money(m.authorized_cents ?? m.amount_cents)} is still on hold at PayPal.` } : captured ? { detail: `${money(m.captured_cents)} captured.`, id: m.paypal_capture_id! } : {}),
  });
  const paid = m.state === "PAID_OUT";
  steps.push({
    key: "payout",
    label: "PayPal pays the worker",
    state: stopped ? "skipped" : paid ? "done" : captured ? "active" : "todo",
    ...(stopped ? { detail: "Nothing was paid." } : paid ? { detail: `${money(m.payout_cents)} after fees (status ${m.payout_status}).`, ...(m.paypal_payout_item_id ? { id: m.paypal_payout_item_id } : {}) } : captured ? { detail: "Sending the payout…" } : {}),
  });
  if (run.status === "failed") {
    const active = steps.find((s) => s.state === "active");
    if (active) active.state = "failed";
  }
  return steps;
}

export async function liveProgress(id: string): Promise<LiveProgress | undefined> {
  const { rows } = await db().query<LiveRun>("select * from live_runs where id = $1", [id]);
  const run = rows[0];
  if (!run) return undefined;
  const m = await getMilestone(run.milestone_id);
  const { rows: reviews } = await db().query<{ verdict: Verdict | null; reasons: string[] | null; decision: string | null }>("select verdict, reasons, decision from reviews where milestone_id = $1 order by updated_at desc limit 1", [m.id]);
  return { id: run.id, kind: run.kind, status: run.status, outcome: run.outcome, error: run.error, milestoneId: m.id, amountCents: m.amount_cents, steps: buildSteps(run, m, reviews[0]) };
}
