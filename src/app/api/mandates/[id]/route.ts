import { json, toHttp } from "@/lib/http";
import { getMandate, publicMandate } from "@/lib/mandates/mandate";

export const runtime = "nodejs";

// GET /api/mandates/:id: the signed mandate (its limits, the passkey's public key and signature, and what
// it has committed so far). Public, so anyone can check what an agent was allowed to spend.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    return json(200, await publicMandate(await getMandate((await ctx.params).id)));
  } catch (err) {
    return toHttp(err);
  }
}
