import { signaturesOf } from "@/lib/contract/signatures";
import { json, toHttp } from "@/lib/http";
import { getMilestone } from "@/lib/milestones/repo";
import { chainOf, repairChain } from "@/lib/proof/chain";
import { publishedKeys } from "@/lib/proof/keys";

export const runtime = "nodejs";

// GET /api/proof/<milestone id>: the milestone's signed proof chain and the public keys that signed it.
// Public, like the locked contract: bodies carry no personal data (the audit detail is a salted digest).
// Check it with src/lib/proof/verify.ts, the /proof/<id> page, or scripts/verify-proof.mts.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const m = await getMilestone(id);
    await repairChain(m.id); // signs any row written before the chain existed (marked backfilled); a no-op otherwise
    const events = await chainOf(m.id);
    const used = new Set(events.map((e) => e.keyId));
    const keys = (await publishedKeys()).filter((k) => used.has(k.id));
    // Key signatures on the terms (passkeys, agent keys), each checkable from the record alone.
    return json(200, { milestoneId: m.id, state: m.state, events, keys, signatures: await signaturesOf(m.id) });
  } catch (err) {
    return toHttp(err);
  }
}
