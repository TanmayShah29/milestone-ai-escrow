// Link revocation and expiry, personal-data erasure, and webhook payload retention.
//
// Links are bearer capabilities with no accounts behind them, so the controls are: either side can reissue
// its own link (the old one stops working at once), the client can reissue the worker link only until the
// worker has signed (after that the client could lock the worker out of work it agreed to), and both links
// stop working LINK_TTL_AFTER_CLOSE_MS after the milestone closes.
//
// Erasure keeps what the money rules need (PayPal ids, amounts, states and the audit trail, rules 4 and 5)
// and removes what identifies people or their work. A paid milestone is kept for DISPUTE_WINDOW_MS first:
// PayPal accepts disputes for 180 days, and handling one needs the record.

import { hashToken, newToken, type Role } from "@/lib/auth";
import { db, tx, withMilestoneLock } from "@/lib/db";
import { InvariantViolation } from "@/lib/errors";
import { audit, getMilestone, updateFields, type Actor, type Milestone } from "@/lib/milestones/repo";

const DAY_MS = 24 * 60 * 60 * 1000;
export const LINK_TTL_AFTER_CLOSE_MS = 30 * DAY_MS;
export const DISPUTE_WINDOW_MS = 180 * DAY_MS;
export const WEBHOOK_RETENTION_MS = 30 * DAY_MS;

export const CLOSED_STATES = ["PAID_OUT", "CANCELLED"] as const;

/** When a closed milestone's links stopped (or will stop) working; undefined while it is open. */
export function linksExpireAt(m: Pick<Milestone, "closed_at">): Date | undefined {
  return m.closed_at ? new Date(new Date(m.closed_at).getTime() + LINK_TTL_AFTER_CLOSE_MS) : undefined;
}

/** Issue a new link for `which` and revoke the old one. Returns the new token (shown once). */
export async function rotateLink(id: string, by: Role, which: Role): Promise<{ milestone: Milestone; token: string }> {
  return withMilestoneLock(id, async () => {
    const m = await getMilestone(id);
    if (m.erased_at) throw new InvariantViolation("This milestone's data was erased, so it has no links.");
    if (which === "client" && by !== "client") throw new InvariantViolation("Only the client can reissue the client link.");
    if (which === "worker" && by === "client" && m.worker_signed_at)
      throw new InvariantViolation("The worker has signed, so only the worker can reissue the worker link now.");
    const token = newToken(which === "client" ? "mct" : "mwt");
    const milestone = await tx(async (c) => {
      const out = await updateFields(c, id, which === "client" ? { client_token_hash: hashToken(token) } : { worker_token_hash: hashToken(token) });
      await audit(c, { milestoneId: id, actor: by === "client" ? "client" : "freelancer", event: "link:reissued", detail: { link: which } });
      return out;
    });
    return { milestone, token };
  });
}

/** Why this milestone can't be erased yet, or undefined when it can. */
export function eraseBlocker(m: Milestone, now = Date.now()): string | undefined {
  if (m.erased_at) return "It's already erased.";
  if (m.state === "CANCELLED") return undefined;
  if (m.state === "PAID_OUT") {
    const closed = m.closed_at ? new Date(m.closed_at).getTime() : now;
    if (now - closed >= DISPUTE_WINDOW_MS) return undefined;
    const until = new Date(closed + DISPUTE_WINDOW_MS).toISOString().slice(0, 10);
    return `A paid milestone is kept for 180 days in case of a PayPal dispute. You can erase it from ${until}.`;
  }
  return "Only a paid or cancelled milestone can be erased.";
}

/**
 * Remove personal data from a closed milestone: names, emails, the brief, the terms and the deliverable,
 * its reviews and its webhook payloads. Both links are revoked. Amounts, PayPal ids and the audit trail stay.
 */
export async function eraseMilestone(id: string, actor: Actor): Promise<Milestone> {
  return withMilestoneLock(id, async () => {
    const m = await getMilestone(id);
    const blocker = eraseBlocker(m);
    if (blocker) throw new InvariantViolation(blocker);
    return tx(async (c) => {
      const out = await updateFields(c, id, {
        title: "Erased milestone",
        brief: "",
        client_email: null,
        freelancer_email: "",
        repo: null,
        stack: null,
        pr_url: null,
        approve_url: null,
        deliverable_text: null,
        objection_reason: null,
        changes_reason: null,
        criteria: null,
        client_token_hash: null,
        worker_token_hash: null,
        erased_at: new Date(),
      });
      await c.query("delete from reviews where milestone_id = $1", [id]);
      await c.query(`update webhook_events set payload = '{}'::jsonb, pruned_at = now() where milestone_id = $1 and pruned_at is null`, [id]);
      await audit(c, { milestoneId: id, actor, event: "privacy:erased" });
      return out;
    });
  });
}

/**
 * Retention, run from the tick sweep: empty webhook payloads PayPal can no longer redeliver, and erase paid
 * or cancelled milestones once their dispute window has passed. Bounded per run.
 */
export async function privacySweep(): Promise<{ prunedWebhooks: number; erased: string[] }> {
  const { rowCount } = await db().query(
    `update webhook_events set payload = '{}'::jsonb, pruned_at = now()
      where id in (select id from webhook_events where pruned_at is null and received_at < now() - make_interval(secs => $1) limit 200)`,
    [WEBHOOK_RETENTION_MS / 1000],
  );
  const { rows } = await db().query<{ id: string }>(
    `select id from milestones where erased_at is null and state in ('PAID_OUT', 'CANCELLED')
        and closed_at < now() - make_interval(secs => $1) order by closed_at limit 10`,
    [DISPUTE_WINDOW_MS / 1000],
  );
  const erased: string[] = [];
  for (const { id } of rows) {
    try {
      await eraseMilestone(id, "system");
      erased.push(id);
    } catch (err) {
      console.warn(`retention erase of ${id} failed: ${String(err).slice(0, 200)}`);
    }
  }
  return { prunedWebhooks: rowCount ?? 0, erased };
}
