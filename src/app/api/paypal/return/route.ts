import { NextResponse } from "next/server";
import { toHttp } from "@/lib/http";
import { authorizeHold } from "@/lib/money/flow";

export const runtime = "nodejs";

// PayPal sends the client back here after they approve the hold: ?milestone=<id>&token=<order id>.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const milestoneId = url.searchParams.get("milestone") ?? "";
  const token = url.searchParams.get("token") ?? "";
  try {
    await authorizeHold(milestoneId, token);
    return NextResponse.redirect(new URL(`/milestones/${milestoneId}?funded=1`, url));
  } catch (err) {
    const res = toHttp(err);
    const { error } = (await res.json()) as { error?: string };
    const back = new URL(`/milestones/${encodeURIComponent(milestoneId)}`, url);
    back.searchParams.set("error", error ?? "Could not authorize the hold");
    return NextResponse.redirect(back);
  }
}
