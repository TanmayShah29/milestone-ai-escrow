import { db } from "@/lib/db";
import { json, toHttp } from "@/lib/http";
import { valueToCents } from "@/lib/money/amounts";
import { createMilestone, type Milestone } from "@/lib/milestones/repo";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { rows } = await db().query<Milestone>("select * from milestones order by created_at desc limit 50");
    return json(200, { milestones: rows });
  } catch (err) {
    return toHttp(err);
  }
}

export async function POST(req: Request) {
  try {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const title = typeof b.title === "string" ? b.title.trim() : "";
    const freelancerEmail = typeof b.freelancerEmail === "string" ? b.freelancerEmail.trim() : "";
    let amountCents: number;
    try {
      amountCents = valueToCents(String(b.amount ?? ""));
    } catch {
      return json(400, { error: 'amount must look like "300.00"' });
    }
    if (!title || !freelancerEmail || amountCents <= 0 || amountCents > 1_000_000) {
      return json(400, { error: "title, freelancerEmail and an amount between 0.01 and 10000.00 are required" });
    }
    const m = await createMilestone({
      title,
      brief: typeof b.brief === "string" ? b.brief : "",
      amountCents,
      freelancerEmail,
      ...(typeof b.clientEmail === "string" ? { clientEmail: b.clientEmail } : {}),
    });
    return json(201, { milestone: m });
  } catch (err) {
    return toHttp(err);
  }
}
