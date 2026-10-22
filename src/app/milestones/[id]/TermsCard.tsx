"use client";

import { AlertTriangle, FlaskConical, Lightbulb, PenLine, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { GuillocheSeal } from "@/components/GuillocheSeal";
import type { MilestoneView, Role } from "@/lib/client/states";
import { NO_TESTED_MUST_WARNING, SUBJECTIVE_WARNING, termsWarnings } from "@/lib/contract/warnings";

// The contract: criteria (compiled into tests where testable), editable by the client in DRAFT, sealed by
// both signatures on the exact fingerprint shown. A tested criterion whose text was edited without a new
// test comes back from the server marked testStale; neither side can sign until it's regenerated or
// switched to AI review. The same goes for a weak test (testWeak): the server ran it against an empty
// implementation and it passed, or it couldn't load, so it wouldn't catch missing work.
// The AI's edge-case suggestions sit beside the terms (never in the fingerprint) until the client adds
// one as a criterion or dismisses it. The client can write or edit a test; the server checks it the same
// way and labels it testBy "client", so the worker sees who wrote it. Terms saved since the policy existed
// also fingerprint the platform fee and the objection window, shown under the heading.

type Criterion = {
  id: string;
  text: string;
  kind: "must" | "nice";
  check: "test" | "review";
  test?: { path: string; code: string };
  testStale?: true;
  testWeak?: true;
  weakReason?: string;
  testBy?: "client";
};
type Suggestion = { text: string; why: string };
type Policy = { platformFeeBps: number; objectionWindowSeconds: number };
type Terms = { criteria: Criterion[]; testCommand?: string; suggestions?: Suggestion[]; policy?: Policy };

const DEFAULT_TEST_COMMAND = "node --test 'acceptance/*.test.ts'";
const testTemplate = (id: string) =>
  `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { myFunction } from '../src/my-file.ts';\n\ntest('${id}', () => {\n  // Replace with a real check, for example:\n  // assert.equal(myFunction('input'), 'expected output');\n});\n`;

/** "Platform fee 5% · objection window 48 h" */
function policyLine(p: Policy): string {
  const s = p.objectionWindowSeconds;
  const window = s >= 3600 && s % 3600 === 0 ? `${s / 3600} h` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
  return `Platform fee ${p.platformFeeBps / 100}% · objection window ${window}`;
}
export type Call = (action: string, body?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;

const input = "w-full rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-3";

export function TermsCard({ m, role, call }: { m: MilestoneView; role: Role; call: Call }) {
  const stored = (m.criteria as Terms | null) ?? null;
  const hash = m.criteria_hash ?? null;
  const editable = role === "client" && m.state === "DRAFT";
  const sealed = !!hash && m.client_signed_hash === hash && m.worker_signed_hash === hash;
  const [draft, setDraft] = useState<Terms | null>(stored);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [repo, setRepo] = useState(String(m.repo ?? ""));
  const [stack, setStack] = useState(String(m.stack ?? "TypeScript, node:test"));

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
    setDraft({ ...draft, criteria: draft.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
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
  const repoChanged = repo !== String(m.repo ?? "");
  const savedById = new Map((stored?.criteria ?? []).map((c) => [c.id, c]));
  // Unsaved text edits that saving will mark stale (the server decides; this only warns ahead).
  const willGoStale = (c: Criterion) => {
    const saved = savedById.get(c.id);
    return !c.testStale && c.check === "test" && !!saved?.test && saved.test.code === c.test?.code && saved.text !== c.text;
  };
  const anyStale = !!draft?.criteria.some((c) => c.testStale || c.testWeak);
  // Switching to AI review drops the test (CI runs every test present) and saves straight away.
  const toReview = (i: number) => {
    if (!draft) return;
    const criteria = draft.criteria.map((c, j) => (j === i ? { ...c, check: "review" as const, test: undefined, testStale: undefined, testWeak: undefined, weakReason: undefined } : c));
    run("review", "edit-terms", { terms: { ...draft, criteria }, repo });
  };
  const suggestions = editable ? (stored?.suggestions ?? []) : [];
  const without = (s: Suggestion) => suggestions.filter((x) => x.text !== s.text);
  // Adding saves straight away as an AI-reviewed criterion; the client can then regenerate a test for it.
  const adopt = (s: Suggestion) => {
    if (!draft) return;
    const next = Math.max(0, ...draft.criteria.map((c) => Number(c.id.slice(1)))) + 1;
    run(`add:${s.text}`, "edit-terms", { terms: { ...draft, criteria: [...draft.criteria, { id: `C${next}`, text: s.text, kind: "must", check: "review" }], suggestions: without(s) }, repo });
  };
  // Dismissing changes nothing in the contract, so it saves the stored terms and keeps any signatures.
  const dismiss = (s: Suggestion) => stored && run(`dismiss:${s.text}`, "edit-terms", { terms: { ...stored, suggestions: without(s) }, repo: String(m.repo ?? "") });
  const testIssue = (c: Criterion) => (c.testStale ? "Test out of date" : c.testWeak ? "Weak test" : undefined);
  // The worker reads every test before signing, so the code is open by default until they have.
  const workerToSign = role === "worker" && m.state === "DRAFT" && !!hash && m.worker_signed_hash !== hash;
  const warnings = termsWarnings(draft?.criteria ?? [], String(m.verifier ?? "code_pr"));
  const subjectiveById = new Map(warnings.subjective.map((w) => [w.id, w.words]));
  // The client writes a test by hand: it starts as a template the server would flag as weak until filled in.
  const writeTest = (i: number) => {
    if (!draft) return;
    const c = draft.criteria[i]!;
    setDraft({
      ...draft,
      testCommand: draft.testCommand ?? DEFAULT_TEST_COMMAND,
      criteria: draft.criteria.map((x, j) => (j === i ? { ...x, check: "test" as const, test: { path: `acceptance/${c.id.toLowerCase()}.test.ts`, code: testTemplate(c.id) } } : x)),
    });
    setDirty(true);
  };

  return (
    <section aria-labelledby="terms-h" className="rounded-lg border border-rule bg-panel p-4 sm:p-5">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <h2 id="terms-h" className="text-lg font-semibold">
            Terms
          </h2>
          <p className="mt-1 text-sm text-ink-2">
            {m.verifier === "rubric_text"
              ? "What the deliverable must do. The AI reviews the text against each criterion."
              : "What the work must do. Testable criteria run as CI tests on the worker's pull request; the AI reviews only the rest."}
          </p>
          {stored?.policy && <p className="mt-1 text-sm text-ink">{policyLine(stored.policy)}</p>}

          {editable && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="text-ink-2">Repository (owner/name)</span>
                <input className={`${input} mt-1`} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="acme/web-app" />
              </label>
              <label className="text-sm">
                <span className="text-ink-2">Stack</span>
                <input className={`${input} mt-1`} value={stack} onChange={(e) => setStack(e.target.value)} />
              </label>
            </div>
          )}
        </div>
        {/* On large screens the seal sits in the side column (ContractSeal); here it serves phones. */}
        <div className="shrink-0 self-center lg:hidden">
          <GuillocheSeal hash={hash} sealed={sealed} size={150} />
        </div>
      </div>

      {!draft && editable && (
        <div className="mt-4 rounded-md border border-dashed border-rule-strong p-4 text-sm">
          <p className="text-ink-2">The AI turns your brief into criteria and writes a test for each one code can check. You can edit everything before signing.</p>
          <button disabled={!!busy} onClick={() => run("draft", "draft-terms", { repo, stack })} className="mt-3 inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 font-medium text-accent-ink disabled:opacity-50">
            <Sparkles className="size-4" aria-hidden="true" />
            {busy === "draft" ? "Drafting… (up to a minute)" : "Draft the terms with AI"}
          </button>
        </div>
      )}
      {!draft && !editable && <p className="mt-4 text-sm text-ink-2">The client hasn&apos;t drafted the terms yet.</p>}

      {draft && (
        <ol className="mt-4 divide-y divide-rule rounded-md border border-rule">
          {draft.criteria.map((c, i) => (
            <li key={c.id} className="space-y-2 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-ink-3">{c.id}</span>
                {editable ? (
                  <select aria-label={`${c.id} importance`} value={c.kind} onChange={(e) => update(i, { kind: e.target.value as Criterion["kind"] })} className="rounded border border-rule-strong bg-panel px-1.5 py-0.5 text-xs">
                    <option value="must">Must have</option>
                    <option value="nice">Nice to have</option>
                  </select>
                ) : (
                  <span className={`rounded px-1.5 py-0.5 text-xs ${c.kind === "must" ? "bg-blocked-field font-medium text-ink" : "text-ink-2"}`}>{c.kind === "must" ? "Must have" : "Nice to have"}</span>
                )}
                <span className={`inline-flex items-center gap-1 text-xs ${testIssue(c) ? "font-medium text-failed" : "text-ink-2"}`}>
                  {testIssue(c) ? <AlertTriangle className="size-3.5" aria-hidden="true" /> : c.check === "test" ? <FlaskConical className="size-3.5" aria-hidden="true" /> : <Sparkles className="size-3.5" aria-hidden="true" />}
                  {testIssue(c) ?? (c.check === "test" ? "Checked by a CI test" : "Checked by AI review")}
                </span>
                {c.check === "test" && c.testBy === "client" && (
                  <span className="inline-flex items-center gap-1 rounded bg-held-field px-1.5 py-0.5 text-xs font-medium text-held">
                    <PenLine className="size-3.5" aria-hidden="true" />
                    {role === "client" ? "Test written by you · not run before signing" : "Written by the client · not run before signing: read it"}
                  </span>
                )}
                {editable && (
                  <button onClick={() => remove(i)} className="ml-auto inline-flex items-center gap-1 text-xs text-ink-2 hover:text-failed" aria-label={`Remove ${c.id}`}>
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    Remove
                  </button>
                )}
              </div>
              {editable ? (
                <textarea aria-label={`${c.id} requirement`} value={c.text} onChange={(e) => update(i, { text: e.target.value })} rows={2} className={input} />
              ) : (
                <p className="text-ink">{c.text}</p>
              )}
              {subjectiveById.has(c.id) && (
                <p className="flex items-start gap-1.5 text-xs text-held">
                  <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    &ldquo;{subjectiveById.get(c.id)!.join("”, “")}&rdquo;: {SUBJECTIVE_WARNING}
                  </span>
                </p>
              )}
              {willGoStale(c) && <p className="text-xs text-held">The test below still checks the old text. Saving marks it out of date, and the terms can&apos;t be signed until it&apos;s regenerated or switched to AI review.</p>}
              {(c.testStale || c.testWeak) && (
                <div role="status" className="rounded-md border border-failed/40 bg-failed-field p-3 text-xs text-ink">
                  {c.testStale ? (
                    <p>
                      <span className="font-medium">{c.id}&apos;s test no longer matches its text.</span> The text was edited after the test was written, so CI wouldn&apos;t check what it says. Neither side can sign until the test is regenerated or {c.id} is checked by AI review.
                    </p>
                  ) : (
                    <p>
                      <span className="font-medium">{c.id}&apos;s test doesn&apos;t work as a check.</span> We ran it with the code missing, and it {c.weakReason ?? "didn't fail"}. Neither side can sign until the test is regenerated or {c.id} is checked by AI review.
                    </p>
                  )}
                  {editable && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button disabled={!!busy || dirty} onClick={() => run("regen", "draft-terms", { repo, stack })} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 font-medium text-accent-ink disabled:opacity-50">
                        <Sparkles className="size-3.5" aria-hidden="true" />
                        {busy === "regen" ? "Regenerating…" : "Regenerate tests with AI"}
                      </button>
                      <button disabled={!!busy} onClick={() => toReview(i)} className="rounded-md border border-rule-strong bg-panel px-2.5 py-1 hover:bg-paper disabled:opacity-50">
                        {busy === "review" ? "Switching…" : "Check it by AI review instead"}
                      </button>
                      {dirty && <span className="self-center text-ink-2">Save your changes first to regenerate.</span>}
                    </div>
                  )}
                </div>
              )}
              {c.test && (
                <details open={workerToSign || c.testStale || c.testWeak || willGoStale(c) || undefined}>
                  <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">
                    Test: <span className="font-mono">{c.test.path}</span>
                  </summary>
                  {editable ? (
                    <>
                      <textarea
                        aria-label={`${c.id} test code`}
                        value={c.test.code}
                        onChange={(e) => update(i, { test: { path: c.test!.path, code: e.target.value } })}
                        rows={Math.min(16, Math.max(6, c.test.code.split("\n").length + 1))}
                        spellCheck={false}
                        className={`${input} mt-2 font-mono text-xs leading-relaxed`}
                      />
                      <p className="mt-1 text-xs text-ink-2">Saving runs your test once with the code missing. It has to fail there, or it can&apos;t be signed. The worker sees that you wrote it.</p>
                    </>
                  ) : (
                    <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-paper p-3 font-mono text-xs leading-relaxed text-ink">{c.test.code}</pre>
                  )}
                </details>
              )}
              {editable && c.check === "review" && m.verifier !== "rubric_text" && (
                <button onClick={() => writeTest(i)} className="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink">
                  <FlaskConical className="size-3.5" aria-hidden="true" />
                  Write a test for it yourself
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {draft && warnings.noTestedMust && (
        <p role="note" className="mt-3 flex items-start gap-1.5 rounded-md border border-held/40 bg-held-field p-3 text-xs text-ink">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-held" aria-hidden="true" />
          <span>{NO_TESTED_MUST_WARNING}</span>
        </p>
      )}

      {draft && suggestions.length > 0 && (
        <div className="mt-4 rounded-md border border-dashed border-rule-strong p-3 text-sm">
          <h3 className="inline-flex items-center gap-1.5 font-medium">
            <Lightbulb className="size-4" aria-hidden="true" />
            Edge cases the AI noticed
          </h3>
          <p className="mt-0.5 text-xs text-ink-2">Not part of the terms unless you add them.</p>
          <ul className="mt-2 space-y-2">
            {suggestions.map((s) => (
              <li key={s.text} className="rounded-md bg-paper p-2.5">
                <p className="text-ink">{s.text}</p>
                {s.why && <p className="mt-0.5 text-xs text-ink-2">{s.why}</p>}
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <button disabled={!!busy} onClick={() => adopt(s)} className="inline-flex items-center gap-1 rounded-md border border-rule-strong bg-panel px-2.5 py-1 hover:bg-paper disabled:opacity-50">
                    <Plus className="size-3.5" aria-hidden="true" />
                    {busy === `add:${s.text}` ? "Adding…" : "Add as criterion"}
                  </button>
                  <button disabled={!!busy} onClick={() => dismiss(s)} className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-ink-2 hover:text-ink disabled:opacity-50">
                    <X className="size-3.5" aria-hidden="true" />
                    {busy === `dismiss:${s.text}` ? "Dismissing…" : "Dismiss"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editable && draft && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={add} className="inline-flex items-center gap-1.5 rounded-md border border-rule-strong px-3 py-1.5 text-sm hover:bg-paper">
            <Plus className="size-4" aria-hidden="true" />
            Add criterion
          </button>
          {/* While a test is out of date or weak, the draft action regenerates only those tests (the button above). */}
          {!anyStale && (
            <button onClick={() => run("draft", "draft-terms", { repo, stack })} disabled={!!busy} className="inline-flex items-center gap-1.5 rounded-md border border-rule-strong px-3 py-1.5 text-sm hover:bg-paper disabled:opacity-50">
              <Sparkles className="size-4" aria-hidden="true" />
              {busy === "draft" ? "Redrafting…" : "Redraft with AI"}
            </button>
          )}
          {(dirty || repoChanged) && (
            <button disabled={!!busy} onClick={() => run("save", "edit-terms", { terms: draft, repo })} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink disabled:opacity-50">
              {busy === "save" ? "Saving…" : "Save changes"}
            </button>
          )}
        </div>
      )}
      {dirty && <p className="mt-2 text-xs text-held">Unsaved changes. Saving clears both signatures, so both sides sign the new terms.</p>}
    </section>
  );
}
