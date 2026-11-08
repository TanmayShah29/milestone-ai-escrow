"use client";

import { Check, CircleSlash, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rememberLink } from "@/lib/client/links";
import type { LiveKind, LiveProgress, LiveStep, MoneyAt } from "@/lib/demo-live";

const POLL_MS = 3_000;

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));
  return <span className="font-semibold text-held">{s > 0 ? `${s}s left` : "Closing…"}</span>;
}

/** Seconds since a step became active, so a long wait (GitHub starting a runner) visibly moves. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono text-xs text-ink-3">{Math.max(0, Math.floor((now - since) / 1000))}s</span>;
}

function StepIcon({ state }: { state: LiveStep["state"] }) {
  const base = "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border";
  if (state === "done") return <span className={`${base} border-paid bg-paid text-paper`}><Check className="size-3.5" aria-hidden="true" /></span>;
  if (state === "active") return <span className={`${base} border-ink text-ink`}><Loader2 className="size-3.5 animate-spin" aria-hidden="true" /></span>;
  if (state === "failed") return <span className={`${base} border-failed bg-failed text-paper`}><X className="size-3.5" aria-hidden="true" /></span>;
  if (state === "skipped") return <span className={`${base} border-held text-held`}><CircleSlash className="size-3.5" aria-hidden="true" /></span>;
  return <span className={`${base} border-rule-strong`} />;
}

const STATIONS: { at: MoneyAt; label: string; note: string }[] = [
  { at: "client", label: "Client's card", note: "Not charged" },
  { at: "hold", label: "PayPal hold", note: "Authorized, not captured" },
  { at: "worker", label: "Worker's PayPal", note: "Paid out" },
];

// Which real id stamps onto which station, as each one arrives from PayPal or GitHub.
const STAMPS: { key: string; at: MoneyAt; label: string }[] = [
  { key: "terms", at: "client", label: "Terms fingerprint" },
  { key: "hold", at: "hold", label: "PayPal authorization" },
  { key: "capture", at: "worker", label: "PayPal capture" },
  { key: "payout", at: "worker", label: "PayPal payout item" },
];

/** Where the money is right now, with the real ids stamped where they happened. It only moves right when
 * code captures, and only after the tests pass. Before a run, it waits on the client's card. */
