import { json, toHttp } from "@/lib/http";
import { clientPassport } from "@/lib/passport";

export const runtime = "nodejs";

// GET /api/passport/client/:mandateId: a client's signed record, fairness in the other direction: its
// objections, decisions it let time out, and awards against it.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json(404, { error: "No such mandate." });
    const p = await clientPassport(id);
    return p ? json(200, p) : json(404, { error: "No such mandate." });
  } catch (err) {
    return toHttp(err);
  }
}
