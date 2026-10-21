import { db, withMilestoneLock } from "@/lib/db";
import { InvariantViolation } from "@/lib/errors";
import { audit, getMilestone, updateFields, type Milestone } from "@/lib/milestones/repo";
import { holdWarning } from "@/lib/timeline";

// The client moves the work's due date (dragging the Work bar in the Gantt). Allowed until the work is
// submitted. If the new date is past the PayPal hold's 29-day expiry, the change is kept and flagged:
// the hold must be reauthorized (refresh-hold) or the date moved back.
export async function setDueDate(milestoneId: string, dueAt: string): Promise<{ milestone: Milestone; warnings: string[] }> {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw new InvariantViolation("dueAt must be a date");
  if (due.getTime() < Date.now() - 60_000) throw new InvariantViolation("the due date can't be in the past");
  if (due.getTime() > Date.now() + 365 * 86_400_000) throw new InvariantViolation("the due date must be within a year");
  return withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    if (!["DRAFT", "AGREED", "FUNDED"].includes(m.state)) throw new InvariantViolation("the due date is fixed once work is submitted");
    const out = await updateFields(db(), m.id, { due_at: due });
    const warning = holdWarning(out);
    await audit(db(), { milestoneId: m.id, actor: "client", event: "schedule:due_changed", detail: { from: m.due_at, to: due.toISOString(), ...(warning ? { warning } : {}) } });
    return { milestone: out, warnings: warning ? [warning] : [] };
  });
}
