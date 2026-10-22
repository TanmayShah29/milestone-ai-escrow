import { platformFrom, publicMilestone, Unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { json, toHttp } from "@/lib/http";
import { MIN_AMOUNT_CENTS, valueToCents } from "@/lib/money/amounts";
import { createMilestone, type Milestone } from "@/lib/milestones/repo";
import { HOUR, hit, ipKey, tooMany, waitText } from "@/lib/ratelimit";
import { dueCapMessage, latestDueAt } from "@/lib/timeline";

export const runtime = "nodejs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET: a platform lists its own milestones (API key required). People use their milestone links.
export async function GET(req: Request) {
  try {
    const platform = await platformFrom(req);
    if (!platform) throw new Unauthorized("Listing milestones needs a platform API key.");
    const { rows } = await db().query<Milestone>("select * from milestones where platform_id = $1 order by created_at desc limit 100", [platform.id]);
    return json(200, { milestones: rows.map(publicMilestone) });
  } catch (err) {
    return toHttp(err);
  }
}

// POST: anyone can open a milestone (the web app's client), or a platform with its API key.
// The response carries the client and worker links' tokens, once. Anonymous callers get 10 per hour
// per IP (the public demo); platforms with an API key aren't limited per IP.
const CREATE_PER_IP_HOUR = 10;

export async function POST(req: Request) {
  try {
    const platform = await platformFrom(req);
    if (!platform) {
      const v = await hit([{ key: ipKey(req, "create"), limit: CREATE_PER_IP_HOUR, windowMs: HOUR }]);
      if (!v.ok) return tooMany(`You've opened ${CREATE_PER_IP_HOUR} milestones this hour. Try again in ${waitText(v.retryAfterMs)}.`, v.retryAfterMs);
    }
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const title = typeof b.title === "string" ? b.title.trim() : "";
    const freelancerEmail = typeof b.freelancerEmail === "string" ? b.freelancerEmail.trim() : "";
    let amountCents: number;
    try {
      amountCents = valueToCents(String(b.amount ?? ""));
    } catch {
      return json(400, { error: 'Enter the amount in dollars, like 300.00.' });
    }
    if (!title || title.length > 200) return json(400, { error: "Give the milestone a title (200 characters at most)." });
    if (!EMAIL.test(freelancerEmail)) return json(400, { error: "Enter the worker's PayPal email address." });
    if (amountCents < MIN_AMOUNT_CENTS) return json(400, { error: "The smallest milestone is $10.00. Below that, PayPal's fees take most of the payment." });
    if (amountCents > 1_000_000) return json(400, { error: "The largest milestone is $10,000.00." });
    const dueAt = typeof b.dueDate === "string" && b.dueDate ? new Date(b.dueDate) : undefined;
    if (dueAt && (Number.isNaN(dueAt.getTime()) || dueAt.getTime() < Date.now())) return json(400, { error: "Pick a due date in the future." });
    const dueLimit = latestDueAt({ created_at: new Date(), authorization_expires_at: null });
    if (dueAt && dueAt.getTime() > dueLimit.getTime()) return json(400, { error: dueCapMessage(dueLimit) });
    const afterId = typeof b.afterMilestoneId === "string" && /^[0-9a-f-]{36}$/i.test(b.afterMilestoneId) ? b.afterMilestoneId : undefined;
    const clientEmail = typeof b.clientEmail === "string" && EMAIL.test(b.clientEmail.trim()) ? b.clientEmail.trim() : undefined;
    const { milestone, clientToken, workerToken } = await createMilestone({
      title,
      brief: typeof b.brief === "string" ? b.brief.slice(0, 5000) : "",
      amountCents,
      freelancerEmail,
      ...(clientEmail ? { clientEmail } : {}),
      ...(platform ? { platformId: platform.id } : {}),
      verifier: b.verifier === "rubric_text" ? "rubric_text" : "code_pr",
      ...(dueAt ? { dueAt } : {}),
      ...(afterId ? { afterMilestoneId: afterId } : {}),
    });
    return json(201, { milestone: publicMilestone(milestone), clientToken, workerToken });
  } catch (err) {
    return toHttp(err);
  }
}
