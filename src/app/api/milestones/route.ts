import { platformFrom, publicMilestone, Unauthorized } from "@/lib/auth";
import { db } from "@/lib/db";
import { json, toHttp } from "@/lib/http";
import { valueToCents } from "@/lib/money/amounts";
import { createMilestone, type Milestone } from "@/lib/milestones/repo";

export const runtime = "nodejs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET: a platform lists its own milestones (API key required). People use their milestone links.
export async function GET(req: Request) {
  try {
    const platform = await platformFrom(req);
    if (!platform) throw new Unauthorized("listing milestones needs a platform API key");
    const { rows } = await db().query<Milestone>("select * from milestones where platform_id = $1 order by created_at desc limit 100", [platform.id]);
    return json(200, { milestones: rows.map(publicMilestone) });
  } catch (err) {
    return toHttp(err);
  }
}

// POST: anyone can open a milestone (the web app's client), or a platform with its API key.
// The response carries the client and worker links' tokens, once.
export async function POST(req: Request) {
  try {
    const platform = await platformFrom(req);
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const title = typeof b.title === "string" ? b.title.trim() : "";
    const freelancerEmail = typeof b.freelancerEmail === "string" ? b.freelancerEmail.trim() : "";
    let amountCents: number;
    try {
      amountCents = valueToCents(String(b.amount ?? ""));
    } catch {
      return json(400, { error: 'amount must look like "300.00"' });
    }
    if (!title || title.length > 200) return json(400, { error: "title is required (max 200 characters)" });
    if (!EMAIL.test(freelancerEmail)) return json(400, { error: "freelancerEmail must be the worker's PayPal email" });
    if (amountCents <= 0 || amountCents > 1_000_000) return json(400, { error: "amount must be between 0.01 and 10000.00" });
    const clientEmail = typeof b.clientEmail === "string" && EMAIL.test(b.clientEmail.trim()) ? b.clientEmail.trim() : undefined;
    const { milestone, clientToken, workerToken } = await createMilestone({
      title,
      brief: typeof b.brief === "string" ? b.brief.slice(0, 5000) : "",
      amountCents,
      freelancerEmail,
      ...(clientEmail ? { clientEmail } : {}),
      ...(platform ? { platformId: platform.id } : {}),
      verifier: b.verifier === "rubric_text" ? "rubric_text" : "code_pr",
    });
    return json(201, { milestone: publicMilestone(milestone), clientToken, workerToken });
  } catch (err) {
    return toHttp(err);
  }
}
