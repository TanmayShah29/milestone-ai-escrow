import { GITHUB_LOGIN } from "@/lib/contract/signatures";
import { json, toHttp } from "@/lib/http";
import { workerPassport } from "@/lib/passport";

export const runtime = "nodejs";

// GET /api/passport/worker/:login: a worker's signed record (check it against /.well-known/milestone-proof-keys.json).
export async function GET(_req: Request, ctx: { params: Promise<{ login: string }> }) {
  try {
    const { login } = await ctx.params;
    if (!GITHUB_LOGIN.test(login)) return json(400, { error: "That isn't a GitHub username." });
    return json(200, await workerPassport(login));
  } catch (err) {
    return toHttp(err);
  }
}
