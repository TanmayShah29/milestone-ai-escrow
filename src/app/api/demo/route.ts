import { json, toHttp } from "@/lib/http";
import { demosLastHour, seedDemoProject } from "@/lib/demo";
import { HOUR, hit, ipKey, tooMany } from "@/lib/ratelimit";

export const runtime = "nodejs";

// POST /api/demo: seeds a fresh judge-mode project and returns its client and worker links.
// Braked per visitor (5/hour, in Postgres by hashed IP) and globally (30 projects/hour) to protect the free tier.
export async function POST(req: Request) {
  try {
    if ((await demosLastHour()) >= 30) return json(429, { error: "The demo is busy right now. Try again in a few minutes." });
    const v = await hit([{ key: ipKey(req, "demo"), limit: 5, windowMs: HOUR }]);
    if (!v.ok) return tooMany("You've started five demos this hour. Reuse the one you have, or try again later.", v.retryAfterMs);
    return json(201, { milestones: await seedDemoProject() });
  } catch (err) {
    return toHttp(err);
  }
}
