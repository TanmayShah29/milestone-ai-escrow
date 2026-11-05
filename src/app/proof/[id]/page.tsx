"use client";

import { Check, Download, RotateCcw, ShieldCheck, ShieldX, X } from "lucide-react";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { eventLabel, stateLabel } from "@/lib/client/states";
import { verifyChain, verifyTermSignature, type ChainCheck, type ProofEvent, type ProofKey, type TermSignature } from "@/lib/proof/verify";

// The proof chain, checked in this browser with WebCrypto: the server sends the events and its public
// keys, and src/lib/proof/verify.ts recomputes every hash, signature and link. "Tamper" flips one character
// of a copy, so a reader can watch the check catch it.

type Data = { milestoneId: string; state: string; events: ProofEvent[]; keys: (ProofKey & { source: string; createdAt: string })[]; signatures: TermSignature[] };

const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

function tamper(events: ProofEvent[], index: number): ProofEvent[] {
  return events.map((e, i) => {
    if (i !== index) return e;
    // Change one character inside the event name: the smallest edit that still parses.
    const at = e.body.indexOf('"event":"') + 9;
    const ch = e.body[at] === "x" ? "y" : "x";
    return { ...e, body: e.body.slice(0, at) + ch + e.body.slice(at + 1) };
  });
}

