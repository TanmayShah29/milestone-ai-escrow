import { PaypalClient } from "paypal";

// The SDK declares one environment and no selector, so the host is an explicit base-URL override
// bound to PAYPAL_ENVIRONMENT. Only the sandbox is allowed in this project.
const HOSTS = { SANDBOX: "https://api-m.sandbox.paypal.com" } as const;

export function paypalBaseUrl(): string {
  const env = process.env.PAYPAL_ENVIRONMENT ?? "";
  if (!(env in HOSTS)) throw new Error(`PAYPAL_ENVIRONMENT must be SANDBOX (got "${env}")`);
  return HOSTS[env as keyof typeof HOSTS];
}

export function paypalCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  // An unset oauth2 credential is not an SDK error; it would just 401 later.
  if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set");
  return { clientId, clientSecret };
}

export function buildPaypalClient(fetchImpl?: typeof fetch): PaypalClient {
  return new PaypalClient({
    serverOptions: { baseUrl: paypalBaseUrl() },
    oauth2: paypalCredentials(),
    // Defaults kept: GETs retry, POSTs are sent once (writes are settled by re-reads, not resends).
    retry: { timeout: 20_000 },
    // Explicit, so PAYPAL_CLIENT_LOG can't switch logging on from outside the code.
    logging: { level: "off" },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

const g = globalThis as unknown as { __paypal?: PaypalClient };

/** One long-lived client per process: it holds the OAuth token cache. */
export function paypal(): PaypalClient {
  g.__paypal ??= buildPaypalClient();
  return g.__paypal;
}
