import { db } from "@/lib/db";
import { canonical } from "@/lib/proof/verify";
import { sign, signingKey } from "@/lib/proof/keys";
import type { Verdict } from "@/lib/review/policy";

// Passports (V2_PLAN §3.I): a worker's record, keyed by GitHub login, and a client's, keyed by mandate. Both
// are computed from the milestones and their audit trail, the same rows the public proof chain signs, and
// the passport itself is signed with the proof key, so a platform can check it against
// /.well-known/milestone-proof-keys.json. Fairness runs both ways: the client's record shows its objections,
// timeouts and awards against it, as the worker's shows deliveries and disputes.

type Row = { id: string; state: string; amount_cents: number; criteria_hash: string | null; due_at: Date; updated_at: Date; contested_at: Date | null };

const PAID = "PAID_OUT";

export type Signed<T> = { passport: T; keyId: string; signature: string };

async function signed<T>(passport: T): Promise<Signed<T>> {
  const key = await signingKey();
  return { passport, keyId: key.id, signature: await sign(key, canonical(passport)) };
}

async function events(ids: string[], names: string[]): Promise<{ milestone_id: string; event: string; created_at: Date; detail: Record<string, unknown> | null }[]> {
  if (!ids.length) return [];
  const { rows } = await db().query("select milestone_id, event, created_at, detail from audit_log where milestone_id = any($1::uuid[]) and event = any($2::text[]) order by id", [ids, names]);
  return rows;
}

async function evidenceMix(ids: string[]): Promise<Record<string, number>> {
  const mix: Record<string, number> = { E3: 0, E2: 0, E1: 0, none: 0 };
  if (!ids.length) return mix;
  const { rows } = await db().query<{ verdict: Verdict }>(
    `select distinct on (milestone_id) verdict from reviews where milestone_id = any($1::uuid[]) and status = 'done' and verdict is not null order by milestone_id, updated_at desc`,
    [ids],
  );
  for (const r of rows) for (const c of r.verdict.criteria ?? []) if (c.verdict === "pass") mix[c.level ?? "none"] = (mix[c.level ?? "none"] ?? 0) + 1;
  return mix;
}

export type WorkerPassport = {
  v: 1;
  type: "milestone.passport.worker";
  githubLogin: string;
  issuedAt: string;
  paid: number;
  paidCents: number;
  onTimeRate: number | null;
  changesRequested: number;
  disputes: number;
  lapsedClaims: number;
  awards: { count: number; averageShareBps: number | null };
  passedEvidence: Record<string, number>;
  milestones: { id: string; state: string; amountCents: number; termsHash: string | null }[];
};

export async function workerPassport(login: string): Promise<Signed<WorkerPassport>> {
  const { rows } = await db().query<Row>(
    "select id, state, amount_cents, criteria_hash, due_at, updated_at, contested_at from milestones where lower(worker_github_login) = lower($1) and state not in ('DRAFT', 'AGREED') order by created_at",
    [login],
  );
  const ids = rows.map((r) => r.id);
  const ev = await events(ids, ["payout:succeeded", "review:changes_requested", "award:signed"]);
  const paid = rows.filter((r) => r.state === PAID);
  const paidAt = new Map(ev.filter((e) => e.event === "payout:succeeded").map((e) => [e.milestone_id, e.created_at]));
  const onTime = paid.filter((r) => (paidAt.get(r.id) ?? r.updated_at).getTime() <= r.due_at.getTime()).length;
  const awards = ev.filter((e) => e.event === "award:signed").map((e) => Number(e.detail?.shareBps ?? 0));
  // A lapsed claim leaves the milestone (it goes back to OFFERED), so it is found by the login in its detail.
  const { rows: lapsed } = await db().query<{ n: string }>("select count(*) as n from audit_log where event = 'bounty:claim_lapsed' and lower(detail->>'githubLogin') = lower($1)", [login]);
  return signed({
    v: 1,
    type: "milestone.passport.worker",
    githubLogin: login,
    issuedAt: new Date().toISOString(),
    paid: paid.length,
    paidCents: paid.reduce((s, r) => s + r.amount_cents, 0),
    onTimeRate: paid.length ? Math.round((onTime / paid.length) * 100) / 100 : null,
    changesRequested: ev.filter((e) => e.event === "review:changes_requested").length,
    disputes: rows.filter((r) => r.state === "DISPUTE").length,
    lapsedClaims: Number(lapsed[0]?.n ?? 0),
    awards: { count: awards.length, averageShareBps: awards.length ? Math.round(awards.reduce((a, b) => a + b, 0) / awards.length) : null },
    passedEvidence: await evidenceMix(ids),
    milestones: rows.map((r) => ({ id: r.id, state: r.state, amountCents: r.amount_cents, termsHash: r.criteria_hash })),
  });
}

