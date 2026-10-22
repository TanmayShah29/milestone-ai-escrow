import { db, withMilestoneLock } from "@/lib/db";
import { audit, getMilestone, transition, updateFields, type Milestone } from "@/lib/milestones/repo";
import { canTransition } from "@/lib/milestones/states";
import type { WebhookEvent } from "@/lib/paypal/webhooks";
import { authorizeHold, defaultDeps, syncMilestone, type Deps } from "./flow";

// A verified webhook is a nudge, not a source of truth: we find the milestone it is about and re-read
// PayPal through the same idempotent flow functions the UI uses (syncMilestone, authorizeHold).
// Disputes are the exception: PayPal is the only source, so CUSTOMER.DISPUTE.CREATED moves captured money
// (RELEASED or PAID_OUT) to DISPUTE directly. No money moves here: a person answers the dispute on PayPal.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Str = string | undefined;
const str = (v: unknown): Str => (typeof v === "string" && v ? v : undefined);

// A dispute resource (/v1/customer/disputes) names the disputed transactions: seller_transaction_id is our
// capture id, and custom carries the purchase unit's custom_id (our milestone id).
type DisputedTransaction = { seller_transaction_id?: unknown; custom?: unknown };

function refsOf(e: WebhookEvent) {
  const r = e.resource ?? {};
  const t = e.event_type;
  if (t.startsWith("CUSTOMER.DISPUTE.")) {
    const txs = (Array.isArray(r.disputed_transactions) ? r.disputed_transactions : []) as DisputedTransaction[];
    return {
      milestoneId: txs.map((x) => str(x.custom)).find((v) => v && UUID.test(v)),
      orderId: undefined,
      authorizationId: undefined,
      captureId: txs.map((x) => str(x.seller_transaction_id)).find(Boolean),
      payoutBatchId: undefined,
      disputeId: str(r.dispute_id),
      resourceId: str(r.dispute_id),
    };
  }
  const related = ((r.supplementary_data as Record<string, unknown> | undefined)?.related_ids ?? {}) as Record<string, unknown>;
  const item = (r.payout_item ?? {}) as Record<string, unknown>;
  const batchHeader = (r.batch_header ?? {}) as Record<string, unknown>;
  const milestoneId = [str(r.custom_id), str(item.sender_item_id)].find((v) => v && UUID.test(v));
  return {
    milestoneId,
    orderId: t.startsWith("CHECKOUT.ORDER.") ? str(r.id) : str(related.order_id),
    authorizationId: t.startsWith("PAYMENT.AUTHORIZATION.") ? str(r.id) : str(related.authorization_id),
    captureId: t.startsWith("PAYMENT.CAPTURE.") ? str(r.id) : undefined,
    payoutBatchId: str(r.payout_batch_id) ?? str(batchHeader.payout_batch_id),
    disputeId: undefined as Str,
    resourceId: str(r.id) ?? str(r.payout_item_id),
  };
}

async function findMilestone(refs: ReturnType<typeof refsOf>): Promise<Milestone | undefined> {
  const { rows } = await db().query<Milestone>(
    `select * from milestones
     where id = $1::uuid or paypal_order_id = $2 or paypal_authorization_id = $3 or paypal_capture_id = $4 or paypal_payout_batch_id = $5
       or paypal_dispute_id = $6
     limit 1`,
    [refs.milestoneId ?? null, refs.orderId ?? null, refs.authorizationId ?? null, refs.captureId ?? null, refs.payoutBatchId ?? null, refs.disputeId ?? null],
  );
  return rows[0];
}

export type WebhookOutcome = { status: "processed" | "ignored" | "duplicate"; milestoneId?: string };

