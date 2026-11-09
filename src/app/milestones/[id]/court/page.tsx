"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { linkFor } from "@/lib/client/links";
import { STATUS, usd, type Role } from "@/lib/client/states";

// The resolution desk for one milestone (src/lib/resolution/desk.ts): lock the decision for the arbitrator
// the terms name, match the other side's lock, and follow the case to the signed award.

type Fee = { role: Role; status: string; approveUrl: string | null; cents: number | null; captureId: string | null; payoutBatchId: string | null };
type Court = {
  role: Role | "arbitrator";
  state: string;
  lock: null | {
    lockedBy: Role;
    priorState: string;
    feeCents: number;
    status: string;
    statements: { client?: string; worker?: string };
    matchBy: string | null;
    ruleBy: string | null;
    packHash: string | null;
    draft: null | { shareBps: number; reasons: { text: string; evidence: string[] }[]; summary: string; model: string };
    draftError: string | null;
    award: null | { shareBps: number; reasons: string; keyId: string; at: string };
    arbitrator: null | { name: string; feeCents: number };
  };
  fees: Fee[];
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const pct = (bps: number) => `${bps / 100}%`;

const STEP: Record<string, string> = {
  opening: "Waiting for the fee to be funded. The lock takes effect once it is.",
  locked: "Locked. The other side can match the fee to send the case to the arbitrator.",
  arbitration: "With the arbitrator. Their signed award settles the money.",
  awarded: "Award signed. The money is settling.",
  closed: "Settled by the arbitrator's award.",
  stood: "The earlier decision stands. Every fee hold was given back.",
  ended: "The lock ended without a ruling. Any fee hold was given back.",
};

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-rule bg-panel p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <div className="mt-2 space-y-2 text-sm text-ink-2">{children}</div>
    </section>
  );
}

