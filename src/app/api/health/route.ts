import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Render health check: the app is up and can reach Postgres.
export async function GET() {
  try {
    await db().query("select 1");
    // Which deploy is live, and for how long this process has been up: a drop shows a restart or a crash.
    return json(200, { ok: true, commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "local", upSeconds: Math.round(process.uptime()) });
  } catch {
    return json(503, { ok: false });
  }
}
