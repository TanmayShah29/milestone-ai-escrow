import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import type { Milestone } from "@/lib/milestones/repo";
import { feeSchedule } from "@/lib/money/amounts";
import { eraseBlocker, linksExpireAt } from "@/lib/privacy";
import { humanCheckDeadline } from "@/lib/review/deadlines";

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

export function sameHash(a: string, b: string | null): boolean {
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
  if (!rows[0]) throw new Unauthorized("That API key isn't valid.");
  return rows[0];
}

/** The caller's role on this milestone, from a milestone token or the owning platform's key. */
export async function roleOn(req: Request, m: Milestone): Promise<Role> {
  const t = bearer(req);
  if (!t) throw new Unauthorized("Open this milestone with its client or worker link.");
  if (t.startsWith("msk_")) {
    const p = await platformFrom(req);
    if (p && p.id === m.platform_id) return "client";
    throw new Forbidden("This API key didn't create this milestone.");
  }
  const h = hashToken(t);
  const role: Role | undefined = sameHash(h, m.client_token_hash) ? "client" : sameHash(h, m.worker_token_hash) ? "worker" : undefined;
  if (!role) throw new Forbidden("This link doesn't open this milestone.");
  // Links stop working 30 days after the milestone closes (a platform's API key keeps access).
  const expires = linksExpireAt(m);
  if (expires && expires.getTime() <= Date.now()) throw new Forbidden(`This milestone closed, and its links expired on ${expires.toISOString().slice(0, 10)}.`);
  return role;
}

export function requireRole(role: Role, ...allowed: Role[]): void {
  if (!allowed.includes(role)) throw new Forbidden(`Only the ${allowed.join(" or ")} can do that.`);
}

/**
 * Never send token hashes to a browser. Adds decide_by: when an undecided HUMAN_CHECK is settled by fixed
 * rules (after an objection, or before the hold expires without one), or null. The client's reasons
 * (objection_reason, changes_reason) are always included, so the worker can read them.
 */
/**
 * A bounty claim's code, which the claimer's pull request must carry ("Milestone-Claim: <code>"). It comes
 * from this claim's worker link, so it changes with every claim: a pull request opened under an earlier
 * claim can't be handed in by a later claimer who signed with the same GitHub login.
 */
export function claimCode(m: Pick<Milestone, "open_bounty" | "worker_token_hash">): string | null {
  if (!m.open_bounty || !m.worker_token_hash) return null;
  return `mc-${createHash("sha256").update(`claim:${m.worker_token_hash}`).digest("hex").slice(0, 12)}`;
}

export function publicMilestone(m: Milestone) {
  const { client_token_hash: _c, worker_token_hash: _w, ...rest } = m;
  void _c;
  void _w;
  return { ...rest, claim_code: claimCode(m), objection_reason: m.objection_reason ?? null, changes_reason: m.changes_reason ?? null, decide_by: humanCheckDeadline(m), fee_schedule: feeSchedule(), links_expire_at: linksExpireAt(m) ?? null, erase_blocker: eraseBlocker(m) ?? null };
}
