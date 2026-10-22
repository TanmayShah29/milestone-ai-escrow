import type { Milestone } from "@/lib/milestones/repo";

// The review clocks, from env. Pure (no db, no AI), so the API's public view can use them too.

export function objectionWindowMs(): number {
  const s = Number(process.env.OBJECTION_WINDOW_SECONDS ?? "120"); // 48 h in production; 2 min for the demo
  return (Number.isFinite(s) && s >= 0 ? s : 120) * 1000;
}

/** After an objection, a passing second review releases this long after the objection (72 h). */
export function objectionReleaseMs(): number {
  const s = Number(process.env.OBJECTION_RELEASE_SECONDS ?? "259200");
  return (Number.isFinite(s) && s >= 0 ? s : 259_200) * 1000;
}

/** A HUMAN_CHECK reached without an objection is decided this long before the PayPal hold expires (3 days). */
export const HOLD_DECIDE_MARGIN_MS = 3 * 86_400_000;

/**
 * When an undecided HUMAN_CHECK is settled by fixed rules (tick → expireHumanCheck), or null for none.
 *  - After an objection (contested_at set): 72 h after entering it. The work passed its first review and
 *    the client had two chances.
 *  - Without an objection: 3 days before the PayPal hold expires, so the money is never stranded by a
 *    lapsed hold. With no known hold expiry, there is no deadline.
 */
export function humanCheckDeadline(
  m: Pick<Milestone, "state" | "contested_at" | "human_check_at" | "updated_at" | "authorization_expires_at">,
): Date | null {
  if (m.state !== "HUMAN_CHECK") return null;
  if (m.contested_at) return new Date(new Date(m.human_check_at ?? m.updated_at).getTime() + objectionReleaseMs());
  if (!m.authorization_expires_at) return null;
  const expires = new Date(m.authorization_expires_at).getTime();
  return Number.isFinite(expires) ? new Date(expires - HOLD_DECIDE_MARGIN_MS) : null;
}
