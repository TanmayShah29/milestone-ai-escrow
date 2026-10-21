import { createHash } from "node:crypto";
import type { NextResponse } from "next/server";
import { tx } from "@/lib/db";
import { json } from "@/lib/http";

// Postgres-backed request limits for the public demo (create, AI drafting, judge mode). Survives
// restarts and works across instances, unlike an in-memory map. Counts like demosLastHour: rows in
// the window. Raw IPs are never stored, only a hash.

export type Rule = { key: string; limit: number; windowMs: number };
export type Verdict = { ok: true } | { ok: false; rule: Rule; retryAfterMs: number };

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** The caller's IP: Cloudflare's header first, then the first x-forwarded-for hop. */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip")?.split(",")[0]?.trim();
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || "unknown";
}

/** A limit key for this caller's IP, hashed so the table never holds an address. */
export function ipKey(req: Request, scope: string): string {
  const h = createHash("sha256").update(`milestone-rl:${clientIp(req)}`).digest("hex");
  return `${scope}:ip:${h}`;
}

/**
 * Checks every rule and, only if all pass, records one event against each. Counting and recording run
 * under a per-key transaction lock, so concurrent requests can't both slip in under the limit.
 */
export async function hit(rules: Rule[]): Promise<Verdict> {
  if (rules.length === 0) return { ok: true };
  const verdict = await tx(async (c) => {
    // Lock in a stable order (no deadlocks). The two-int form keeps clear of the milestone locks.
    for (const key of [...new Set(rules.map((r) => r.key))].sort()) {
      await c.query("select pg_advisory_xact_lock(7311, hashtext($1))", [key]);
    }
    for (const rule of rules) {
      const { rows } = await c.query<{ n: string; oldest: Date | null }>(
        "select count(*) as n, min(created_at) as oldest from rate_events where key = $1 and created_at > now() - make_interval(secs => $2)",
        [rule.key, rule.windowMs / 1000],
      );
      const n = Number(rows[0]!.n);
      if (n >= rule.limit) {
        const oldest = rows[0]!.oldest?.getTime() ?? Date.now();
        return { ok: false as const, rule, retryAfterMs: Math.max(0, oldest + rule.windowMs - Date.now()) };
      }
    }
    for (const rule of rules) await c.query("insert into rate_events (key) values ($1)", [rule.key]);
    return { ok: true as const };
  });
  // Opportunistic pruning: nothing we count looks back more than a day.
  if (verdict.ok && Math.random() < 0.05) {
    await tx((c) => c.query("delete from rate_events where created_at < now() - interval '2 days'")).catch(() => {});
  }
  return verdict;
}

/** "about 12 minutes" / "about 3 hours", for the 429 copy. */
export function waitText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hours`;
}

/** A 429 with human copy and a Retry-After header. */
export function tooMany(error: string, retryAfterMs: number): NextResponse {
  const res = json(429, { error, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) });
  res.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return res;
}
