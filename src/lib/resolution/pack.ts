import { createHash } from "node:crypto";
import { contractByHash } from "@/lib/contract/terms";
import { signaturesOf } from "@/lib/contract/signatures";
import { db } from "@/lib/db";
import type { Milestone } from "@/lib/milestones/repo";
import { canonical } from "@/lib/proof/verify";
import type { Verdict } from "@/lib/review/policy";

// The evidence pack (V2_PLAN §3.G), built once when a lock is matched and frozen: everything the arbitrator
// rules on, in one document whose SHA-256 goes into the proof chain and into the award they sign. Items have
// ids (`C2`, `review:1`, `statement:client`) so a draft or an award can say what it rests on.

export type Pack = {
  v: 1;
  milestoneId: string;
  termsHash: string;
  contract: unknown;
  signatures: { role: string; kind: string; credentialId: string; statement: string; signature: string }[];
  pr: { url: string | null };
  reviews: { id: string; headSha: string; decision: string | null; reasons: unknown; verdict: Verdict | null; at: string }[];
  trace: { at: string; actor: string; event: string; from: string | null; to: string | null }[];
  statements: { client?: string; worker?: string; objection?: string; changes?: string };
  lockedBy: "client" | "worker";
};

export const STATEMENT_MAX = 2000;

export function packHash(pack: Pack): string {
  return createHash("sha256").update(canonical(pack)).digest("hex");
}

/** The ids a draft or an award may cite: criteria, reviews and statements in the pack. */
export function evidenceIds(pack: Pack): Set<string> {
  const criteria = ((pack.contract as { criteria?: { id: string }[] } | null)?.criteria ?? []).map((c) => c.id);
  return new Set([...criteria, ...pack.reviews.map((r) => r.id), ...Object.keys(pack.statements).filter((k) => pack.statements[k as keyof Pack["statements"]]).map((k) => `statement:${k}`)]);
}

export async function buildPack(m: Milestone, lockedBy: "client" | "worker", statements: { client?: string; worker?: string }): Promise<Pack> {
  const contract = m.criteria_hash ? await contractByHash(m.criteria_hash) : undefined;
  const sigs = await signaturesOf(m.id);
  const { rows: reviews } = await db().query<{ head_sha: string; decision: string | null; reasons: unknown; verdict: Verdict | null; updated_at: Date }>(
    "select head_sha, decision, reasons, verdict, updated_at from reviews where milestone_id = $1 and status = 'done' order by updated_at, id",
    [m.id],
  );
  // The decision trace: what happened and who did it. Details stay out (they can hold personal data); the
  // reviews above carry the reasons that matter.
  const { rows: trace } = await db().query<{ created_at: Date; actor: string; event: string; from_state: string | null; to_state: string | null }>(
    "select created_at, actor, event, from_state, to_state from audit_log where milestone_id = $1 order by id",
    [m.id],
  );
  const clip = (s: string | null | undefined) => (s ? s.slice(0, STATEMENT_MAX) : undefined);
  const said = {
    ...(clip(statements.client) ? { client: clip(statements.client) } : {}),
    ...(clip(statements.worker) ? { worker: clip(statements.worker) } : {}),
    ...(clip(m.objection_reason) ? { objection: clip(m.objection_reason) } : {}),
    ...(clip(m.changes_reason) ? { changes: clip(m.changes_reason) } : {}),
  };
  return {
    v: 1,
    milestoneId: m.id,
    termsHash: m.criteria_hash ?? "",
    contract: contract ? JSON.parse(contract.document) : null,
    signatures: sigs.filter((s) => s.termsHash === m.criteria_hash).map((s) => ({ role: s.role, kind: s.kind, credentialId: s.credentialId, statement: s.statement, signature: s.signature })),
    pr: { url: m.pr_url },
    reviews: reviews.map((r, i) => ({ id: `review:${i + 1}`, headSha: r.head_sha, decision: r.decision, reasons: r.reasons, verdict: r.verdict, at: r.updated_at.toISOString() })),
    trace: trace.map((t) => ({ at: t.created_at.toISOString(), actor: t.actor, event: t.event, from: t.from_state, to: t.to_state })),
    statements: said,
    lockedBy,
  };
}
