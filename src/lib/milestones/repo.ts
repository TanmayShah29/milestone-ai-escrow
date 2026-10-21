import { hashToken, newToken } from "@/lib/auth";
import { db, tx, type Queryable } from "@/lib/db";
import { assertTransition, type MilestoneState } from "./states";

export type Milestone = {
  id: string;
  title: string;
  brief: string;
  amount_cents: number;
  currency: "USD";
  client_email: string | null;
  freelancer_email: string;
  state: MilestoneState;
  pr_url: string | null;
  paypal_order_id: string | null;
  approve_url: string | null;
  paypal_authorization_id: string | null;
  authorized_cents: number | null;
  authorization_expires_at: Date | null;
  reauth_count: number;
  paypal_capture_id: string | null;
  capture_status: string | null;
  captured_cents: number | null;
  fee_cents: number | null;
  payout_cents: number | null;
  paypal_payout_batch_id: string | null;
  paypal_payout_item_id: string | null;
  payout_status: string | null;
  paypal_refund_id: string | null;
  paypal_dispute_id: string | null;
  platform_id: string | null;
  repo: string | null;
  stack: string | null;
  criteria: unknown;
  criteria_hash: string | null;
  criteria_model: string | null;
  client_signed_hash: string | null;
  client_signed_at: Date | null;
  worker_signed_hash: string | null;
  worker_signed_at: Date | null;
  client_token_hash: string | null;
  worker_token_hash: string | null;
  created_at: Date;
  updated_at: Date;
};

export type Actor = "client" | "freelancer" | "system" | "paypal" | "ai" | "dev";

export class NotFound extends Error {}

export async function getMilestone(id: string, q: Queryable = db()): Promise<Milestone> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFound(`milestone ${id} not found`);
  const { rows } = await q.query<Milestone>("select * from milestones where id = $1", [id]);
  if (!rows[0]) throw new NotFound(`milestone ${id} not found`);
  return rows[0];
}

/** Creates a milestone and returns its client and worker links' tokens. They are shown once; only hashes are kept. */
export async function createMilestone(input: {
  title: string;
  brief: string;
  amountCents: number;
  freelancerEmail: string;
  clientEmail?: string;
  platformId?: string;
}): Promise<{ milestone: Milestone; clientToken: string; workerToken: string }> {
  const clientToken = newToken("mct");
  const workerToken = newToken("mwt");
  const milestone = await tx(async (c) => {
    const { rows } = await c.query<Milestone>(
      `insert into milestones (title, brief, amount_cents, freelancer_email, client_email, platform_id, client_token_hash, worker_token_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [input.title, input.brief, input.amountCents, input.freelancerEmail, input.clientEmail ?? null, input.platformId ?? null, hashToken(clientToken), hashToken(workerToken)],
    );
    const m = rows[0]!;
    await audit(c, { milestoneId: m.id, actor: "client", event: "created", toState: m.state, detail: input.platformId ? { platformId: input.platformId } : undefined });
    return m;
  });
  return { milestone, clientToken, workerToken };
}

type AuditEntry = {
  milestoneId: string;
  actor: Actor;
  event: string;
  fromState?: MilestoneState;
  toState?: MilestoneState;
  paypalId?: string | null;
  paypalDebugId?: string | null;
  detail?: unknown;
};

/** Money rule 5: every state change and every PayPal response writes a row here. */
export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `insert into audit_log (milestone_id, actor, event, from_state, to_state, paypal_id, paypal_debug_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.milestoneId,
      e.actor,
      e.event,
      e.fromState ?? null,
      e.toState ?? null,
      e.paypalId ?? null,
      e.paypalDebugId ?? null,
      e.detail === undefined ? null : JSON.stringify(e.detail),
    ],
  );
}

export class StaleState extends Error {}

/**
 * Conditional state change: only succeeds if the row is still in `from`, so two callers can't both
 * move it. `set` carries the PayPal ids and amounts to store in the same statement.
 */
export async function transition(
  q: Queryable,
  m: Pick<Milestone, "id" | "state">,
  to: MilestoneState,
  actor: Actor,
  set: Partial<Record<keyof Milestone, unknown>> = {},
  auditExtra: Partial<Pick<AuditEntry, "paypalId" | "paypalDebugId" | "detail" | "event">> = {},
): Promise<Milestone> {
  assertTransition(m.state, to);
  const cols = Object.keys(set);
  const assignments = cols.map((c, i) => `${c} = $${i + 3}`);
  const { rows } = await q.query<Milestone>(
    `update milestones set state = $${cols.length + 3}, updated_at = now()${assignments.length ? ", " + assignments.join(", ") : ""}
     where id = $1 and state = $2 returning *`,
    [m.id, m.state, ...cols.map((c) => set[c as keyof Milestone]), to],
  );
  if (!rows[0]) throw new StaleState(`milestone ${m.id} is no longer ${m.state}`);
  const { event = `state:${to}`, ...rest } = auditExtra;
  await audit(q, { milestoneId: m.id, actor, event, fromState: m.state, toState: to, ...rest });
  return rows[0];
}

/** Update PayPal fields without a state change (e.g. the order id while still AGREED). */
export async function updateFields(q: Queryable, id: string, set: Partial<Record<keyof Milestone, unknown>>): Promise<Milestone> {
  const cols = Object.keys(set);
  const { rows } = await q.query<Milestone>(
    `update milestones set updated_at = now(), ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} where id = $1 returning *`,
    [id, ...cols.map((c) => set[c as keyof Milestone])],
  );
  return rows[0]!;
}