function MoneyRail({ p, idleCents }: { p?: LiveProgress; idleCents: number }) {
  // Once PayPal returns the capture, the money has left the hold, even if the server's moneyAt hasn't caught up.
  const at: MoneyAt = p?.steps.some((s) => s.key === "capture" && s.id) ? "worker" : (p?.moneyAt ?? "client");
  const i = STATIONS.findIndex((s) => s.at === at);
  const stuck = !!p && p.status === "done" && p.outcome !== "paid"; // caught: it stays on hold, the worker gets nothing
  const cents = at === "worker" && p?.payoutCents != null ? p.payoutCents : (p?.amountCents ?? idleCents); // the worker gets the payout, not the hold
  const amount = `$${(cents / 100).toFixed(2)}`;
  const ids = (st: MoneyAt) =>
    STAMPS.filter((x) => x.at === st).flatMap((x) => {
      const step = p?.steps.find((s) => s.key === x.key);
      return step?.id ? [{ ...x, id: step.id }] : [];
    });
  return (
    <div className={`rounded-xl border border-rule-strong bg-panel p-4 shadow-[var(--shadow-card)] sm:p-6 ${p ? "sticky top-16 z-10" : ""}`} aria-label={`The ${amount} is now at: ${STATIONS[i]!.label}`} role="img">
      <div className="overflow-hidden px-1 pt-3">
        <div className="relative mx-[16.66%] h-10">
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-rule-strong" />
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 origin-left bg-paid transition-transform duration-[var(--t-travel)] ease-[var(--ease-out)]" style={{ transform: `scaleX(${i / 2})` }} />
          {[0, 1, 2].map((k) => (
            <span key={k} className={`absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border transition-colors duration-[var(--t-state)] ${k <= i ? "border-paid bg-paid" : "border-rule-strong bg-panel"}`} style={{ left: `${k * 50}%` }} />
          ))}
          <div className="absolute inset-0 transition-transform duration-[var(--t-travel)] ease-[var(--ease-out)]" style={{ transform: `translateX(${i * 50}%)` }}>
            <span
              className={`money absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-3.5 py-1.5 font-mono text-base font-semibold shadow-sm transition-colors duration-[var(--t-state)] ${
                at === "worker" ? "border-paid bg-paid text-panel" : stuck || at === "hold" ? "border-held bg-held-field text-held" : "border-ink bg-panel text-ink"
              }`}
            >
              {amount}
            </span>
          </div>
        </div>
      </div>
      <ol className="mt-4 grid grid-cols-3 gap-2 text-center text-xs sm:gap-4 sm:text-sm">
        {STATIONS.map((s, k) => (
          <li key={s.at} className="min-w-0">
            <p className={k === i ? "font-semibold text-ink" : "text-ink-3"}>{s.label}</p>
            <p className={`text-xs ${k === i ? (stuck && k === 1 ? "text-held" : "text-ink-2") : "text-ink-3"}`}>
              {k === i ? (stuck ? "Held: worker not paid" : p ? s.note : "Pick a worker to start") : " "}
            </p>
            <div className="mt-2 flex flex-col items-center gap-1.5">
              {ids(s.at).map((x) => (
                <p key={x.key} className="detail-in max-w-full rounded-md border border-ink/40 bg-paper px-2 py-1 -rotate-2">
                  <span className="block text-[10px] text-ink-3">{x.label}</span>
                  <span className="block break-all font-mono text-[11px] text-ink">{x.id}</span>
                </p>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const STATE_WORD: Record<LiveStep["state"], string> = { done: "Done", active: "In progress", failed: "Stopped", skipped: "Skipped", todo: "Not started" };

function Banner({ p }: { p: LiveProgress }) {
  const amount = `$${(p.amountCents / 100).toFixed(2)}`;
  if (p.status === "running") return null;
  if (p.status === "failed") return <p role="alert" className="mt-5 rounded-md border border-failed/40 bg-failed-field p-3 text-ink">{p.error ?? "This run stopped."} Try again in a moment, or use the replay below.</p>;
  if (p.outcome === "paid") return <p role="status" className="mt-5 rounded-md border border-paid/40 bg-paid-field p-3 text-ink"><span className="font-semibold">Paid.</span> The signed tests passed, so code captured the hold and PayPal paid the worker. No person decided this, and the AI reviewer couldn&apos;t have: only the tests gate the money.</p>;
  if (p.outcome === "caught") return <p role="status" className="mt-5 rounded-md border border-held/40 bg-held-field p-3 text-ink"><span className="font-semibold">Caught.</span> The signed tests failed, and the line telling the AI reviewer to pass everything was flagged instead of obeyed. {amount} stays on hold at PayPal, and the worker got nothing.</p>;
  return <p role="status" className="mt-5 rounded-md border border-held/40 bg-held-field p-3 text-ink"><span className="font-semibold">Held for a person.</span> The rules wouldn&apos;t pay this automatically, so {amount} stays on hold until the client decides.</p>;
}

export function LiveRun() {
  const [busy, setBusy] = useState<LiveKind>();
  const [progress, setProgress] = useState<LiveProgress>();
  const [dealId, setDealId] = useState<string>();
  const [error, setError] = useState<string>();
  const live = useRef(true);
  const activeSince = useRef<Record<string, number>>({});
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function poll(id: string) {
    let misses = 0;
    while (live.current) {
      const r = await fetch(`/api/demo/live/${id}`, { method: "POST" }).catch(() => undefined);
      const b = r?.ok ? ((await r.json().catch(() => undefined)) as LiveProgress | undefined) : undefined;
      if (b) {
        misses = 0;
        setProgress(b);
        if (b.status !== "running") break;
      } else if (++misses >= 10) {
        setError("The demo server stopped answering. The run may still finish; reload to start another.");
        break;
      }
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
    setBusy(undefined);
  }

  async function start(kind: LiveKind) {
    setBusy(kind);
    setError(undefined);
    setProgress(undefined);
    setDealId(undefined);
    activeSince.current = {};
    const r = await fetch("/api/demo/live", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) }).catch(() => undefined);
    const b = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) {
      setBusy(undefined);
      return setError(b.error ?? "The demo server didn't answer. It may be waking up; try again in a moment.");
    }
    rememberLink({ id: b.milestoneId, title: b.title, client: b.client, worker: b.worker });
    setDealId(b.milestoneId);
    void poll(b.runId);
  }

  return (
    <section aria-labelledby="live-heading">
      <h2 id="live-heading" className="sr-only">Run it live</h2>
      <MoneyRail p={progress} idleCents={1200} />
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {/* Both look the same until one is picked; then only the chosen worker is marked. */}
        {(
          [
            { kind: "honest", title: "Honest worker", text: "The work is right, so PayPal pays." },
            { kind: "cheat", title: "Cheating worker", text: "Fake code that tells the AI reviewer to pass it." },
          ] as const
        ).map((c) => {
          const chosen = (busy ?? progress?.kind) === c.kind;
          const other = !chosen && !!(busy ?? progress?.kind);
          return (
            <button
              key={c.kind}
              type="button"
              onClick={() => start(c.kind)}
              disabled={!!busy}
              aria-pressed={chosen}
              className={`relative rounded-md border px-4 py-3 text-left transition-colors duration-[var(--t-tap)] ${
                chosen ? "border-ink bg-ink text-panel" : other ? "border-rule bg-panel text-ink-3" : "border-rule-strong bg-panel text-ink hover:border-ink"
              } disabled:cursor-not-allowed`}
            >
              <span className="flex items-center gap-2 font-semibold">
                {chosen && <Check className="size-4" aria-hidden="true" />}
                {c.title}
                {chosen && <span className="ml-auto text-xs font-medium opacity-80">{busy ? "Running" : "Your pick"}</span>}
              </span>
              <span className={`block text-sm ${chosen ? "opacity-85" : other ? "" : "text-ink-2"}`}>{c.text}</span>
            </button>
          );
        })}
      </div>
      {busy && !progress && (
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-ink-3">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Signing the terms. If the server was asleep, this can take up to a minute.
        </p>
      )}
      {error && <p role="alert" className="mt-4 rounded-md border border-failed/40 bg-failed-field p-3 text-sm text-ink">{error}</p>}
      {progress && (
        <div className="mt-6 rounded-xl border border-rule bg-panel p-4 sm:p-6">
          <ol className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
            {progress.steps.map((s) => {
              if (s.state === "active") activeSince.current[s.key] ??= Date.now();
              return (
              <li key={s.key} className="flex gap-3">
                <StepIcon state={s.state} />
                <div className="min-w-0">
                  <p className={s.state === "todo" ? "text-ink-3" : "font-medium text-ink"}>
                    {s.label} <span className="sr-only">({STATE_WORD[s.state]})</span>
                  </p>
                  {s.detail && <p className="mt-0.5 break-words text-sm text-ink-2">{s.detail}</p>}
                  {s.until && s.state === "active" && <p className="mt-0.5 text-sm"><Countdown until={s.until} /></p>}
                  {!s.until && s.state === "active" && activeSince.current[s.key] && <p className="mt-0.5"><Elapsed since={activeSince.current[s.key]!} /></p>}
                  {s.id && <p className="mt-0.5 break-all font-mono text-xs text-ink-3">{s.id}</p>}
                  {!!s.links?.length && (
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                      {s.links.map((l) => <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="underline underline-offset-2">{l.label}</a>)}
                    </p>
                  )}
                </div>
              </li>
              );
            })}
          </ol>
          <Banner p={progress} />
          {dealId && progress.status !== "running" && (
            <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <a href={`/proof/${dealId}`} className="font-medium underline underline-offset-2">Verify the receipt yourself</a>
              <a href={`/milestones/${dealId}`} className="underline underline-offset-2">Open this deal</a>
              <a href="/ledger" className="underline underline-offset-2">See every PayPal call in the ledger</a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
