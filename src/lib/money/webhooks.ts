import { db } from "@/lib/db";
import { audit, type Milestone } from "@/lib/milestones/repo";
import type { WebhookEvent } from "@/lib/paypal/webhooks";
import { authorizeHold, defaultDeps, syncMilestone, type Deps } from "./flow";

// A verified webhook is a nudge, not a source of truth: we find the milestone it is about and re-read
// PayPal through the same idempotent flow functions the UI uses (syncMilestone, authorizeHold).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Str = string | undefined;
const str = (v: unknown): Str => (typeof v === "string" && v ? v : undefined);

function refsOf(e: WebhookEvent) {
  const r = e.resource ?? {};
  const related = ((r.supplementary_data as Record<string, unknown> | undefined)?.related_ids ?? {}) as Record<string, unknown>;
  const item = (r.payout_item ?? {}) as Record<string, unknown>;
  const batchHeader = (r.batch_header ?? {}) as Record<string, unknown>;
  const t = e.event_type;
  const milestoneId = [str(r.custom_id), str(item.sender_item_id)].find((v) => v && UUID.test(v));
  return {
    milestoneId,
    orderId: t.startsWith("CHECKOUT.ORDER.") ? str(r.id) : str(related.order_id),
    authorizationId: t.startsWith("PAYMENT.AUTHORIZATION.") ? str(r.id) : str(related.authorization_id),
    captureId: t.startsWith("PAYMENT.CAPTURE.") ? str(r.id) : undefined,
    payoutBatchId: str(r.payout_batch_id) ?? str(batchHeader.payout_batch_id),
    resourceId: str(r.id) ?? str(r.payout_item_id),
  };
}

async function findMilestone(refs: ReturnType<typeof refsOf>): Promise<Milestone | undefined> {
  const { rows } = await db().query<Milestone>(
    `select * from milestones
     where id = $1::uuid or paypal_order_id = $2 or paypal_authorization_id = $3 or paypal_capture_id = $4 or paypal_payout_batch_id = $5
     limit 1`,
    [refs.milestoneId ?? null, refs.orderId ?? null, refs.authorizationId ?? null, refs.captureId ?? null, refs.payoutBatchId ?? null],
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
    if (!m) return await finish(e.id, "ignored");
    await audit(db(), { milestoneId: m.id, actor: "paypal", event: `webhook:${e.event_type}`, paypalId: refs.resourceId ?? e.id, detail: { eventId: e.id } });

    const t = e.event_type;
    if (t === "CHECKOUT.ORDER.APPROVED") {
      // The client approved but may have closed the tab before PayPal redirected back: authorize here too.
      if (m.state === "AGREED" && refs.orderId && refs.orderId === m.paypal_order_id) await authorizeHold(m.id, refs.orderId, deps);
    } else if (t.startsWith("PAYMENT.AUTHORIZATION.") || t.startsWith("PAYMENT.CAPTURE.") || t.startsWith("PAYMENT.PAYOUTS")) {
      await syncMilestone(m.id, deps);
    } else {
      // Disputes and the rest are recorded for now (build step 6 acts on disputes).
      return await finish(e.id, "ignored", m.id);
    }
    return await finish(e.id, "processed", m.id);
  } catch (err) {
    await db().query("update webhook_events set status = 'failed', error = $2 where id = $1", [e.id, String(err).slice(0, 2000)]);
    throw err;
  }
}

async function finish(eventId: string, status: "processed" | "ignored", milestoneId?: string): Promise<WebhookOutcome> {
  await db().query("update webhook_events set status = $2, milestone_id = $3, processed_at = now(), error = null where id = $1", [
    eventId,
    status,
    milestoneId ?? null,
  ]);
  return { status, ...(milestoneId ? { milestoneId } : {}) };
}
