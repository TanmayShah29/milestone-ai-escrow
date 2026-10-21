import { callsToday, configuredModels, dailyCap } from "@/lib/ai/client";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// For the status banner: which free models are configured, the last one that answered, and today's budget.
export async function GET() {
  try {
    const { rows } = await db().query<{ model: string; created_at: Date }>("select model, created_at from ai_calls where ok order by id desc limit 1");
    return json(200, { models: configuredModels(), lastModel: rows[0]?.model ?? null, aiCallsToday: await callsToday(), aiDailyCap: dailyCap() });
  } catch {
    return json(503, { error: "status unavailable" });
  }
}