export type ClientPassport = {
  v: 1;
  type: "milestone.passport.client";
  mandateId: string;
  name: string;
  issuedAt: string;
  bounties: number;
  paid: number;
  cancelledUnclaimed: number;
  objections: number;
  objectionRate: number | null;
  humanTimeouts: number;
  locks: number;
  awardsAgainst: number;
};

/** A mandate's record as a client: what it posted, how often it objected or let a decision time out. */
export async function clientPassport(mandateId: string): Promise<Signed<ClientPassport> | undefined> {
  const { rows: mand } = await db().query<{ name: string }>("select name from mandates where id = $1", [mandateId]);
  if (!mand[0]) return undefined;
  const { rows } = await db().query<Row & { worker_github_login: string | null }>(
    "select id, state, amount_cents, criteria_hash, due_at, updated_at, contested_at, worker_github_login from milestones where mandate_id = $1 and state <> 'DRAFT'",
    [mandateId],
  );
  const ids = rows.map((r) => r.id);
  const ev = await events(ids, ["review:passed", "review:human_timeout", "lock:locked", "award:signed"]);
  const passes = new Set(ev.filter((e) => e.event === "review:passed").map((e) => e.milestone_id)).size;
  const objections = rows.filter((r) => r.contested_at).length;
  const lockedByClient = new Set(ev.filter((e) => e.event === "lock:locked" && e.detail?.by === "client").map((e) => e.milestone_id));
  return signed({
    v: 1,
    type: "milestone.passport.client",
    mandateId,
    name: mand[0].name,
    issuedAt: new Date().toISOString(),
    bounties: rows.length,
    paid: rows.filter((r) => r.state === PAID).length,
    cancelledUnclaimed: rows.filter((r) => r.state === "CANCELLED" && !r.worker_github_login).length,
    objections,
    objectionRate: passes ? Math.round((objections / passes) * 100) / 100 : null,
    humanTimeouts: ev.filter((e) => e.event === "review:human_timeout").length,
    locks: ev.filter((e) => e.event === "lock:locked").length,
    // An award at 50% or more for the worker, on a decision the client locked, went against the client.
    awardsAgainst: ev.filter((e) => e.event === "award:signed" && lockedByClient.has(e.milestone_id) && Number(e.detail?.shareBps ?? 0) >= 5000).length,
  });
}

/** A README badge: "milestone | 3 paid · 100% on time". */
export function badgeSvg(p: WorkerPassport): string {
  const right = p.paid ? `${p.paid} paid${p.onTimeRate !== null ? ` · ${Math.round(p.onTimeRate * 100)}% on time` : ""}` : "no paid work yet";
  const lw = 66;
  const rw = 7 * right.length + 14;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="milestone: ${esc(right)}"><title>milestone: ${esc(right)}</title><rect width="${lw}" height="20" fill="#13233a"/><rect x="${lw}" width="${rw}" height="20" fill="#1f7a4d"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="8" y="14">milestone</text><text x="${lw + 7}" y="14">${esc(right)}</text></g></svg>`;
}
