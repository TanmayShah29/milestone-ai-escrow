import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import type { Milestone } from "@/lib/milestones/repo";

// Who may do what. A milestone has a client link and a worker link (capability tokens); a platform
// (marketplace or AI agent) uses an API key and acts as the paying side of the milestones it created.

export type Role = "client" | "worker";

export class Unauthorized extends Error {}
export class Forbidden extends Error {}

export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string | null): boolean {
  if (!b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return req.headers.get("x-milestone-token")?.trim() || undefined;
}

export type Platform = { id: string; name: string };

/** The platform behind an API key (`msk_...`), or undefined if the request carries none. Throws on a bad key. */
export async function platformFrom(req: Request): Promise<Platform | undefined> {
  const t = bearer(req);
  if (!t?.startsWith("msk_")) return undefined;
  const { rows } = await db().query<Platform>("select id, name from platforms where api_key_hash = $1", [hashToken(t)]);
  if (!rows[0]) throw new Unauthorized("invalid API key");
  return rows[0];
}

/** The caller's role on this milestone, from a milestone token or the owning platform's key. */
export async function roleOn(req: Request, m: Milestone): Promise<Role> {
  const t = bearer(req);
  if (!t) throw new Unauthorized("this milestone needs its client or worker link");
  if (t.startsWith("msk_")) {
    const p = await platformFrom(req);
    if (p && p.id === m.platform_id) return "client";
    throw new Forbidden("this API key does not own this milestone");
  }
  const h = hashToken(t);
  if (sameHash(h, m.client_token_hash)) return "client";
  if (sameHash(h, m.worker_token_hash)) return "worker";
  throw new Forbidden("that link is not valid for this milestone");
}

export function requireRole(role: Role, ...allowed: Role[]): void {
  if (!allowed.includes(role)) throw new Forbidden(`only the ${allowed.join(" or ")} can do that`);
}

/** Never send token hashes to a browser. */
export function publicMilestone(m: Milestone) {
  const { client_token_hash: _c, worker_token_hash: _w, ...rest } = m;
  void _c;
  void _w;
  return rest;
}
