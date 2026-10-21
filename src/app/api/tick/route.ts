import { json } from "@/lib/http";
import { tickAll } from "@/lib/review/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pinged every few minutes by a free uptime monitor: keeps the free Render instance awake and moves
// milestones forward (review once CI finishes, release once the objection window passes, sync payouts).
// Public on purpose: every step is idempotent and gated by state and the decision policy.
export async function GET() {
  return json(200, { ticked: await tickAll() });
}
