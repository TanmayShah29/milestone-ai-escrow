"use client";

import { useEffect, useState } from "react";

// The contract panel: AI-drafted acceptance criteria (compiled into tests where possible), editable by
// the client while in DRAFT, signed by both sides against the exact fingerprint shown.

type Criterion = { id: string; text: string; kind: "must" | "nice"; check: "test" | "review"; test?: { path: string; code: string } };
type Terms = { criteria: Criterion[]; testCommand?: string };
type M = Record<string, unknown> & { id: string; state: string };

export function TermsPanel(props: {
  m: M;
  role: "client" | "worker";
  call: (action: string, body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
}) {
  const { m, role, call } = props;
  const stored = (m.criteria as Terms | null) ?? null;
  const hash = (m.criteria_hash as string | null) ?? null;
  const editable = role === "client" && m.state === "DRAFT";
  const [draft, setDraft] = useState<Terms | null>(stored);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [repo, setRepo] = useState((m.repo as string) ?? "");
  const [stack, setStack] = useState((m.stack as string) ?? "TypeScript, node:test");

  useEffect(() => {
    setDraft(stored);
    setDirty(false);
  }, [hash]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when the saved terms change

  const run = async (label: string, action: string, body: Record<string, unknown>) => {
    setBusy(label);
    await call(action, body);
    setBusy(undefined);
  };
  const update = (i: number, patch: Partial<Criterion>) => {
    if (!draft) return;
    const criteria = draft.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c));
    setDraft({ ...draft, criteria });
    setDirty(true);
  };
  const remove = (i: number) => {
    if (!draft) return;
    setDraft({ ...draft, criteria: draft.criteria.filter((_, j) => j !== i) });
    setDirty(true);
  };
  const add = () => {
    const criteria = draft?.criteria ?? [];
    const next = Math.max(0, ...criteria.map((c) => Number(c.id.slice(1)))) + 1;
    setDraft({ ...(draft ?? {}), criteria: [...criteria, { id: `C${next}`, text: "", kind: "must", check: "review" }] });
    setDirty(true);
  };

  const signed = { client: m.client_signed_hash === hash && !!hash, worker: m.worker_signed_hash === hash && !!hash };

  return (
    <section className="space-y-3 rounded-lg border border-black/10 dark:border-white/15 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Terms</h2>
        {hash && (
          <span className="text-xs opacity-70" title={hash}>
            fingerprint <code>{hash.slice(0, 12)}</code>
            {m.criteria_model ? ` · drafted by ${String(m.criteria_model)}` : ""}
          </span>
        )}
      </div>

      {editable && (
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] items-end text-sm">
          <label>
            <span className="opacity-70">Repository (owner/name)</span>
            <input className="mt-1 w-full rounded border border-black/15 dark:border-white/20 bg-transparent px-2 py-1" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="acme/web-app" />
          </label>
          <label>
            <span className="opacity-70">Stack</span>
            <input className="mt-1 w-full rounded border border-black/15 dark:border-white/20 bg-transparent px-2 py-1" value={stack} onChange={(e) => setStack(e.target.value)} />
          </label>
          <button disabled={!!busy} onClick={() => run("draft", "draft-terms", { repo, stack })} className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50">
            {busy === "draft" ? "Drafting… (~20 s)" : stored ? "Redraft with AI" : "Draft terms with AI"}
          </button>
        </div>
      )}

      {!draft && !editable && <p className="text-sm opacity-60">The client hasn&apos;t drafted the terms yet.</p>}

      {draft && (
        <ol className="space-y-2">
          {draft.criteria.map((c, i) => (
            <li key={c.id} className="rounded border border-black/10 dark:border-white/10 p-2 text-sm space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono opacity-60">{c.id}</span>
                {editable ? (
                  <select value={c.kind} onChange={(e) => update(i, { kind: e.target.value as Criterion["kind"] })} className="rounded border border-black/15 dark:border-white/20 bg-transparent text-xs">
                    <option value="must">must</option>
                    <option value="nice">nice</option>
                  </select>
                ) : (
                  <span className={`rounded px-1.5 text-xs ${c.kind === "must" ? "bg-blue-600/15" : "bg-black/5 dark:bg-white/10"}`}>{c.kind}</span>
                )}
                <span className="rounded px-1.5 text-xs bg-black/5 dark:bg-white/10">{c.check === "test" ? "checked by test" : "AI review"}</span>
                {editable && (
                  <button onClick={() => remove(i)} className="ml-auto text-xs underline opacity-70">
                    remove
                  </button>
                )}
              </div>
              {editable ? (
                <textarea value={c.text} onChange={(e) => update(i, { text: e.target.value })} rows={2} className="w-full rounded border border-black/15 dark:border-white/20 bg-transparent px-2 py-1" />
              ) : (
                <p>{c.text}</p>
              )}
              {c.test && (
                <details>
                  <summary className="cursor-pointer text-xs opacity-70">{c.test.path}</summary>
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-black/5 dark:bg-white/5 p-2 text-xs">{c.test.code}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
      {draft?.testCommand && (
        <p className="text-xs opacity-70">
          CI runs <code>{draft.testCommand}</code>
        </p>
      )}

      {editable && (
        <div className="flex flex-wrap gap-2">
          <button onClick={add} className="rounded border border-black/15 dark:border-white/20 px-3 py-1 text-sm">
            Add criterion
          </button>
          {(dirty || repo !== ((m.repo as string) ?? "")) && (
            <button disabled={!!busy} onClick={() => run("save", "edit-terms", { terms: draft, repo })} className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50">
              {busy === "save" ? "Saving…" : "Save edits"}
            </button>
          )}
        </div>
      )}

      {hash && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>Client {signed.client ? "✓ signed" : "· not signed"}</span>
          <span>Worker {signed.worker ? "✓ signed" : "· not signed"}</span>
          {m.state === "DRAFT" && !signed[role] && !dirty && (
            <button disabled={!!busy} onClick={() => run("sign", "sign-terms", { hash })} className="rounded bg-green-700 px-3 py-1 text-white disabled:opacity-50">
              {busy === "sign" ? "Signing…" : `Sign terms ${hash.slice(0, 12)}`}
            </button>
          )}
          {m.state !== "DRAFT" && (
            <a className="underline opacity-70" href={`/api/contracts/${hash}`} target="_blank" rel="noreferrer">
              locked contract
            </a>
          )}
        </div>
      )}
    </section>
  );
}
