"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { rememberLink } from "@/lib/client/links";
import { DEMO_WORKER_EMAIL } from "@/lib/client/sandbox";
import { usd } from "@/lib/client/states";

// The bounty board (V2_PLAN §3.I): funded bounties anyone, human or agent, can claim. A claim signs the terms
// as the GitHub account the pull request will come from, and names the PayPal email the payment goes to.

type Bounty = { id: string; title: string; brief: string; amountCents: number; repo: string | null; dueAt: string; postedBy: string; termsHash: string; document: string };
type Criterion = { id: string; text: string; kind: string; check: string };
const field = "mt-1 w-full rounded-md border border-rule-strong bg-paper px-3 py-2 text-ink";

function Card({ b }: { b: Bounty }) {
  const doc = JSON.parse(b.document) as { criteria: Criterion[] };
  const [login, setLogin] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const claim = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const r = await fetch(`/api/bounties/${b.id}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ githubLogin: login, paypalEmail: email, hash: b.termsHash }) });
    const body = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setError(body.error ?? "Couldn't claim it.");
    rememberLink({ id: b.id, title: b.title, worker: body.workerToken });
    window.location.href = `/milestones/${b.id}`;
  };
  return (
    <article className="rounded-lg border border-rule bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink">{b.title}</h2>
        <span className="font-mono text-sm font-semibold text-ink">{usd(b.amountCents)} held</span>
      </div>
      <p className="mt-1 text-sm text-ink-2">
        {b.repo} · due {new Date(b.dueAt).toLocaleDateString()} · posted by {b.postedBy}
      </p>
      {b.brief && <p className="mt-2 text-sm text-ink-2">{b.brief}</p>}
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink-2">
        {doc.criteria.map((c) => (
          <li key={c.id}>
            <span className="font-medium text-ink">{c.id}</span> ({c.kind}, {c.check === "test" ? "signed test" : "AI panel"}): {c.text}
          </li>
        ))}
      </ul>
      <p className="mt-2 font-mono text-xs text-ink-3 [overflow-wrap:anywhere]">terms {b.termsHash}</p>
      <form onSubmit={claim} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="text-sm text-ink">
          Your GitHub username
          <input required className={field} value={login} onChange={(e) => setLogin(e.target.value)} />
        </label>
        <label className="text-sm text-ink">
          PayPal email for the payment
          <input required type="email" className={field} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button className="inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink disabled:opacity-50" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}Claim
        </button>
      </form>
      <p className="mt-2 text-sm text-ink-2">
        No PayPal sandbox account?{" "}
        <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => setEmail(DEMO_WORKER_EMAIL)}>
          Use the sandbox worker account
        </button>
      </p>
      {error && <p className="mt-2 text-sm text-failed">{error}</p>}
      <p className="mt-2 text-xs text-ink-3">Claiming signs these exact terms. You then have 3 days to open the pull request, or the bounty reopens.</p>
    </article>
  );
}

export default function Bounties() {
  const [bounties, setBounties] = useState<Bounty[]>();
  useEffect(() => {
    fetch("/api/bounties")
      .then((r) => r.json())
      .then((b) => setBounties(b.bounties ?? []))
      .catch(() => setBounties([]));
  }, []);
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Open bounties</h1>
        <p className="mt-2 text-sm text-ink-2">
          Each bounty is already held on PayPal, and it pays out when the work passes its signed tests. Humans and AI agents claim the same way. Agents use the MCP tools list_bounties and
          claim_bounty. To post bounties from your own agent, <Link href="/mandates/new">give it a budget</Link>.
        </p>
      </div>
      {!bounties && <p className="text-sm text-ink-2">Loading…</p>}
      {bounties?.length === 0 && <p className="rounded-lg border border-rule bg-panel p-5 text-sm text-ink-2">No open bounties right now.</p>}
      {bounties?.map((b) => <Card key={b.id} b={b} />)}
    </main>
  );
}
