import { json, toHttp } from "@/lib/http";
import { liveRunBusy, liveRunsLastHour, MAX_RUNS_PER_HOUR, startLiveRun, type LiveKind } from "@/lib/demo-live";
import { HOUR, hit, ipKey, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";

const BUSY = "Another judge is running this one right now. It takes about 3 minutes; try again shortly, or run the other worker.";

// POST /api/demo/live {kind}: starts a real run (see lib/demo-live.ts). Returns its id and the deal's links.
export async function POST(req: Request) {
  try {
    const { kind } = (await req.json().catch(() => ({}))) as { kind?: unknown };
    if (kind !== "honest" && kind !== "cheat") return json(400, { error: "kind must be honest or cheat" });
    if (await liveRunBusy(kind as LiveKind)) return json(409, { error: BUSY });
    if ((await liveRunsLastHour()) >= MAX_RUNS_PER_HOUR) return json(429, { error: "The live demo has run a lot this hour. Try again later, or explore the finished project below." });
    const v = await hit([{ key: ipKey(req, "live"), limit: 4, windowMs: HOUR }]);
    if (!v.ok) return tooMany("You've started four live runs this hour. Try again later, or explore the finished project below.", v.retryAfterMs);
    const run = await startLiveRun(kind as LiveKind);
    return run ? json(201, run) : json(409, { error: BUSY });
  } catch (err) {
    return toHttp(err);
  }
}
