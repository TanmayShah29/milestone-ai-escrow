import { paypalBaseUrl, paypalCredentials } from "./client";
import { PaypalFailure } from "./errors";

// Shared pieces for the PayPal REST calls the SDK doesn't cover (payouts, webhooks).

type Token = { value: string; expiresAt: number };
const g = globalThis as unknown as { __payoutToken?: Token };

export async function send(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new PaypalFailure("unknown", "No answer from PayPal (connection)", {}, { cause: err });
  }
}

export async function accessToken(fetchImpl: typeof fetch): Promise<string> {
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
