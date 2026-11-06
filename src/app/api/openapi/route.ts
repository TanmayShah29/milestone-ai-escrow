import { json } from "@/lib/http";
import { openapi } from "@/lib/platform/openapi";

export const runtime = "nodejs";

// GET /api/openapi: the OpenAPI 3.1 description of the public API (src/lib/platform/openapi.ts).
export function GET() {
  return json(200, openapi);
}
