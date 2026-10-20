import { db } from "@/lib/db";
import { json, toHttp } from "@/lib/http";
import { getMilestone } from "@/lib/milestones/repo";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const milestone = await getMilestone(id);
    const { rows: audit } = await db().query("select * from audit_log where milestone_id = $1 order by id", [id]);
    const { rows: actions } = await db().query(
      "select action, attempt, request_id, status, paypal_id, created_at from money_actions where milestone_id = $1 order by id",
      [id],
    );
    return json(200, { milestone, audit, actions });
  } catch (err) {
    return toHttp(err);
  }
}
