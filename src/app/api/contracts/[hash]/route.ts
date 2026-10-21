import { contractByHash } from "@/lib/contract/terms";
import { json, toHttp } from "@/lib/http";

export const runtime = "nodejs";

// The locked contract for CI: GET /api/contracts/<sha256>. `document` is the exact canonical JSON whose
// SHA-256 is the hash, so a CI job can verify it before writing the acceptance tests and running them.
export async function GET(_req: Request, ctx: { params: Promise<{ hash: string }> }) {
  try {
    const { hash } = await ctx.params;
    const c = await contractByHash(hash);
    if (!c) return json(404, { error: "no agreed contract with that hash" });
    return json(200, c);
  } catch (err) {
    return toHttp(err);
  }
}
