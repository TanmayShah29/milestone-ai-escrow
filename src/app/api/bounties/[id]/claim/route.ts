import { claimCode, publicMilestone } from "@/lib/auth";
import { claimBounty } from "@/lib/bounties/bounty";
import { json, toHttp } from "@/lib/http";
import { HOUR, hit, ipKey, tooMany, waitText } from "@/lib/ratelimit";

export const runtime = "nodejs";

// POST /api/bounties/:id/claim { githubLogin, paypalEmail, hash, agent? }: take an open bounty. Returns the
// worker's link token once. Claims are limited per address and per GitHub login.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const login = typeof body.githubLogin === "string" ? body.githubLogin.trim().toLowerCase() : "-";
    const v = await hit([
      { key: ipKey(req, "claim"), limit: 10, windowMs: HOUR },
      { key: `claim:login:${login}`, limit: 5, windowMs: HOUR },
    ]);
    if (!v.ok) return tooMany(`Too many claims for now. Try again in ${waitText(v.retryAfterMs)}.`, v.retryAfterMs);
    const { milestone, workerToken } = await claimBounty(id, body);
    return json(200, { milestone: publicMilestone(milestone), workerToken, claimLine: `Milestone-Claim: ${claimCode(milestone)}` });
  } catch (err) {
    return toHttp(err);
  }
}
