import { json } from "@/lib/http";
import { tickAll } from "@/lib/review/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pinged every few minutes by a free uptime monitor: keeps the free Render instance awake and moves
// milestones forward (review once CI finishes, release once the objection window passes, sync payouts).
// Public on purpose (every step is idempotent and gated by state and the decision policy), so it is
// throttled: at most one sweep per MIN_GAP_MS per process, and concurrent callers share the one running.
const MIN_GAP_MS = 30_000;
const g = globalThis as unknown as { __tick?: { at: number; running?: Promise<unknown> } };

export async function GET() {
  const t = (g.__tick ??= { at: 0 });
  if (t.running) return json(200, { ticked: await t.running, shared: true });
  if (Date.now() - t.at < MIN_GAP_MS) return json(200, { ticked: [], skipped: "ran less than 30 seconds ago" });
  t.at = Date.now();
  t.running = tickAll().finally(() => (t.running = undefined));
  return json(200, { ticked: await t.running });
}
