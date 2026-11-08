import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { db, isUniqueViolation } from "@/lib/db";
import { json } from "@/lib/http";

// Idempotency-Key on our own POSTs (V2_PLAN §3.J), the way PayPal's PayPal-Request-Id works for us: the
// first response to a key is stored, and a retry with the same key and body gets that response again
// (header Idempotent-Replayed: true) instead of acting twice. The same key with a different body is refused.
// Keys are scoped to the caller (a platform's key, or the link token), and kept 24 hours. A stored create
// response holds the new links' tokens: they are pruned with the key.

export const KEY_TTL_HOURS = 24;
// A key still "in progress" this long after it started belongs to a request the server never finished
// (a restart or a deploy mid-request): it is dropped so the retry can run, instead of a 409 for 24 hours.
// Longer than the slowest request (an AI draft over three free models, about 4.5 minutes at worst).
export const ABANDONED_AFTER_MS = 5 * 60_000;

function callerScope(req: Request, path: string): string {
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.headers.get("x-milestone-token") ?? "";
  const who = auth ? createHash("sha256").update(auth).digest("hex").slice(0, 32) : `anon:${req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "-"}`;
  return `${who}:${path}`;
}

export async function withIdempotency(req: Request, path: string, run: () => Promise<NextResponse>): Promise<NextResponse> {
  const key = req.headers.get("idempotency-key")?.trim();
  if (!key) return run();
  if (key.length > 100) return json(400, { error: "Idempotency-Key must be at most 100 characters." });
  const scope = callerScope(req, path);
  const hash = createHash("sha256").update(await req.clone().text()).digest("hex");
  try {
    await db().query("insert into idempotency_keys (scope, key, request_hash) values ($1, $2, $3)", [scope, key, hash]);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const { rows } = await db().query<{ request_hash: string; status: number | null; response: unknown; created_at: Date }>("select request_hash, status, response, created_at from idempotency_keys where scope = $1 and key = $2", [scope, key]);
    const prior = rows[0];
    if (prior && Date.now() - prior.created_at.getTime() > KEY_TTL_HOURS * 3_600_000) {
      await db().query("delete from idempotency_keys where scope = $1 and key = $2", [scope, key]);
      return withIdempotency(req, path, run);
    }
    if (!prior || prior.request_hash !== hash) return json(422, { error: "This Idempotency-Key was already used with a different request." });
    if (prior.status === null && Date.now() - prior.created_at.getTime() > ABANDONED_AFTER_MS) {
      await db().query("delete from idempotency_keys where scope = $1 and key = $2 and status is null", [scope, key]);
      return withIdempotency(req, path, run);
    }
    if (prior.status === null) return json(409, { error: "A request with this Idempotency-Key is still in progress." });
    const res = json(prior.status, prior.response);
    res.headers.set("idempotent-replayed", "true");
    return res;
  }
  let res: NextResponse;
  try {
    res = await run();
  } catch (err) {
    await db().query("delete from idempotency_keys where scope = $1 and key = $2", [scope, key]);
    throw err;
  }
  // Server errors aren't stored: a retry may succeed. Everything else is the answer for this key.
  if (res.status >= 500) await db().query("delete from idempotency_keys where scope = $1 and key = $2", [scope, key]);
  else await db().query("update idempotency_keys set status = $3, response = $4 where scope = $1 and key = $2", [scope, key, res.status, await res.clone().text()]);
  return res;
}

export async function pruneIdempotencyKeys(): Promise<void> {
  await db().query("delete from idempotency_keys where created_at < now() - make_interval(hours => $1)", [KEY_TTL_HOURS]);
}
