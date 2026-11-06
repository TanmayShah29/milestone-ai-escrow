import { json, toHttp } from "@/lib/http";
import { createMandate, publicMandate } from "@/lib/mandates/mandate";
import { withIdempotency } from "@/lib/platform/idempotency";
import { HOUR, hit, ipKey, tooMany, waitText } from "@/lib/ratelimit";

export const runtime = "nodejs";

// POST /api/mandates { name, maxPerBounty, total, maxOpenBounties, allowedRepos, days }: a draft spending
// mandate. Returns the owner's management link token once; nothing is funded until the owner saves a card
// and signs the limits with a passkey (POST /api/mandates/:id/:action).
export async function POST(req: Request) {
  return withIdempotency(req, "mandate:create", async () => {
    try {
      const v = await hit([{ key: ipKey(req, "mandate"), limit: 5, windowMs: HOUR }]);
      if (!v.ok) return tooMany(`You've started 5 mandates this hour. Try again in ${waitText(v.retryAfterMs)}.`, v.retryAfterMs);
      const { mandate, ownerToken } = await createMandate((await req.json().catch(() => ({}))) as Record<string, unknown>);
      return json(201, { mandate: await publicMandate(mandate), ownerToken });
    } catch (err) {
      return toHttp(err);
    }
  });
}
