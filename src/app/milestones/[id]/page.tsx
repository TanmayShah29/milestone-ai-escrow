"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";

type Milestone = Record<string, unknown> & { id: string; title: string; state: string; amount_cents: number };
type AuditRow = { id: number; actor: string; event: string; from_state: string | null; to_state: string | null; paypal_id: string | null; created_at: string };
type ActionRow = { action: string; attempt: number; status: string; paypal_id: string | null };

const ACTIONS: Record<string, { label: string; action: string }[]> = {
  DRAFT: [{ label: "Freelancer accepts", action: "agree" }, { label: "Cancel", action: "cancel" }],
  AGREED: [{ label: "Fund with PayPal hold", action: "fund" }, { label: "Cancel", action: "cancel" }],
  FUNDED: [{ label: "Submit PR", action: "submit" }, { label: "Cancel (void hold)", action: "cancel" }, { label: "Reauthorize hold", action: "refresh-hold" }],
  SUBMITTED: [{ label: "Dev: mark review passed", action: "dev-pass" }],
  PASSED: [{ label: "Release (capture + payout)", action: "release" }],
  RELEASED: [{ label: "Sync with PayPal", action: "sync" }],
};

const cents = (v: unknown) => (typeof v === "number" ? `$${(v / 100).toFixed(2)}` : "—");

export default function MilestonePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<{ milestone: Milestone; audit: AuditRow[]; actions: ActionRow[] }>();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => fetch(`/api/milestones/${id}`).then((r) => r.json()).then(setData), [id]);
  useEffect(() => {
    load();
    const err = new URLSearchParams(window.location.search).get("error");
    if (err) setMsg(err);
  }, [load]);

  async function run(action: string) {
    setBusy(true);
    setMsg(undefined);
    const body: Record<string, string> = {};
    if (action === "submit") {
      const prUrl = window.prompt("GitHub PR URL", "https://github.com/TanmayShah29/milestone-ai-escrow/pull/1");
      if (!prUrl) return setBusy(false);
      body.prUrl = prUrl;
    }
    const r = await fetch(`/api/milestones/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const b = await r.json();
    setBusy(false);
    if (action === "fund" && r.ok && b.approveUrl) {
      window.location.href = b.approveUrl;
      return;
    }
    if (!r.ok || r.status === 202) setMsg(b.error);
    load();
  }

  if (!data?.milestone) return <main className="p-8">Loading…</main>;
  const m = data.milestone;

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-8 space-y-6">
      <Link href="/" className="text-sm underline">
        ← All milestones
      </Link>
      <header>
        <h1 className="text-xl font-semibold">{m.title}</h1>
        <p className="text-sm opacity-70">
          {cents(m.amount_cents)} · <strong>{m.state}</strong>
        </p>
      </header>

      {msg && <p className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-sm">{msg}</p>}

      <div className="flex flex-wrap gap-2">
        {(ACTIONS[m.state] ?? []).map((a) => (
          <button key={a.action} disabled={busy} onClick={() => run(a.action)} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50">
            {a.label}
          </button>
        ))}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm break-all">
        {[
          ["Order", m.paypal_order_id],
          ["Authorization", m.paypal_authorization_id],
          ["Authorized", cents(m.authorized_cents)],
          ["Hold expires", m.authorization_expires_at],
          ["Capture", m.paypal_capture_id ? `${m.paypal_capture_id} (${m.capture_status})` : null],
          ["Captured", cents(m.captured_cents)],
          ["Fee / payout", m.fee_cents != null ? `${cents(m.fee_cents)} / ${cents(m.payout_cents)}` : null],
          ["Payout batch", m.paypal_payout_batch_id ? `${m.paypal_payout_batch_id} (${m.payout_status})` : null],
          ["PR", m.pr_url],
        ].map(([k, v]) => (
          <div key={String(k)} className="contents">
            <dt className="opacity-60">{String(k)}</dt>
            <dd>{v ? String(v) : "—"}</dd>
          </div>
        ))}
      </dl>

      <section>
        <h2 className="font-medium mb-1">Money actions</h2>
        <ul className="text-sm space-y-0.5">
          {data.actions.map((a, i) => (
            <li key={i}>
              {a.action} #{a.attempt}: {a.status} {a.paypal_id && <span className="opacity-60">({a.paypal_id})</span>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="font-medium mb-1">Audit log</h2>
        <ol className="text-sm space-y-0.5">
          {data.audit.map((a) => (
            <li key={a.id}>
              <span className="opacity-60">{new Date(a.created_at).toLocaleTimeString()}</span> {a.actor}: {a.event}
              {a.to_state && ` → ${a.to_state}`} {a.paypal_id && <span className="opacity-60">({a.paypal_id})</span>}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
