import { roleOn } from "@/lib/auth";
import { db } from "@/lib/db";
import { json, toHttp } from "@/lib/http";
import { getMilestone } from "@/lib/milestones/repo";
import { buildTimeline, type AuditRow } from "@/lib/timeline";

export const runtime = "nodejs";

// GET /api/milestones/:id/timeline: the milestone as Gantt tasks + dependencies (client or worker link).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const m = await getMilestone(id);
    const role = await roleOn(req, m);
    // detail feeds the "why it moved" notes (failed criteria); only buildTimeline's words leave this route.
    const { rows } = await db().query<AuditRow>("select event, to_state, created_at, detail from audit_log where milestone_id = $1 order by id", [id]);
    return json(200, { role, ...buildTimeline(m, rows) });
  } catch (err) {
    return toHttp(err);
  }
}
