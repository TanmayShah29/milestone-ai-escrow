import { paypalBaseUrl } from "./client";
import { PaypalFailure, failureFromResponse } from "./errors";
import { accessToken, send } from "./rest";

// Payouts are not in the PayPal server SDK, so these are small typed REST calls (paypal-plan.md).

export type PayoutCreated = { batchId: string; batchStatus: string };

/**
 * POST /v1/payments/payouts. `requestId` is both the PayPal-Request-Id and the sender_batch_id, so a
 * replay of the same logical payout returns the original batch instead of paying twice.
 */
export async function createPayout(
  args: { requestId: string; milestoneId: string; receiver: string; value: string; note: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PayoutCreated> {
  const token = await accessToken(fetchImpl);
  const res = await send(fetchImpl, `${paypalBaseUrl()}/v1/payments/payouts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "paypal-request-id": args.requestId },
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: args.requestId, recipient_type: "EMAIL", email_subject: "You've been paid for a milestone" },
      items: [
        { recipient_type: "EMAIL", receiver: args.receiver, amount: { value: args.value, currency: "USD" }, sender_item_id: args.milestoneId, note: args.note },
      ],
    }),
  });
  if (!res.ok) throw await failureFromResponse(res);
  const body = (await res.json().catch(() => undefined)) as { batch_header?: { payout_batch_id?: string; batch_status?: string } } | undefined;
  const batchId = body?.batch_header?.payout_batch_id;
  if (!batchId) throw new PaypalFailure("unknown", "Payout response had no batch id", { status: res.status });
  return { batchId, batchStatus: body.batch_header?.batch_status ?? "PENDING" };
}

export type PayoutStatus = { batchStatus: string; itemId?: string; itemStatus?: string };

/** GET /v1/payments/payouts/{batch_id}. Item status SUCCESS means the freelancer has the money. */
export async function getPayout(batchId: string, fetchImpl: typeof fetch = fetch): Promise<PayoutStatus> {
  const token = await accessToken(fetchImpl);
  const res = await send(fetchImpl, `${paypalBaseUrl()}/v1/payments/payouts/${encodeURIComponent(batchId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await failureFromResponse(res);
  const body = (await res.json()) as {
    batch_header?: { batch_status?: string };
    items?: { payout_item_id?: string; transaction_status?: string }[];
  };
  const item = body.items?.[0];
  return {
    batchStatus: body.batch_header?.batch_status ?? "UNKNOWN",
    ...(item?.payout_item_id ? { itemId: item.payout_item_id } : {}),
    ...(item?.transaction_status ? { itemStatus: item.transaction_status } : {}),
  };
}
