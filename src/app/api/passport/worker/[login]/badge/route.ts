import { GITHUB_LOGIN } from "@/lib/contract/signatures";
import { badgeSvg, workerPassport } from "@/lib/passport";

export const runtime = "nodejs";

// GET /api/passport/worker/:login/badge: an SVG badge for a README.
export async function GET(_req: Request, ctx: { params: Promise<{ login: string }> }) {
  const { login } = await ctx.params;
  if (!GITHUB_LOGIN.test(login)) return new Response("bad login", { status: 400 });
  const { passport } = await workerPassport(login);
  return new Response(badgeSvg(passport), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=600" } });
}
