import { NextResponse } from "next/server";
import { toHttp } from "@/lib/http";
import { authorizeHold, InProgress } from "@/lib/money/flow";

export const runtime = "nodejs";

// PayPal sends the client back here after they approve the hold: ?milestone=<id>&token=<order id>.
// No milestone token is needed: authorizeHold only accepts this milestone's own order id.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = process.env.APP_URL ?? url.origin; // behind Render's proxy req.url's host can be internal
  const milestoneId = url.searchParams.get("milestone") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const back = new URL(`/milestones/${encodeURIComponent(milestoneId)}`, base);
  try {
    await authorizeHold(milestoneId, token);
    back.searchParams.set("funded", "1");
  } catch (err) {
    if (err instanceof InProgress) {
      // The approval webhook is authorizing the same hold right now; the page will pick up the result.
      back.searchParams.set("funded", "pending");
    } else {
      const { error } = (await toHttp(err).json()) as { error?: string };
      back.searchParams.set("error", error ?? "Could not authorize the hold");
    }
  }
  return NextResponse.redirect(back);
}