export async function handleWebhookEvent(e: WebhookEvent, deps: Deps = defaultDeps()): Promise<WebhookOutcome> {
  const refs = refsOf(e);
  const inserted = await db().query(
    `insert into webhook_events (id, event_type, resource_id, payload) values ($1, $2, $3, $4)
     on conflict (id) do nothing returning id`,
    [e.id, e.event_type, refs.resourceId ?? null, JSON.stringify(e)],
  );
  if (!inserted.rowCount) {
    const { rows } = await db().query<{ status: string }>("select status from webhook_events where id = $1", [e.id]);
    // A redelivery of a handled event does nothing; a failed or interrupted one is processed again.
    if (rows[0]?.status !== "failed" && rows[0]?.status !== "received") return { status: "duplicate" };
  }

  try {
    const m = await findMilestone(refs);
    if (!m) {
      // A dispute on a transaction we don't know (another integration on the same account): recorded only.
      if (refs.disputeId) await auditUnmatchedDispute(e, refs.disputeId, refs.captureId);
      return await finish(e.id, "ignored");
    }
    await audit(db(), { milestoneId: m.id, actor: "paypal", event: `webhook:${e.event_type}`, paypalId: refs.resourceId ?? e.id, detail: { eventId: e.id } });

    const t = e.event_type;
    if (t === "CHECKOUT.ORDER.APPROVED") {
      // The client approved but may have closed the tab before PayPal redirected back: authorize here too.
      if (m.state === "AGREED" && refs.orderId && refs.orderId === m.paypal_order_id) await authorizeHold(m.id, refs.orderId, deps);
    } else if (t.startsWith("PAYMENT.AUTHORIZATION.") || t.startsWith("PAYMENT.CAPTURE.") || t.startsWith("PAYMENT.PAYOUTS")) {
      // PAYMENT.AUTHORIZATION.VOIDED (a void, or PayPal ending the hold at the end of its validity; PayPal
      // sends no EXPIRED event) lands here too: the sync re-reads the stored authorization and, if it is
      // VOIDED or EXPIRED and nothing was captured, cancels the milestone (flow.ts endHoldIfGone). A void of
      // an older authorization id (replaced by a reauthorization) re-reads the current one and changes nothing.
      await syncMilestone(m.id, deps);
    } else if (t.startsWith("CUSTOMER.DISPUTE.") && refs.disputeId) {
      await recordDispute(m.id, e, refs.disputeId);
    } else {
      // The rest are recorded only (the audit row above).
      return await finish(e.id, "ignored", m.id);
    }
    return await finish(e.id, "processed", m.id);
  } catch (err) {
    await db().query("update webhook_events set status = 'failed', error = $2 where id = $1", [e.id, String(err).slice(0, 2000)]);
    throw err;
  }
}

/**
 * CREATED moves a captured milestone (RELEASED or PAID_OUT) to DISPUTE; UPDATED and RESOLVED are audited
 * only. Idempotent: a second CREATED (or a redelivery) finds the milestone already in DISPUTE and only
 * audits. The first dispute id is stored on the row (money rule 4); every one is in the audit log.
 */
async function recordDispute(milestoneId: string, e: WebhookEvent, disputeId: string): Promise<void> {
  const r = e.resource ?? {};
  const detail = { eventId: e.id, status: str(r.status), reason: str(r.reason), stage: str(r.dispute_life_cycle_stage), outcome: str((r.dispute_outcome as Record<string, unknown> | undefined)?.outcome_code) };
  const kind = e.event_type.replace("CUSTOMER.DISPUTE.", "").toLowerCase(); // created | updated | resolved
  await withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    const store = m.paypal_dispute_id ? {} : { paypal_dispute_id: disputeId };
    if (kind === "created" && canTransition(m.state, "DISPUTE")) {
      await transition(db(), m, "DISPUTE", "paypal", store, { paypalId: disputeId, event: "dispute:opened", detail });
      return;
    }
    if (Object.keys(store).length) await updateFields(db(), m.id, store);
    // Not applied: already in DISPUTE (a repeat), or the money was never captured, so there is nothing to dispute here.
    const applied = kind !== "created" || m.state === "DISPUTE";
    await audit(db(), { milestoneId: m.id, actor: "paypal", event: applied ? `dispute:${kind}` : "dispute:not_applied", paypalId: disputeId, detail: { ...detail, state: m.state } });
  });
}

async function auditUnmatchedDispute(e: WebhookEvent, disputeId: string, captureId: Str): Promise<void> {
  await db().query(
    `insert into audit_log (milestone_id, actor, event, paypal_id, detail) values (null, 'paypal', 'dispute:unmatched', $1, $2)`,
    [disputeId, JSON.stringify({ eventId: e.id, eventType: e.event_type, captureId: captureId ?? null })],
  );
}

async function finish(eventId: string, status: "processed" | "ignored", milestoneId?: string): Promise<WebhookOutcome> {
  await db().query("update webhook_events set status = $2, milestone_id = $3, processed_at = now(), error = null where id = $1", [
    eventId,
    status,
    milestoneId ?? null,
  ]);
  return { status, ...(milestoneId ? { milestoneId } : {}) };
}
