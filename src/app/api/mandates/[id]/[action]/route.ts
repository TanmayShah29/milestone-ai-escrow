import { siteFor } from "@/lib/contract/signatures";
import { json, toHttp } from "@/lib/http";
import { mandateForOwner, mandatePasskeyOptions, mandatePasskeyRegister, publicMandate, revokeMandate, signMandate } from "@/lib/mandates/mandate";
import { vaultCard } from "@/lib/mandates/vault";
import { defaultDeps } from "@/lib/money/flow";

export const runtime = "nodejs";

const ownerToken = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.headers.get("x-mandate-token") || undefined;

// POST /api/mandates/:id/:action with the owner's link token: vault-card (sandbox test card), passkey-options,
// passkey-register, sign (returns the agent's mmd_ token once), revoke.
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  try {
    const { id, action } = await ctx.params;
    const m = await mandateForOwner(id, ownerToken(req));
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    switch (action) {
      case "vault-card":
        await vaultCard(m.id, defaultDeps());
        return json(200, { mandate: await publicMandate(await mandateForOwner(id, ownerToken(req))) });
      case "passkey-options":
        return json(200, await mandatePasskeyOptions(m, siteFor(req)));
      case "passkey-register":
        await mandatePasskeyRegister(m, siteFor(req), body.response as Parameters<typeof mandatePasskeyRegister>[2]);
        return json(200, { registered: true });
      case "sign": {
        const { mandate, agentToken } = await signMandate(m, siteFor(req), body.response as Parameters<typeof signMandate>[2]);
        return json(200, { mandate: await publicMandate(mandate), agentToken });
      }
      case "revoke":
        return json(200, { mandate: await publicMandate(await revokeMandate(m)) });
      default:
        return json(404, { error: `unknown action ${action}` });
    }
  } catch (err) {
    return toHttp(err);
  }
}
