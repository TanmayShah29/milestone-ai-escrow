import { publicMilestone, roleOn } from "@/lib/auth";
import { db } from "@/lib/db";
import { json, toHttp } from "@/lib/http";
import { getMilestone } from "@/lib/milestones/repo";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const milestone = await getMilestone(id);
    const role = await roleOn(req, milestone);
    const { rows: audit } = await db().query(
      "select id, actor, event, from_state, to_state, paypal_id, created_at from audit_log where milestone_id = $1 order by id",
      [id],
    );
    const { rows: actions } = await db().query("select action, attempt, status, paypal_id, created_at from money_actions where milestone_id = $1 order by id", [id]);
    const { rows: reviews } = await db().query(
      "select head_sha, status, verdict, decision, reasons, model, updated_at from reviews where milestone_id = $1 order by updated_at desc limit 1",
      [id],
    );
    return json(200, { role, milestone: publicMilestone(milestone), audit, actions, review: reviews[0] ?? null });
  } catch (err) {
    return toHttp(err);
  }
}