export default function ProofPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<ChainCheck | null>(null);
  const [tampered, setTampered] = useState<number | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [sigChecks, setSigChecks] = useState<{ ok: boolean; problems: string[] }[] | null>(null);

  useEffect(() => {
    fetch(`/api/proof/${id}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setData(body as Data);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const run = useCallback(
    async (index: number | null) => {
      if (!data) return;
      setCheck(null);
      const t = performance.now();
      const events = index === null ? data.events : tamper(data.events, index);
      setCheck(await verifyChain(data.milestoneId, events, data.keys));
      setMs(Math.round(performance.now() - t));
      setTampered(index);
    },
    [data],
  );

  useEffect(() => {
    void run(null);
  }, [run]);

  useEffect(() => {
    if (!data) return;
    // A signature counts only if the chain itself recorded that key signing those terms.
    const recorded = data.events.map((e) => JSON.parse(e.body) as { event: string; facts: Record<string, unknown> });
    void Promise.all(
      data.signatures.map(async (s) => {
        const c = await verifyTermSignature(s, data.milestoneId);
        const inChain = recorded.some((b) => b.event === `terms:signed:${s.role}` && b.facts.credentialId === s.credentialId && b.facts.hash === s.termsHash);
        return inChain ? c : { ok: false, problems: [...c.problems, "the proof chain doesn't record this key signing these terms"] };
      }),
    ).then(setSigChecks);
  }, [data]);

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `milestone-proof-${data.milestoneId}.json` });
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error)
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1 className="text-xl font-semibold">No proof chain here</h1>
        <p className="mt-2 text-ink-2">{error}</p>
      </main>
    );
  if (!data) return <main className="mx-auto max-w-4xl px-4 py-16 text-ink-2">Loading the proof chain…</main>;

  const ok = check?.ok === true;
  const byKey = new Map(data.keys.map((k) => [k.id, k]));
  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <p className="text-sm text-ink-2">
        <Link href={`/milestones/${data.milestoneId}`} className="underline">
          Milestone
        </Link>{" "}
        · {stateLabel(data.state)}
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Proof chain</h1>
      <p className="mt-2 max-w-2xl text-ink-2">
        Every step of this milestone, signed by Milestone and linked to the step before it. This page checks the whole chain in your browser: it
        recomputes each hash, checks each signature against the published key, and checks that nothing was removed or reordered.
      </p>

      <section
        aria-live="polite"
        className={`mt-6 rounded-lg border p-4 sm:p-5 ${check === null ? "border-rule bg-panel" : ok ? "border-paid bg-paid-field" : "border-failed bg-failed-field"}`}
      >
        {check === null ? (
          <p className="text-ink-2">Checking…</p>
        ) : (
          <div className="flex items-start gap-3">
            {ok ? <ShieldCheck aria-hidden className="mt-0.5 size-6 shrink-0 text-paid" /> : <ShieldX aria-hidden className="mt-0.5 size-6 shrink-0 text-failed" />}
            <div>
              <p className={`font-semibold ${ok ? "text-paid" : "text-failed"}`}>
                {ok
                  ? `Verified in your browser: ${check.events.length} events, every hash, link and signature checks out`
                  : `Verification failed: ${check.problems.length} problem${check.problems.length === 1 ? "" : "s"}`}
              </p>
              <p className="mt-1 text-sm text-ink-2">
                {tampered !== null ? `You changed one character of event ${tampered + 1} in a copy. ` : ""}
                {ms !== null ? `Checked in ${ms} ms. ` : ""}
                {check.head && (
                  <>
                    Chain head <span className="font-mono">{short(check.head)}</span>.
                  </>
                )}
              </p>
              {!ok && (
                <ul className="mt-2 list-disc pl-5 text-sm text-failed">
                  {check.problems.slice(0, 5).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          {tampered === null ? (
            <button
              type="button"
              onClick={() => run(Math.min(1, data.events.length - 1))}
              disabled={!data.events.length}
              className="rounded-md border border-rule-strong bg-panel px-3 py-1.5 font-medium hover:bg-paper disabled:opacity-50"
            >
              Tamper with a copy
            </button>
          ) : (
            <button type="button" onClick={() => run(null)} className="inline-flex items-center gap-1.5 rounded-md border border-rule-strong bg-panel px-3 py-1.5 font-medium hover:bg-paper">
              <RotateCcw aria-hidden className="size-4" /> Check the real chain again
            </button>
          )}
          <button type="button" onClick={download} className="inline-flex items-center gap-1.5 rounded-md border border-rule-strong bg-panel px-3 py-1.5 font-medium hover:bg-paper">
            <Download aria-hidden className="size-4" /> Download the chain
          </button>
          <a href="/.well-known/milestone-proof-keys.json" className="self-center underline">
            Published keys
          </a>
        </div>
      </section>

      {data.signatures.length > 0 && (
        <section aria-labelledby="sigs-h" className="mt-8">
          <h2 id="sigs-h" className="text-base font-semibold">
            Signatures on the terms
          </h2>
          <p className="mt-1 text-sm text-ink-2">Each side signed a statement naming this milestone and the exact terms fingerprint, with a key only they hold. Checked in your browser.</p>
          <ul className="mt-3 border-t border-rule">
            {data.signatures.map((s, i) => {
              const c = sigChecks?.[i];
              const login = s.statement.split("|")[4];
              return (
                <li key={`${s.role}-${s.createdAt}`} className="grid grid-cols-[2rem_1fr] gap-3 border-b border-rule py-3 text-sm">
                  <span className="pt-0.5">{c ? c.ok ? <Check aria-label="verified" className="size-5 text-paid" /> : <X aria-label="failed" className="size-5 text-failed" /> : <span className="text-ink-3">·</span>}</span>
                  <div className="min-w-0">
                    <p className="font-medium">
                      {s.role === "client" ? "Client" : "Worker"} signed with {s.kind === "passkey" ? `a passkey on ${s.rpId}` : "an agent key"}
                      {login && login !== "-" ? `, as GitHub @${login}` : ""}
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-ink-2">
                      terms {short(s.termsHash)} · key {s.credentialId.slice(0, 16)}… · {fmt.format(new Date(s.createdAt))}
                    </p>
                    {c && !c.ok && <p className="mt-1 text-xs text-failed">{c.problems.join("; ")}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <ol className="mt-8 border-t border-rule">
        {data.events.map((e, i) => {
          const c = check?.events[i];
          const b = c?.body;
          const key = byKey.get(e.keyId);
          return (
            <li key={e.seq} className="grid grid-cols-[2rem_1fr] gap-3 border-b border-rule py-3 text-sm">
              <span className="pt-0.5" aria-label={c ? (c.ok ? "verified" : "failed") : "not checked yet"}>
                {c ? c.ok ? <Check aria-hidden className="size-5 text-paid" /> : <X aria-hidden className="size-5 text-failed" /> : <span className="text-ink-3">·</span>}
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium text-ink">
                    {e.seq}. {b ? eventLabel(b.event) : "unreadable event"}
                  </span>
                  {b && (
                    <time dateTime={b.at} className="text-xs text-ink-3">
                      {fmt.format(new Date(b.at))}
                    </time>
                  )}
                  {b?.to && <span className="text-xs text-ink-2">→ {stateLabel(b.to)}</span>}
                  {b?.backfilled && <span className="text-xs text-held">signed after the fact</span>}
                </p>
                {b && (
                  <p className="mt-1 break-all font-mono text-xs text-ink-2">
                    {b.actor} · {b.event}
                    {b.paypalId && !b.paypalId.startsWith("WH-") ? ` · ${b.paypalId}` : ""}
                    {Object.entries(b.facts).map(([k, v]) => ` · ${k} ${typeof v === "string" && v.length > 20 ? short(v) : String(v)}`)}
                  </p>
                )}
                <p className="mt-1 break-all font-mono text-xs text-ink-3">
                  hash {short(e.hash)} · prev {e.prev ? short(e.prev) : "none"} · key {e.keyId}
                  {key?.source === "generated" ? " (app-generated)" : ""}
                </p>
                {c && !c.ok && <p className="mt-1 text-xs text-failed">{c.problems.join("; ")}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      <section className="mt-8 text-sm text-ink-2">
        <h2 className="text-base font-semibold text-ink">Check it without this page</h2>
        <p className="mt-1">
          The check is a few dozen lines of WebCrypto (<span className="font-mono">src/lib/proof/verify.ts</span>). From a checkout of the repository:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-md border border-rule bg-panel p-3 font-mono text-xs text-ink">
          npx tsx scripts/verify-proof.mts {typeof window === "undefined" ? "" : window.location.origin}/api/proof/{data.milestoneId}
        </pre>
      </section>
    </main>
  );
}
