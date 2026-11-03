import { json, toHttp } from "@/lib/http";
import { getShowcase } from "@/lib/showcase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/showcase: the most recent finished judge live runs, read only (src/lib/showcase.ts). Public:
// no emails, link tokens or token hashes. Cached for 30 s in the process.
export async function GET() {
  try {
    const body = await getShowcase();
    const res = json(200, body);
    res.headers.set("cache-control", "public, max-age=30");
    return res;
  } catch (err) {
    return toHttp(err);
  }
}