export default function CourtPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [token, setToken] = useState<string>();
  const [court, setCourt] = useState<Court>();
  const [msg, setMsg] = useState<string>();
  const [statement, setStatement] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const held = linkFor(id);
    setToken(held?.client ?? held?.worker);
    const q = new URLSearchParams(window.location.search);
    if (q.get("error")) setMsg(q.get("error")!);
  }, [id]);

  const load = useCallback(async () => {
    if (!token) return;
    const r = await fetch(`/api/milestones/${id}/court`, { headers: { "x-milestone-token": token } });
    const b = await r.json().catch(() => ({}));
    if (r.ok) setCourt(b);
    else setMsg(b.error);
  }, [id, token]);
  useEffect(() => {
    load();
  }, [load]);

  const act = async (action: "lock" | "match-lock", card: boolean) => {
    setBusy(true);
    setMsg(undefined);
    const r = await fetch(`/api/milestones/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-milestone-token": token ?? "" }, body: JSON.stringify({ statement, card }) });
    const b = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok && b.approveUrl) {
      window.location.href = b.approveUrl;
      return;
    }
    if (!r.ok) setMsg(b.error);
    await load();
  };

  if (!token) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16">
        <h1 className="text-xl font-semibold">Resolution desk</h1>
        <p className="mt-2 text-ink-2">Open this milestone with its client or worker link first.</p>
        <p className="mt-4 flex flex-wrap gap-4">
          <Link href={`/proof/${id}`} className="underline">
            Public proof page
          </Link>
          <Link href="/demo" className="underline">
            Run a deal on /demo
          </Link>
        </p>
      </main>
    );
  }
  const lock = court?.lock;
  const role = court?.role;
  const canLock = !lock && (court?.state === "PASSED" || court?.state === "HUMAN_CHECK") && role !== "arbitrator";
  const canMatch = lock?.status === "locked" && role !== "arbitrator" && role !== lock.lockedBy;
  const fee = lock?.feeCents ?? 500;

  return (
    <main className="mx-auto max-w-2xl space-y-5 px-4 py-10">
      <div>
        <Link href={`/milestones/${id}`} className="text-sm underline">
          Back to the milestone
        </Link>
        <h1 className="mt-3 text-xl font-semibold text-ink">Resolution desk</h1>
        <p className="mt-1 text-sm text-ink-2">
          A named arbitrator settles a decision either side disagrees with. Locking costs a {usd(fee)} fee hold, and the other side has 72 hours to match it. If they
          don&apos;t, the decision so far stands and your fee is given back. The side the award goes against pays the arbitrator (below 50% the worker, from 50% the
          client), and the other side&apos;s fee is given back. An AI drafts an award for the arbitrator, but only the arbitrator&apos;s signature settles anything.
        </p>
      </div>
      {msg && <p className="rounded-md border border-failed bg-failed-field px-3 py-2 text-sm text-failed">{msg}</p>}
      {court && (
        <Box title={lock ? STEP[lock.status] ?? lock.status : `Status: ${STATUS[court.state]?.label ?? court.state}`}>
          {lock?.arbitrator && <p>Arbitrator named in the signed terms: {lock.arbitrator.name}.</p>}
          {lock && <p>Locked by the {lock.lockedBy}, from &ldquo;{STATUS[lock.priorState]?.label ?? lock.priorState}&rdquo;.</p>}
          {lock?.matchBy && lock.status === "locked" && <p>The other side can match until {when(lock.matchBy)}.</p>}
          {lock?.ruleBy && lock.status === "arbitration" && <p>The arbitrator rules by {when(lock.ruleBy)}. If they don&apos;t, the earlier decision stands.</p>}
          {lock?.packHash && (
            <p>
              Evidence pack, frozen and in the proof chain: <span className="font-mono text-xs [overflow-wrap:anywhere]">{lock.packHash}</span>
            </p>
          )}
          {court.fees.length > 0 && (
            <ul className="list-disc pl-5">
              {court.fees.map((f) => (
                <li key={f.role}>
                  {f.role === "client" ? "Client" : "Worker"} fee: {f.status === "open" ? "not funded yet" : f.status === "authorized" ? `${usd(f.cents ?? fee)} held` : f.status === "captured" ? "paid to the arbitrator" : "given back"}
                  {f.status === "open" && f.approveUrl && role === f.role && (
                    <>
                      {" "}
                      ·{" "}
                      <a className="underline" href={f.approveUrl}>
                        approve at PayPal
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Box>
      )}

      {(canLock || canMatch) && (
        <Box title={canLock ? "Lock this decision for the arbitrator" : "Match the fee so the arbitrator decides"}>
          <label className="block">
            <span className="text-ink">Your statement (up to 2,000 characters, both sides and the arbitrator read it)</span>
            <textarea value={statement} onChange={(e) => setStatement(e.target.value.slice(0, 2000))} rows={5} className="mt-1 w-full rounded-md border border-rule-strong bg-paper px-3 py-2 text-ink" />
          </label>
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={() => act(canLock ? "lock" : "match-lock", false)} className="rounded-md bg-ink px-4 py-2 text-paper disabled:opacity-60">
              Hold {usd(fee)} with PayPal
            </button>
            <button type="button" disabled={busy} onClick={() => act(canLock ? "lock" : "match-lock", true)} className="rounded-md border border-rule-strong px-4 py-2 text-ink disabled:opacity-60">
              Use the sandbox test card
            </button>
          </div>
        </Box>
      )}

      {lock && (lock.statements.client || lock.statements.worker) && (
        <Box title="Statements">
          {(["client", "worker"] as const).map((r) =>
            lock.statements[r] ? (
              <p key={r} className="whitespace-pre-wrap">
                <span className="font-medium text-ink">{r === "client" ? "Client" : "Worker"}:</span> {lock.statements[r]}
              </p>
            ) : null,
          )}
        </Box>
      )}

      {lock?.draft && !lock.award && (
        <Box title={`AI draft (not binding): ${pct(lock.draft.shareBps)} to the worker`}>
          {lock.draft.summary && <p>{lock.draft.summary}</p>}
          <ul className="list-disc pl-5">
            {lock.draft.reasons.map((r, i) => (
              <li key={i}>
                {r.text} {r.evidence.length > 0 && <span className="font-mono text-xs">[{r.evidence.join(", ")}]</span>}
              </li>
            ))}
          </ul>
          <p className="text-xs">Drafted by {lock.draft.model}. The arbitrator may accept or change it.</p>
        </Box>
      )}
      {lock?.draftError && !lock.draft && lock.status === "arbitration" && <p className="text-sm text-ink-2">The AI draft isn&apos;t ready ({lock.draftError}). The arbitrator can rule without it.</p>}

      {lock?.award && (
        <Box title={`Signed award: ${pct(lock.award.shareBps)} to the worker`}>
          <p className="whitespace-pre-wrap">{lock.award.reasons}</p>
          <p className="text-xs">
            Signed {when(lock.award.at)} with key <span className="font-mono">{lock.award.keyId.slice(0, 16)}…</span>, the one the terms name.
          </p>
        </Box>
      )}
    </main>
  );
}
