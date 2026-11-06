import { createHmac, randomBytes } from "node:crypto";
import { db, type Queryable } from "@/lib/db";

// Signed webhooks to platforms (V2_PLAN §3.J). Every audit row of a platform's milestone becomes an event,
// written to an outbox in the same transaction as the row, so an event is never lost and never sent for a
// change that rolled back. The tick delivers due events with retries. The payload carries what the public
// proof chain already shows (the event, the states, the non-personal facts), never emails or statements.
//
// Signature: header `Milestone-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`
// with the platform's webhook secret. Reject a t more than 5 minutes old to stop replays.

export const MAX_ATTEMPTS = 12;
const TIMEOUT_MS = 10_000;

export type OutboundEvent = {
  id: string;
  type: string;
  milestoneId: string;
  from: string | null;
  to: string | null;
  at: string;
  paypalId: string | null;
  facts: Record<string, string | number | boolean>;
};

export function newWebhookSecret(): string {
  return `mwhsec_${randomBytes(24).toString("base64url")}`;
}

export function signPayload(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/** https only, and never a loopback, link-local or private address by name: the server mustn't call itself. */
export function webhookUrlProblem(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "isn't a URL";
  }
  if (u.protocol !== "https:") return "must use https";
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h === "0.0.0.0" || h === "::1") return "can't point at this server's own network";
  if (/^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^f[cd][0-9a-f]{2}:|^fe80:/.test(h)) return "can't point at a private address";
  return undefined;
}

/** Called from audit() (milestones/repo.ts), in its transaction. Writes nothing unless a platform listens. */
export async function enqueueOutbound(q: Queryable, auditId: string, e: { milestoneId: string; event: string; fromState?: string; toState?: string; paypalId?: string | null }, facts: OutboundEvent["facts"]): Promise<void> {
  const payload: OutboundEvent = {
    id: `evt_${auditId}`,
    type: e.event,
    milestoneId: e.milestoneId,
    from: e.fromState ?? null,
    to: e.toState ?? null,
    at: new Date().toISOString(),
    paypalId: e.paypalId ?? null,
    facts,
  };
  await q.query(
    `insert into outbound_events (platform_id, milestone_id, event, payload)
     select p.id, m.id, $2, $3 from milestones m join platforms p on p.id = m.platform_id
     where m.id = $1 and p.webhook_url is not null`,
    [e.milestoneId, e.event, JSON.stringify(payload)],
  );
}

/** Minutes until the next try: 1, 2, 4 … capped at 6 hours. */
export const backoffMinutes = (attempts: number) => Math.min(2 ** Math.max(attempts - 1, 0), 360);

/** Deliver due events (oldest first). Safe from several clocks at once: rows are claimed with SKIP LOCKED. */
export async function deliverDue(fetchImpl: typeof fetch = fetch, limit = 20): Promise<{ delivered: number; failed: number }> {
  let delivered = 0;
  let failed = 0;
  const c = await db().connect();
  try {
    await c.query("begin");
    const { rows } = await c.query<{ id: string; event: string; payload: OutboundEvent; attempts: number; webhook_url: string; webhook_secret: string }>(
      `select o.id, o.event, o.payload, o.attempts, p.webhook_url, p.webhook_secret
       from outbound_events o join platforms p on p.id = o.platform_id
       where o.delivered_at is null and o.given_up_at is null and o.next_at <= now() and p.webhook_url is not null
       order by o.id limit $1 for update of o skip locked`,
      [limit],
    );
    for (const r of rows) {
      const body = JSON.stringify(r.payload);
      const t = Math.floor(Date.now() / 1000);
      let status: number | null = null;
      let error: string | null = null;
      try {
        const res = await fetchImpl(r.webhook_url, {
          method: "POST",
          headers: { "content-type": "application/json", "milestone-event": r.event, "milestone-delivery": r.payload.id, "milestone-signature": signPayload(r.webhook_secret, body, t) },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        status = res.status;
        if (status < 200 || status >= 300) error = `HTTP ${status}`;
      } catch (e) {
        error = String((e as Error).message ?? e).slice(0, 200);
      }
      const attempts = r.attempts + 1;
      if (!error) {
        delivered++;
        await c.query("update outbound_events set attempts = $2, delivered_at = now(), last_status = $3, last_error = null where id = $1", [r.id, attempts, status]);
      } else {
        failed++;
        await c.query(
          `update outbound_events set attempts = $2::int, last_status = $3, last_error = $4,
             next_at = now() + make_interval(mins => $5::int), given_up_at = case when $2::int >= $6::int then now() end where id = $1`,
          [r.id, attempts, status, error, backoffMinutes(attempts), MAX_ATTEMPTS],
        );
      }
    }
    await c.query("commit");
  } catch (err) {
    await c.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  return { delivered, failed };
}
