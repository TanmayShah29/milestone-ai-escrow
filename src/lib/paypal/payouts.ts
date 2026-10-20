import { paypalBaseUrl, paypalCredentials } from "./client";
import { PaypalFailure, failureFromResponse } from "./errors";

// Payouts are not in the PayPal server SDK, so these are small typed REST calls (paypal-plan.md).

type Token = { value: string; expiresAt: number };
const g = globalThis as unknown as { __payoutToken?: Token };

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new PaypalFailure("unknown", "No answer from PayPal (connection)", {}, { cause: err });
  }
}

async function accessToken(fetchImpl: typeof fetch): Promise<string> {
  const cached = g.__payoutToken;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const { clientId, clientSecret } = paypalCredentials();
  let res: Response;
  try {
    res = await fetchImpl(`${paypalBaseUrl()}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new PaypalFailure("never_sent", "Could not get a PayPal token", {}, { cause: err });
  }
  if (!res.ok) throw new PaypalFailure("never_sent", `PayPal token request failed (${res.status})`, { status: res.status });
  const body = (await res.json()) as { access_token: string; expires_in: number };
  g.__payoutToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

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
