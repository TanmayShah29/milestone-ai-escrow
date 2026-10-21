import { roleOn } from "@/lib/auth";
import { db } from "@/lib/db";
import { json, toHttp } from "@/lib/http";
import { getMilestone } from "@/lib/milestones/repo";
import { buildTimeline } from "@/lib/timeline";

export const runtime = "nodejs";

// GET /api/milestones/:id/timeline: the milestone as Gantt tasks + dependencies (client or worker link).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const m = await getMilestone(id);
    const role = await roleOn(req, m);
    const { rows } = await db().query<{ event: string; to_state: string | null; created_at: Date }>("select event, to_state, created_at from audit_log where milestone_id = $1 order by id", [id]);
    return json(200, { role, ...buildTimeline(m, rows) });
  } catch (err) {
    return toHttp(err);
  }
}
