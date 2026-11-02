"use client";

import { Check, CircleSlash, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rememberLink } from "@/lib/client/links";
import type { LiveKind, LiveProgress, LiveStep } from "@/lib/demo-live";

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

function StepIcon({ state }: { state: LiveStep["state"] }) {
  const base = "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border";
  if (state === "done") return <span className={`${base} border-paid bg-paid text-paper`}><Check className="size-3.5" aria-hidden="true" /></span>;
  if (state === "active") return <span className={`${base} border-ink text-ink`}><Loader2 className="size-3.5 animate-spin" aria-hidden="true" /></span>;
  if (state === "failed") return <span className={`${base} border-failed bg-failed text-paper`}><X className="size-3.5" aria-hidden="true" /></span>;
  if (state === "skipped") return <span className={`${base} border-held text-held`}><CircleSlash className="size-3.5" aria-hidden="true" /></span>;
  return <span className={`${base} border-rule-strong`} />;
}

const STATE_WORD: Record<LiveStep["state"], string> = { done: "Done", active: "In progress", failed: "Stopped", skipped: "Skipped", todo: "Not started" };

function Banner({ p }: { p: LiveProgress }) {
  const amount = `$${(p.amountCents / 100).toFixed(2)}`;
  if (p.status === "running") return null;
  if (p.status === "failed") return <p role="alert" className="mt-5 rounded-md border border-failed/40 bg-failed-field p-3 text-ink">{p.error ?? "This run stopped."} Try again in a moment, or use the replay below.</p>;
  if (p.outcome === "paid") return <p role="status" className="mt-5 rounded-md border border-paid/40 bg-paid-field p-3 text-ink"><span className="font-semibold">Paid.</span> The signed tests passed, so code captured the hold and PayPal paid the worker. No person and no AI decided this.</p>;
  if (p.outcome === "caught") return <p role="status" className="mt-5 rounded-md border border-held/40 bg-held-field p-3 text-ink"><span className="font-semibold">Caught.</span> The tests failed and the text aimed at the AI reviewer was flagged. {amount} stays on hold at PayPal, and the worker got nothing.</p>;
  return <p role="status" className="mt-5 rounded-md border border-held/40 bg-held-field p-3 text-ink"><span className="font-semibold">Held for a person.</span> The rules wouldn&apos;t pay this automatically, so {amount} stays on hold until the client decides.</p>;
}

export function LiveRun() {
  const [busy, setBusy] = useState<LiveKind>();
  const [progress, setProgress] = useState<LiveProgress>();
  const [dealId, setDealId] = useState<string>();
  const [error, setError] = useState<string>();
  const live = useRef(true);
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
      <h2 id="live-heading" className="text-xl font-semibold tracking-tight">Run it live</h2>
      <p className="mt-2 text-ink-2">Pick a worker. One click places a real PayPal sandbox hold, opens a real GitHub pull request and runs real CI. It takes about 3 minutes, with no login.</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <button onClick={() => start("honest")} disabled={!!busy} className="rounded-md bg-accent px-4 py-3 text-left text-accent-ink hover:opacity-90 disabled:opacity-60">
          <span className="block font-semibold">Honest worker</span>
          <span className="block text-sm opacity-90">The work is right, so PayPal pays.</span>
        </button>
        <button onClick={() => start("cheat")} disabled={!!busy} className="rounded-md border border-rule-strong bg-panel px-4 py-3 text-left text-ink hover:border-ink disabled:opacity-60">
          <span className="block font-semibold">Cheating worker</span>
          <span className="block text-sm text-ink-2">Fake code that tells the AI reviewer to pass it.</span>
        </button>
      </div>
      {busy && !progress && (
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-ink-3">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Signing the terms. If the server was asleep, this can take up to a minute.
        </p>
      )}
      {error && <p role="alert" className="mt-4 rounded-md border border-failed/40 bg-failed-field p-3 text-sm text-ink">{error}</p>}
      {progress && (
        <div className="mt-6 rounded-md border border-rule bg-panel p-4 sm:p-5">
          <ol className="space-y-4">
            {progress.steps.map((s) => (
              <li key={s.key} className="flex gap-3">
                <StepIcon state={s.state} />
                <div className="min-w-0">
                  <p className={s.state === "todo" ? "text-ink-3" : "font-medium text-ink"}>
                    {s.label} <span className="sr-only">({STATE_WORD[s.state]})</span>
                  </p>
                  {s.detail && <p className="mt-0.5 break-words text-sm text-ink-2">{s.detail}</p>}
                  {s.until && s.state === "active" && <p className="mt-0.5 text-sm"><Countdown until={s.until} /></p>}
                  {s.id && <p className="mt-0.5 break-all font-mono text-xs text-ink-3">{s.id}</p>}
                  {!!s.links?.length && (
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                      {s.links.map((l) => <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="underline underline-offset-2">{l.label}</a>)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <Banner p={progress} />
          {dealId && progress.status !== "running" && (
            <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <a href={`/milestones/${dealId}`} className="font-medium underline underline-offset-2">Open this deal</a>
              <a href="/ledger" className="underline underline-offset-2">See every PayPal call in the ledger</a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
