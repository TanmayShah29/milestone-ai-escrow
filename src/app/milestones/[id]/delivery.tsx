"use client";

import { useEffect, useState } from "react";

// Delivery and verdict: the worker submits (PR or text), CI + the verifier run, fixed rules decide, and a
// passed milestone waits out the objection window before the money is released automatically.

type CriterionVerdict = { id: string; kind: string; source: "test" | "ai"; verdict: "pass" | "fail" | "unclear"; confidence: number; evidence: string[] };
type Review = {
  head_sha: string;
  status: "pending" | "done";
  decision: string | null;
  reasons: string[] | null;
  model: string | null;
  verdict: { criteria: CriterionVerdict[]; summary: string; feedbackForWorker: string; injection: { detected: boolean; quotes: string[] }; tampering: string[] } | null;
};
type M = Record<string, unknown> & { id: string; state: string };

const ICON = { pass: "✅", fail: "❌", unclear: "❔" } as const;

export function DeliveryPanel(props: { m: M; role: "client" | "worker"; review: Review | null; call: (action: string, body: Record<string, unknown>) => Promise<{ ok: boolean }> }) {
  const { m, role, review, call } = props;
  const [prUrl, setPrUrl] = useState((m.pr_url as string) ?? "");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const isText = m.verifier === "rubric_text";
  const hash = m.criteria_hash as string | null;
  const canSubmit = role === "worker" && (m.state === "FUNDED" || m.state === "CHANGES_REQUESTED");
  const releaseAt = m.release_after ? new Date(m.release_after as string).getTime() : null;

  useEffect(() => {
    if (m.state !== "PASSED") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [m.state]);

  const act = async (action: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    await call(action, body);
    setBusy(false);
  };

  return (
    <section className="space-y-3 rounded-lg border border-black/10 dark:border-white/15 p-4">
      <h2 className="font-medium">Delivery</h2>

      {canSubmit && !isText && (
        <div className="space-y-2 text-sm">
          <p>
            Open a pull request in <code>{String(m.repo ?? "the repository")}</code> and put this line in its description, so CI runs the signed tests:
          </p>
          <pre className="rounded bg-black/5 dark:bg-white/5 p-2 text-xs overflow-x-auto">Milestone-Terms: {hash}</pre>
          <div className="flex gap-2">
            <input className="flex-1 min-w-0 rounded border border-black/15 dark:border-white/20 bg-transparent px-2 py-1" placeholder="https://github.com/owner/repo/pull/1" value={prUrl} onChange={(e) => setPrUrl(e.target.value)} />
            <button disabled={busy || !prUrl} onClick={() => act("submit", { prUrl })} className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">
              {m.state === "CHANGES_REQUESTED" ? "Resubmit" : "Submit PR"}
            </button>
          </div>
        </div>
      )}
      {canSubmit && isText && (
        <div className="space-y-2 text-sm">
          <textarea rows={6} className="w-full rounded border border-black/15 dark:border-white/20 bg-transparent px-2 py-1" placeholder="Paste the deliverable" value={text} onChange={(e) => setText(e.target.value)} />
          <button disabled={busy || text.length < 20} onClick={() => act("submit", { text })} className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">
            Submit
          </button>
        </div>
      )}

      {(m.state === "SUBMITTED" || m.state === "IN_REVIEW") && (
        <p className="text-sm">
          ⏳ {review?.status === "pending" ? (review.reasons?.[0] ?? "Waiting for CI") : "Reviewing"}… this page checks every 15 seconds.
        </p>
      )}

      {review?.verdict && review.status === "done" && (
        <div className="space-y-2 text-sm">
          <p>
            <strong>{review.decision?.replace("_", " ")}</strong> <span className="opacity-60">· commit {review.head_sha.slice(0, 7)}{review.model ? ` · reviewed by ${review.model}` : ""}</span>
          </p>
          <ul className="space-y-1">
            {review.verdict.criteria.map((c) => (
              <li key={c.id}>
                {ICON[c.verdict]} <span className="font-mono">{c.id}</span> <span className="opacity-60">({c.kind}, {c.source === "test" ? "CI test" : `AI ${Math.round(c.confidence * 100)}%`})</span>{" "}
                <span className="opacity-80 break-all">{c.evidence[0]}</span>
              </li>
            ))}
          </ul>
          <p className="opacity-80">
            <span className="opacity-60">Decision by fixed rules: </span>
            {review.reasons?.join("; ")}
          </p>
          {review.verdict.injection.detected && (
            <p className="rounded border border-red-500/50 bg-red-500/10 p-2">
              ⚠️ Text aimed at the AI reviewer was found and ignored: <code className="break-all">{review.verdict.injection.quotes[0]}</code>
            </p>
          )}
          {review.verdict.tampering.length > 0 && <p className="rounded border border-red-500/50 bg-red-500/10 p-2">⚠️ The PR changes protected files: {review.verdict.tampering.join(", ")}</p>}
          {review.verdict.feedbackForWorker && <p className="opacity-80">{review.verdict.feedbackForWorker}</p>}
        </div>
      )}

      {m.state === "HUMAN_CHECK" && role === "client" && (
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => act("approve")} className="rounded bg-green-700 px-3 py-1 text-sm text-white disabled:opacity-50">
            Approve the work
          </button>
          <button disabled={busy} onClick={() => act("request-changes")} className="rounded border border-black/15 dark:border-white/20 px-3 py-1 text-sm">
            Request changes
          </button>
        </div>
      )}

      {m.state === "PASSED" && releaseAt && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>
            {releaseAt > now ? `Releasing to the worker in ${Math.ceil((releaseAt - now) / 1000)} s unless the client objects.` : "Releasing now…"}
          </span>
          {role === "client" && releaseAt > now && (
            <button disabled={busy} onClick={() => act("object")} className="rounded border border-red-600 px-3 py-1 text-red-700 dark:text-red-400">
              Object
            </button>
          )}
        </div>
      )}
    </section>
  );
}
