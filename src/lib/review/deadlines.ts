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

/**
 * After an objection, a HUMAN_CHECK has a deadline: the client decides within 72 h of entering it, or the
 * money releases to the worker (the work passed its first review and the client had two chances).
 * A HUMAN_CHECK reached without an objection has no deadline: null.
 */
export function humanCheckDeadline(m: Pick<Milestone, "state" | "contested_at" | "human_check_at" | "updated_at">): Date | null {
  if (m.state !== "HUMAN_CHECK" || !m.contested_at) return null;
  return new Date((m.human_check_at ?? m.updated_at).getTime() + objectionReleaseMs());
}
