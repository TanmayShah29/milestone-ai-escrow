import { listBounties, postBounty } from "@/lib/bounties/bounty";
import { json, toHttp } from "@/lib/http";
import { mandateFromAgent } from "@/lib/mandates/mandate";
import { withIdempotency } from "@/lib/platform/idempotency";

export const runtime = "nodejs";

// GET /api/bounties: the open bounties anyone can claim, each with the terms they would sign.
export async function GET() {
  try {
    return json(200, { bounties: await listBounties() });
  } catch (err) {
    return toHttp(err);
  }
}

// POST /api/bounties (Authorization: Bearer mmd_…): an agent posts a bounty under its mandate. Fixed code
// checks the signed limits, then funds the hold from the mandate's saved card. Send an Idempotency-Key.
export async function POST(req: Request) {
  return withIdempotency(req, "bounty:post", async () => {
    try {
      const mandate = await mandateFromAgent(req.headers.get("authorization")?.replace(/^Bearer\s+/i, ""));
      if (!mandate) return json(401, { error: "Post a bounty with a mandate's agent key (Authorization: Bearer mmd_…)." });
      const m = await postBounty(mandate, (await req.json().catch(() => ({}))) as Record<string, unknown>);
      return json(201, { bounty: { id: m.id, state: m.state, amountCents: m.amount_cents, termsHash: m.criteria_hash, holdId: m.paypal_authorization_id } });
    } catch (err) {
      return toHttp(err);
    }
  });
}
