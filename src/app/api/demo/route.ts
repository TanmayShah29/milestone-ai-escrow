import { json, toHttp } from "@/lib/http";
import { demosLastHour, seedDemoProject } from "@/lib/demo";

export const runtime = "nodejs";

// POST /api/demo: seeds a fresh judge-mode project and returns its client and worker links.
// Braked per visitor (5/hour, in memory) and globally (30 projects/hour) to protect the free tier.
const perIp = new Map<string, number[]>();

export async function POST(req: Request) {
  try {
    const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0]!.trim();
    const hourAgo = Date.now() - 3_600_000;
    const recent = (perIp.get(ip) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= 5) return json(429, { error: "You've started five demos this hour. Reuse the one you have, or try again later." });
    if ((await demosLastHour()) >= 30) return json(429, { error: "The demo is busy right now. Try again in a few minutes." });
    perIp.set(ip, [...recent, Date.now()]);
    return json(201, { milestones: await seedDemoProject() });
  } catch (err) {
    return toHttp(err);
  }
}
