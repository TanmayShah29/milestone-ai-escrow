import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { db, tx, type Queryable } from "@/lib/db";
import { sign, signingKey } from "./keys";
import { canonical, sha256Hex, type ProofBody, type ProofEvent } from "./verify";

// Appending to a milestone's proof chain. Called for every audit_log row (milestones/repo.ts audit), in
// the same transaction when there is one. Recording proof must never break the flow it records: a failure
// is logged and the row is picked up, marked `backfilled`, by the next append for that milestone.

type AuditRow = {
  id: string;
  milestone_id: string;
  actor: string;
  event: string;
  from_state: string | null;
  to_state: string | null;
  paypal_id: string | null;
  detail: unknown;
  created_at: Date;
};

// Detail keys whose values are facts about the deal rather than about people, copied into the public body.
const FACT_KEYS = ["hash", "headSha", "decision", "model", "outcome", "policyVersion", "shareBps", "credentialId", "githubLogin", "method"] as const;

function factsOf(detail: unknown): ProofBody["facts"] {
  const out: ProofBody["facts"] = {};
  if (!detail || typeof detail !== "object") return out;
  for (const k of FACT_KEYS) {
    const v = (detail as Record<string, unknown>)[k];
    if ((typeof v === "string" && v.length <= 200) || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

async function appendRows(c: Queryable, milestoneId: string, rows: AuditRow[], backfilled: (r: AuditRow) => boolean): Promise<void> {
  if (!rows.length) return;
  const key = await signingKey();
  const { rows: last } = await c.query<{ seq: number; body_hash: string }>("select seq, body_hash from proof_events where milestone_id = $1 order by seq desc limit 1", [milestoneId]);
  let seq = last[0]?.seq ?? 0;
  let prev: string | null = last[0]?.body_hash ?? null;
  for (const r of rows) {
    seq += 1;
    const salt = r.detail === null || r.detail === undefined ? null : randomBytes(16).toString("hex");
    const body: ProofBody = {
      v: 1,
      milestoneId,
      seq,
      prev,
      at: new Date(r.created_at).toISOString(),
      actor: r.actor,
      event: r.event,
      from: r.from_state,
      to: r.to_state,
      paypalId: r.paypal_id,
      facts: factsOf(r.detail),
      detailDigest: salt ? await sha256Hex(`${salt}:${canonical(r.detail)}`) : null,
      ...(backfilled(r) ? { backfilled: true as const } : {}),
      auditId: String(r.id),
    };
    const text = canonical(body);
    const hash = await sha256Hex(text);
    await c.query(
      `insert into proof_events (milestone_id, seq, audit_id, body, body_hash, prev_hash, key_id, sig, detail_salt) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [milestoneId, seq, r.id, text, hash, prev, key.id, await sign(key, text), salt],
    );
    prev = hash;
  }
}

async function appendLocked(c: Queryable, auditId: string, milestoneId: string, repair = false): Promise<void> {
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [`proof:${milestoneId}`]);
  // Earlier rows of this milestone with no event yet (written before the chain existed, or when signing
  // failed) go first, in the order they were written, marked as signed after the fact.
  const { rows } = await c.query<AuditRow>(
    `select a.* from audit_log a left join proof_events p on p.audit_id = a.id
      where a.milestone_id = $1 and p.audit_id is null and a.id <= $2 order by a.id limit 500`,
    [milestoneId, auditId],
  );
  await appendRows(c, milestoneId, rows, (r) => repair || String(r.id) !== String(auditId));
}

/** Sign the audit row `auditId` into its milestone's chain. Never throws. */
export async function appendProof(q: Queryable, auditId: string, milestoneId: string): Promise<void> {
  try {
    if (isClient(q)) {
      // Inside the caller's transaction: a savepoint keeps a signing failure from aborting it.
      await q.query("savepoint proof_append");
      try {
        await appendLocked(q, auditId, milestoneId);
        await q.query("release savepoint proof_append");
      } catch (err) {
        await q.query("rollback to savepoint proof_append");
        throw err;
      }
    } else {
      await tx((c) => appendLocked(c, auditId, milestoneId));
    }
  } catch (err) {
    console.warn(`proof chain append for ${milestoneId} failed (it will be backfilled): ${String(err).slice(0, 200)}`);
  }
}

function isClient(q: Queryable): q is PoolClient {
  return typeof (q as PoolClient).release === "function";
}

/** One milestone's chain as published (GET /api/proof/<id>). */
export async function chainOf(milestoneId: string, q: Queryable = db()): Promise<ProofEvent[]> {
  const { rows } = await q.query<{ seq: number; body: string; body_hash: string; prev_hash: string | null; key_id: string; sig: string }>(
    "select seq, body, body_hash, prev_hash, key_id, sig from proof_events where milestone_id = $1 order by seq",
    [milestoneId],
  );
  return rows.map((r) => ({ seq: r.seq, body: r.body, hash: r.body_hash, prev: r.prev_hash, keyId: r.key_id, sig: r.sig }));
}

/** Sign whatever audit rows of this milestone have no event yet (a no-op when the chain is complete). */
export async function repairChain(milestoneId: string): Promise<void> {
  const { rows } = await db().query<{ id: string }>("select max(id) as id from audit_log where milestone_id = $1", [milestoneId]);
  if (rows[0]?.id) await tx((c) => appendLocked(c, rows[0]!.id, milestoneId, true));
}
