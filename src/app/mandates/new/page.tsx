"use client";

import { browserSupportsWebAuthn, startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

// Set up a spending mandate (V2_PLAN §3.H): the limits an AI agent may post bounties within, a saved card
// (PayPal's sandbox test card here), and a passkey signature over exactly those limits. Fixed code funds
// each bounty's hold within them; the agent can't capture, release or refund anything.

const field = "mt-1 w-full rounded-md border border-rule-strong bg-panel px-3 py-2 text-ink placeholder:text-ink-3";
const primary = "inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink hover:opacity-90 disabled:opacity-50";

type Pub = { id: string; status: string; card: { last4: string | null } | null; document: { maxPerBountyCents: number; totalCents: number; maxOpenBounties: number; allowedRepos: string[]; expiresAt: string } | null };

export default function NewMandate() {
  // Prefilled so a judge (or a demo) can create a mandate in one click; every field stays editable.
  const [f, setF] = useState({ name: "Acme procurement agent", maxPerBounty: "50.00", total: "150.00", maxOpenBounties: "3", allowedRepos: "TanmayShah29/milestone-demo", days: "14" });
  const [owner, setOwner] = useState<string>();
  const [mandate, setMandate] = useState<Pub>();
  const [agentToken, setAgentToken] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const post = async (path: string, body: unknown = {}, token = owner) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-mandate-token": token } : {}) }, body: JSON.stringify(body) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
    return b;
  };
  const run = async (label: string, fn: () => Promise<void>) => {
    setError(undefined);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).name === "NotAllowedError" ? "The passkey prompt was closed. Try again." : (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    run("Creating the mandate…", async () => {
      const b = await post("/api/mandates", { ...f, maxOpenBounties: Number(f.maxOpenBounties), days: Number(f.days), allowedRepos: f.allowedRepos.split(/[\s,]+/).filter(Boolean) });
      setOwner(b.ownerToken);
      setMandate(b.mandate);
    });
  };
  const vault = () => run("Saving the sandbox test card at PayPal…", async () => setMandate((await post(`/api/mandates/${mandate!.id}/vault-card`)).mandate));
  const sign = () =>
    run("Waiting for your passkey…", async () => {
      let o = await post(`/api/mandates/${mandate!.id}/passkey-options`);
      if (o.mode === "register") {
        const created = await startRegistration({ optionsJSON: o.options as PublicKeyCredentialCreationOptionsJSON });
        await post(`/api/mandates/${mandate!.id}/passkey-register`, { response: created });
        o = await post(`/api/mandates/${mandate!.id}/passkey-options`);
      }
      const signed = await startAuthentication({ optionsJSON: o.options as PublicKeyCredentialRequestOptionsJSON });
      const b = await post(`/api/mandates/${mandate!.id}/sign`, { response: signed });
      setMandate(b.mandate);
      setAgentToken(b.agentToken);
    });

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Give an AI agent a budget</h1>
        <p className="mt-2 text-sm text-ink-2">
          Your agent can post bounties for code work, and Milestone holds the money for each one on PayPal. It&apos;s paid out only when the work is proven. Fixed code checks every
          bounty against the limits you sign here. The agent can never capture, release or refund money. Sandbox only: the card is PayPal&apos;s published test card.
        </p>
      </div>
      {error && <p className="rounded-md border border-failed bg-failed-field px-3 py-2 text-sm text-failed">{error}</p>}

      {!mandate && (
        <form onSubmit={create} className="space-y-4 rounded-lg border border-rule bg-panel p-5">
          <label className="block text-sm text-ink">
            Agent name
            <input required className={field} value={f.name} onChange={set("name")} placeholder="Acme procurement agent" />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-sm text-ink">
              Most per bounty (USD)
              <input required className={field} value={f.maxPerBounty} onChange={set("maxPerBounty")} inputMode="decimal" />
            </label>
            <label className="block text-sm text-ink">
              Total budget (USD)
              <input required className={field} value={f.total} onChange={set("total")} inputMode="decimal" />
            </label>
            <label className="block text-sm text-ink">
              Open bounties at once
              <input required className={field} value={f.maxOpenBounties} onChange={set("maxOpenBounties")} inputMode="numeric" />
            </label>
            <label className="block text-sm text-ink">
              Lasts (days, at most 28)
              <input required className={field} value={f.days} onChange={set("days")} inputMode="numeric" />
            </label>
          </div>
          <label className="block text-sm text-ink">
            Repositories it may post in (owner/name, comma separated)
            <input required className={field} value={f.allowedRepos} onChange={set("allowedRepos")} placeholder="TanmayShah29/milestone-demo" />
          </label>
          <button className={primary} disabled={!!busy}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Create the mandate
          </button>
        </form>
      )}

      {mandate && !agentToken && (
        <section className="space-y-4 rounded-lg border border-rule bg-panel p-5 text-sm text-ink-2">
          <p>
            <span className="font-medium text-ink">1. Save a card.</span>{" "}
            {mandate.card ? `Saved: test card ending ${mandate.card.last4 ?? "····"}.` : "PayPal keeps it in its vault. This server only ever holds a token for it."}
          </p>
          {!mandate.card && (
            <button className={primary} onClick={vault} disabled={!!busy}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Save the sandbox test card
            </button>
          )}
          <p>
            <span className="font-medium text-ink">2. Sign the limits with a passkey.</span> Your signature covers exactly these limits and this card. Anyone can check it
            later at <span className="font-mono">/api/mandates/{mandate.id}</span>.
          </p>
          {mandate.card && (
            <button className={primary} onClick={sign} disabled={!!busy || !browserSupportsWebAuthn()}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Sign with a passkey
            </button>
          )}
        </section>
      )}

      {agentToken && mandate?.document && (
        <section className="space-y-3 rounded-lg border border-rule bg-panel p-5 text-sm text-ink-2">
          <h2 className="text-base font-semibold text-ink">Signed. Give your agent this key</h2>
          <p>It is shown once. With it, the agent gets one extra MCP tool, post_bounty, inside these limits:</p>
          <ul className="list-disc pl-5">
            <li>
              up to ${(mandate.document.maxPerBountyCents / 100).toFixed(2)} per bounty, ${(mandate.document.totalCents / 100).toFixed(2)} in total, {mandate.document.maxOpenBounties} open at once;
            </li>
            <li>in {mandate.document.allowedRepos.join(", ")}, until {new Date(mandate.document.expiresAt).toLocaleDateString()}.</li>
          </ul>
          <input readOnly value={agentToken} aria-label="Agent key" onFocus={(e) => e.currentTarget.select()} className="w-full rounded-md border border-rule-strong bg-paper px-3 py-2 font-mono text-xs text-ink" />
          <pre className="overflow-x-auto rounded-md border border-rule bg-paper p-3 font-mono text-xs text-ink">{`claude mcp add milestone -e MILESTONE_MANDATE_KEY=${agentToken} -- npx tsx mcp/server.mts`}</pre>
          <p>
            Its bounties appear on <Link href="/bounties">the bounty board</Link>. Keep this page&apos;s owner link if you might want to revoke the mandate.
          </p>
        </section>
      )}
    </main>
  );
}
