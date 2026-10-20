// Test setup: real Postgres (TEST_DATABASE_URL), fake PayPal through the fetch seam.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/milestone_test";
process.env.PAYPAL_ENVIRONMENT = "SANDBOX";
process.env.PAYPAL_CLIENT_ID = "test-id";
process.env.PAYPAL_CLIENT_SECRET = "test-secret";
process.env.PLATFORM_FEE_BPS = "500";

import { PaypalClient } from "paypal";
import { db } from "@/lib/db";
import type { Deps } from "@/lib/money/flow";

export type Call = { url: URL; request: Request; body: string | undefined };
type Responder = (call: Call) => Response | Promise<Response>;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function stubFetch(responder: Responder) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.body === null ? undefined : await request.clone().text();
    const call = { url: new URL(request.url), request, body };
    if (call.url.pathname === "/v1/oauth2/token") {
      return jsonResponse(200, { access_token: "T", token_type: "Bearer", expires_in: 3600 });
    }
    calls.push(call);
    return responder(call);
  };
  return { fetch: fetchImpl, calls };
}

export function depsWith(stub: { fetch: typeof fetch }): Deps {
  const client = new PaypalClient({
    serverOptions: { baseUrl: "https://api-m.sandbox.paypal.com" },
    oauth2: { clientId: "test-id", clientSecret: "test-secret" },
    retry: { maxRetries: 0, timeout: 2_000 },
    logging: { level: "off" },
    fetch: stub.fetch,
  });
  return { paypal: client, fetch: stub.fetch, appUrl: "http://localhost:3000" };
}

export const connectionDrop = () => {
  throw new TypeError("fetch failed: ECONNRESET");
};

export async function resetDb() {
  await db().query("truncate audit_log, money_actions, milestones cascade");
}

export async function seedMilestone(fields: Record<string, unknown> = {}): Promise<string> {
  const base: Record<string, unknown> = {
    title: "Test milestone",
    amount_cents: 30_000,
    freelancer_email: "freelancer@example.com",
    state: "AGREED",
    ...fields,
  };
  const cols = Object.keys(base);
  const { rows } = await db().query<{ id: string }>(
    `insert into milestones (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    cols.map((c) => base[c]),
  );
  return rows[0]!.id;
}

export async function claimsFor(milestoneId: string) {
  const { rows } = await db().query<{ action: string; status: string; request_id: string; attempt: number }>(
    "select action, status, request_id, attempt from money_actions where milestone_id = $1 order by id",
    [milestoneId],
  );
  return rows;
}

export const authorizedOrder = (orderId: string, authId: string, value = "300.00") => ({
  id: orderId,
  status: "COMPLETED",
  purchase_units: [
    { payments: { authorizations: [{ id: authId, status: "CREATED", amount: { currency_code: "USD", value }, expiration_time: "2026-11-18T10:00:00Z" }] } },
  ],
});
