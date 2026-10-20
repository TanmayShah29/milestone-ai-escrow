import { paypalBaseUrl } from "./client";
import { PaypalFailure, failureFromResponse } from "./errors";
import { accessToken, send } from "./rest";

// Webhook signature verification (money rule 6). PayPal checks the signature for us given the
// transmission headers, our webhook id and the event body.

export type WebhookEvent = {
  id: string;
  event_type: string;
  resource_type?: string;
  resource?: Record<string, unknown>;
  create_time?: string;
};

const HEADERS = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"] as const;

export function webhookId(): string {
  const id = process.env.PAYPAL_WEBHOOK_ID;
  if (!id) throw new Error("PAYPAL_WEBHOOK_ID is not set");
  return id;
}

/** POST /v1/notifications/verify-webhook-signature. true only for verification_status SUCCESS. */
export async function verifyWebhookSignature(headers: Headers, event: WebhookEvent, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const h = Object.fromEntries(HEADERS.map((k) => [k, headers.get(k)]));
  if (HEADERS.some((k) => !h[k])) return false;
  const token = await accessToken(fetchImpl);
  const res = await send(fetchImpl, `${paypalBaseUrl()}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      auth_algo: h["paypal-auth-algo"],
      cert_url: h["paypal-cert-url"],
      transmission_id: h["paypal-transmission-id"],
      transmission_sig: h["paypal-transmission-sig"],
      transmission_time: h["paypal-transmission-time"],
      webhook_id: webhookId(),
      webhook_event: event,
    }),
  });
  if (!res.ok) throw await failureFromResponse(res);
  const body = (await res.json().catch(() => undefined)) as { verification_status?: string } | undefined;
  if (!body?.verification_status) throw new PaypalFailure("unknown", "verify-webhook-signature returned no status", { status: res.status });
  return body.verification_status === "SUCCESS";
}
