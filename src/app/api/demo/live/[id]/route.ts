import { advanceLiveRun } from "@/lib/demo-live";
import { json, toHttp } from "@/lib/http";

export const runtime = "nodejs";

// POST /api/demo/live/<id>: the page's poll. Moves the run one idempotent step and returns its progress.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const progress = await advanceLiveRun(id);
    return progress ? json(200, progress) : json(404, { error: "no such run" });
  } catch (err) {
    return toHttp(err);
  }
}
