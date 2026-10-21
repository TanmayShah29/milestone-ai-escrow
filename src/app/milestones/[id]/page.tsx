"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { linkFor, rememberLink } from "@/lib/client/links";

type Milestone = Record<string, unknown> & { id: string; title: string; state: string; amount_cents: number };
type AuditRow = { id: number; actor: string; event: string; from_state: string | null; to_state: string | null; paypal_id: string | null; created_at: string };
type ActionRow = { action: string; attempt: number; status: string; paypal_id: string | null };

type Role = "client" | "worker";
const C: Role[] = ["client"];
const W: Role[] = ["worker"];
const ANY: Role[] = ["client", "worker"];
const ACTIONS: Record<string, { label: string; action: string; roles: Role[] }[]> = {
  DRAFT: [{ label: "Accept the milestone", action: "agree", roles: W }, { label: "Cancel", action: "cancel", roles: C }],
  AGREED: [{ label: "Fund with PayPal hold", action: "fund", roles: C }, { label: "Cancel", action: "cancel", roles: C }],
  FUNDED: [{ label: "Submit PR", action: "submit", roles: W }, { label: "Cancel (void hold)", action: "cancel", roles: C }, { label: "Reauthorize hold", action: "refresh-hold", roles: C }],
  SUBMITTED: [{ label: "Dev: mark review passed", action: "dev-pass", roles: C }],
  PASSED: [{ label: "Release (capture + payout)", action: "release", roles: C }],
  RELEASED: [{ label: "Sync with PayPal", action: "sync", roles: ANY }],
};

const cents = (v: unknown) => (typeof v === "number" ? `$${(v / 100).toFixed(2)}` : "—");

export default function MilestonePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<{ milestone: Milestone; audit: AuditRow[]; actions: ActionRow[] }>();
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [as, setAs] = useState<Role>();
  const [tokens, setTokens] = useState<{ client?: string; worker?: string }>({});
  const token = as ? tokens[as] : undefined;

  // A shared link arrives as ?t=<token>: remember it, then drop it from the address bar.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("t");
    if (t) {
      rememberLink({ id, title: "", ...(t.startsWith("mwt_") ? { worker: t } : { client: t }) });
      q.delete("t");
      window.history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}`);
    }
    const held = linkFor(id);
    setTokens({ client: held?.client, worker: held?.worker });
    setAs(held?.client ? "client" : held?.worker ? "worker" : undefined);
    const err = q.get("error");
    if (err) setMsg(err);
    else if (q.get("funded") === "pending") setMsg("PayPal is finishing the hold. Refresh in a moment.");
  }, [id]);

  const authed = useCallback((init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), "x-milestone-token": token ?? "" } }), [token]);
  const load = useCallback(() => {
    if (!token) return;
    fetch(`/api/milestones/${id}`, authed())
      .then((r) => r.json())
      .then((b) => {
        if (b.error) setMsg(b.error);
        else {
          setData(b);
          rememberLink({ id, title: b.milestone.title });
        }
      });
  }, [id, token, authed]);
  useEffect(() => {
    load();
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
    const r = await fetch(`/api/milestones/${id}/${action}`, authed({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const b = await r.json();
    setBusy(false);
    if (action === "fund" && r.ok && b.approveUrl) {
      window.location.href = b.approveUrl;
      return;
    }
    if (!r.ok || r.status === 202) setMsg(b.error);
    load();
  }

  if (!as) return <main className="p-8">You need this milestone&apos;s client or worker link to open it.</main>;
  if (!data?.milestone) return <main className="p-8">{msg ?? "Loading…"}</main>;
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

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="opacity-60">Viewing as</span>
        {(["client", "worker"] as const).map((r) => (
          <button key={r} disabled={!tokens[r]} onClick={() => setAs(r)} className={`rounded px-2 py-0.5 border ${as === r ? "border-blue-600 bg-blue-600/10" : "border-black/15 dark:border-white/20"} disabled:opacity-30`}>
            {r}
          </button>
        ))}
      </div>
      {as === "client" && tokens.worker && (
        <p className="text-sm break-all">
          <span className="opacity-60">Worker link (share with the freelancer or agent): </span>
          <code>{`${typeof window !== "undefined" ? window.location.origin : ""}/milestones/${id}?t=${tokens.worker}`}</code>
        </p>
      )}

      {msg && <p className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-sm">{msg}</p>}

      <div className="flex flex-wrap gap-2">
        {(ACTIONS[m.state] ?? []).filter((a) => a.roles.includes(as)).map((a) => (
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
