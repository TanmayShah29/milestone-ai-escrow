import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Render health check: the app is up and can reach Postgres.
export async function GET() {
  try {
    await db().query("select 1");
    return json(200, { ok: true });
  } catch {
    return json(503, { ok: false });
  }
}
