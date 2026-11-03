import { db } from "@/lib/db";
import type { Milestone } from "@/lib/milestones/repo";
import { buildTimeline, type AuditRow, type Timeline } from "@/lib/timeline";

// The public showcase: the most recent finished judge live runs (src/lib/demo-live.ts), read only. These
// are real sandbox runs, so their PayPal ids (authorization, capture, payout) are real. A first-time
// visitor's browser holds no milestone links, so /timeline, /ledger and /milestones show these instead of
// an empty page. Only an allow-list of fields leaves the server: never emails, link tokens or their
// hashes, the terms' email salt, or audit details.

export const SHOWCASE_MAX = 6;
const CACHE_MS = 30_000;

export type ShowcaseOutcome = "paid" | "caught" | "person";
export type ShowcaseRun = {
  kind: "honest" | "cheat";
  outcome: ShowcaseOutcome;
  prUrl: string | null;
  worker: string;
  milestone: ShowcaseMilestone;
  audit: { id: string; actor: string; event: string; to_state: string | null; paypal_id: string | null; created_at: string }[];
  actions: { action: string; attempt: number; status: string; paypal_id: string | null; created_at: string }[];
  timeline: Timeline;
};
export type Showcase = { runs: ShowcaseRun[]; generatedAt: string };

// Every field a page needs to draw a finished run, and nothing else.
const FIELDS = [
  "id",
  "title",
  "amount_cents",
  "currency",
  "state",
  "pr_url",
  "repo",
  "verifier",
  "criteria_hash",
  "paypal_order_id",
  "paypal_authorization_id",
  "authorized_cents",
  "authorization_expires_at",
  "reauth_count",
  "paypal_capture_id",
  "capture_status",
  "captured_cents",
  "fee_cents",
  "paypal_fee_cents",
  "payout_fee_cents",
  "payout_cents",
  "paypal_payout_batch_id",
  "paypal_payout_item_id",
  "payout_status",
  "release_after",
  "hold_ended_at",
  "due_at",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof Milestone)[];

export type ShowcaseMilestone = Pick<Milestone, (typeof FIELDS)[number]> & { after_milestone_id: null };

/** The allow-listed public view of a live run's milestone. */
export function showcaseMilestone(m: Milestone): ShowcaseMilestone {
  const out = Object.fromEntries(FIELDS.map((k) => [k, m[k] ?? null])) as ShowcaseMilestone;
  out.after_milestone_id = null; // live runs stand alone; never point at another (private) milestone
  return out;
}

type Candidate = { runId: string; kind: "honest" | "cheat"; outcome: ShowcaseOutcome; createdAt: number };

/**
 * Which runs to show, newest first: the latest paid honest run and the latest caught cheat first (the two
 * stories), then the most recent other finished runs, up to `max`.
 */
export function pickShowcase<T extends Candidate>(runs: T[], max = SHOWCASE_MAX): T[] {
  const newest = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  const lead = [newest.find((r) => r.outcome === "paid"), newest.find((r) => r.outcome === "caught")].filter((r): r is T => !!r);
  const rest = newest.filter((r) => !lead.includes(r));
  return [...lead, ...rest].slice(0, max);
}

type Row = Milestone & { run_id: string; run_kind: "honest" | "cheat"; run_outcome: ShowcaseOutcome; run_pr_url: string | null; run_created_at: Date };

async function load(): Promise<Showcase> {
  const { rows } = await db().query<Row>(
    `select m.*, r.id as run_id, r.kind as run_kind, r.outcome as run_outcome, r.pr_url as run_pr_url, r.created_at as run_created_at
       from live_runs r join milestones m on m.id = r.milestone_id
      where r.status = 'done' and r.outcome is not null and m.erased_at is null
      order by r.created_at desc limit 40`,
  );
  const picked = pickShowcase(rows.map((r) => ({ runId: r.run_id, kind: r.run_kind, outcome: r.run_outcome, createdAt: new Date(r.run_created_at).getTime(), row: r })));
  if (!picked.length) return { runs: [], generatedAt: new Date().toISOString() };
  const ids = picked.map((p) => p.row.id);
  const [{ rows: audit }, { rows: actions }] = await Promise.all([
    db().query<{ id: string; milestone_id: string; actor: string; event: string; to_state: string | null; paypal_id: string | null; created_at: Date; detail: unknown }>(
      "select id::text as id, milestone_id, actor, event, to_state, paypal_id, created_at, detail from audit_log where milestone_id = any($1) order by id",
      [ids],
    ),
    db().query<{ milestone_id: string; action: string; attempt: number; status: string; paypal_id: string | null; created_at: Date }>(
      "select milestone_id, action, attempt, status, paypal_id, created_at from money_actions where milestone_id = any($1) order by id",
      [ids],
    ),
  ]);
  const runs = picked.map(({ row }): ShowcaseRun => {
    const trail = audit.filter((a) => a.milestone_id === row.id);
    // Runs share one brief, so the title names the worker and when it ran (UTC) to tell them apart.
    const when = new Date(row.run_created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
    const m = { ...(row as Milestone), after_milestone_id: null, title: `${row.run_kind === "honest" ? "Honest worker" : "Cheating worker"} · ${when} UTC` };
    return {
      kind: row.run_kind,
      outcome: row.run_outcome,
      prUrl: row.run_pr_url,
      worker: row.run_kind === "honest" ? "Demo worker (honest)" : "Demo worker (cheating)",
      milestone: showcaseMilestone(m),
      // detail stays here: it only feeds the timeline's words (failed criteria), never the response.
      audit: trail.map((a) => ({ id: a.id, actor: a.actor, event: a.event, to_state: a.to_state, paypal_id: a.paypal_id, created_at: new Date(a.created_at).toISOString() })),
      actions: actions.filter((a) => a.milestone_id === row.id).map((a) => ({ action: a.action, attempt: a.attempt, status: a.status, paypal_id: a.paypal_id, created_at: new Date(a.created_at).toISOString() })),
      timeline: readOnlyTimeline(buildTimeline(m, trail as AuditRow[])),
    };
  });
  return { runs, generatedAt: new Date().toISOString() };
}

/** The showcase can't be rescheduled: no bar is draggable and no engine constraint applies. */
function readOnlyTimeline(tl: Timeline): Timeline {
  const fix = (t: Timeline["tasks"][number]): Timeline["tasks"][number] => {
    const { canReschedule: _c, dueLimit: _d, constraintType: _t, constraintDate: _cd, ...rest } = t;
    void _c;
    void _d;
    void _t;
    void _cd;
    return { ...rest, manuallyScheduled: true, resizable: false, draggable: false, ...(t.children ? { children: t.children.map(fix) } : {}) };
  };
  return { ...tl, tasks: tl.tasks.map(fix), warnings: [] };
}

// A brief in-process cache: the free database is small, and every first-time visitor asks for this.
let cached: { at: number; value: Promise<Showcase> } | undefined;

export function getShowcase(now = Date.now()): Promise<Showcase> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = load();
  cached = { at: now, value };
  value.catch(() => {
    if (cached?.value === value) cached = undefined; // don't cache a failure
  });
  return value;
}

/** For tests. */
export function clearShowcaseCache(): void {
  cached = undefined;
}
