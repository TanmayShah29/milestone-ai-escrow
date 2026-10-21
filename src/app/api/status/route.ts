import { callsToday, configuredModels, dailyCap } from "@/lib/ai/client";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// For the status banner: which free models are configured, the last one that answered, whether the AI
// looks busy, and today's budget. Public, so it never returns error text or failure details.
const BUSY_AFTER_FAILURES = 3;

export async function GET() {
  try {
    const { rows } = await db().query<{ model: string }>("select model from ai_calls where ok order by id desc limit 1");
    // Busy: the last few calls in the past 15 minutes all failed, or today's budget is spent.
    const { rows: recent } = await db().query<{ ok: boolean }>(
      "select ok from ai_calls where created_at > now() - interval '15 minutes' order by id desc limit $1",
      [BUSY_AFTER_FAILURES],
    );
    const aiCallsToday = await callsToday();
    const aiDailyCap = dailyCap();
    const failing = recent.length === BUSY_AFTER_FAILURES && recent.every((r) => !r.ok);
    return json(200, { models: configuredModels(), lastModel: rows[0]?.model ?? null, busy: failing || aiCallsToday >= aiDailyCap, aiCallsToday, aiDailyCap });
  } catch {
    return json(503, { error: "status unavailable" });
  }
}
