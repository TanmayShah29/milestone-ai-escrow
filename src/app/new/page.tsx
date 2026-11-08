"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { heldLinks, rememberLink, type Held } from "@/lib/client/links";
import { DEMO_WORKER_EMAIL } from "@/lib/client/sandbox";

// Create a milestone: describe the work, and the AI drafts the terms straight away. The client reviews,
// edits and signs them on the milestone page.

// A request the server dropped (a cold start, a deploy restarting it) must not leave the page spinning.
// Each try has a time limit; a dropped or timed-out create is retried with the same Idempotency-Key, so the
// server returns the first milestone instead of opening a second one.
type Answer = { ok: boolean; status: number; body: Record<string, unknown> };
async function post(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<Answer | undefined> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return { ok: r.ok, status: r.status, body: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return undefined; // network error or our time limit
  }
}
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const retryable = (a: Answer | undefined) => !a || a.status === 409 || a.status === 502 || a.status === 503 || a.status === 504;

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono tabular-nums opacity-80">{Math.max(0, Math.floor((now - since) / 1000))}s</span>;
}

const field = "mt-1 w-full rounded-md border border-rule-strong bg-panel px-3 py-2 text-ink placeholder:text-ink-3";

export default function NewMilestone() {
  const [held, setHeld] = useState<Held[]>([]);
  const [busy, setBusy] = useState<{ text: string; since: number }>();
  const step = (text: string) => setBusy({ text, since: Date.now() });
  // One key per filled-in form: pressing the button again after a failure reuses it (safe), and editing
  // the form starts a new one.
  const idem = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [f, setF] = useState({ title: "", brief: "", amount: "", freelancerEmail: "", repo: "", dueDate: "", afterMilestoneId: "", verifier: "code_pr" as "code_pr" | "rubric_text" });
  useEffect(() => setHeld(heldLinks().filter((h) => h.client)), []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    idem.current = undefined;
    setF({ ...f, [k]: e.target.value });
  };

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    idem.current ??= crypto.randomUUID();
    step("Step 1 of 2: creating the milestone…");
    let a: Answer | undefined;
    // Up to ~3 minutes in all: enough for a free server to wake up, or a deploy to finish restarting it.
    for (let i = 0; i < 4; i++) {
      a = await post("/api/milestones", f, { "idempotency-key": idem.current }, 45_000);
      if (!retryable(a)) break;
      if (i < 3) {
        step(i === 0 ? "Step 1 of 2: the server is slow to answer, trying again…" : "Step 1 of 2: still waiting for the server (it may be waking up)…");
        await wait(a?.status === 409 ? 5_000 : 3_000);
      }
    }
    if (!a?.ok) {
      setBusy(undefined);
      return setError(
        retryable(a)
          ? "The server didn't answer in time. It may be waking up or restarting. Press the button again: it won't create a second milestone."
          : String(a?.body.error ?? "Couldn't create the milestone. Try again."),
      );
    }
    const m = a.body.milestone as { id: string; title: string };
    const tokens = a.body as { clientToken: string; workerToken: string };
    // This browser is the client's: the worker token is kept only to show as the link to send them.
    rememberLink({ id: m.id, title: m.title, client: tokens.clientToken, shareWorker: tokens.workerToken });
    idem.current = undefined;
    step("Step 2 of 2: the AI is drafting your terms (usually under a minute on the free models)…");
    // The draft is one AI call that falls through up to three free models; past this limit the milestone
    // page takes over, where the terms appear when ready or can be drafted again.
    const d = await post(`/api/milestones/${m.id}/draft-terms`, { repo: f.repo, stack: "TypeScript, node:test" }, { "x-milestone-token": tokens.clientToken, "idempotency-key": `draft-${m.id}` }, 150_000);
    const err = !d
      ? "The AI took longer than expected. Refresh this page in a minute; if the terms still aren't here, draft them below."
      : !d.ok
        ? `Terms not drafted: ${String(d.body.error ?? "the AI didn't answer")} You can draft them from this page.`
        : undefined;
    window.location.href = `/milestones/${m.id}${err ? `?error=${encodeURIComponent(err)}` : ""}`;
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:py-14">
      <h1 className="text-3xl font-semibold tracking-tight">New milestone</h1>
      <p className="mt-2 text-ink-2">Describe the work. The AI turns it into acceptance criteria and tests; you review and sign them before any money is held.</p>

      <form onSubmit={create} className="mt-8 space-y-5">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">What will be delivered</legend>
          <div className="flex flex-wrap gap-2 text-sm">
            {(
              [
                ["code_pr", "Code, as a GitHub pull request"],
                ["rubric_text", "Text, like docs or copy"],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 ${f.verifier === v ? "border-ink bg-panel" : "border-rule-strong"}`}>
                <input type="radio" name="verifier" value={v} checked={f.verifier === v} onChange={set("verifier")} className="accent-[var(--ink)]" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block text-sm">
          <span className="font-medium">Title</span>
          <input required maxLength={200} className={field} value={f.title} onChange={set("title")} placeholder="Add dark mode to the settings page" />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Brief</span>
          <span className="block text-ink-2">The more specific, the better the tests. Name files, functions, edge cases.</span>
          <textarea required rows={5} className={field} value={f.brief} onChange={set("brief")} placeholder="Add a theme toggle to src/settings.tsx that persists across reloads…" />
        </label>
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Budget (USD)</span>
            <span className="block text-ink-2">At least $10.00; PayPal&apos;s fees come out of it.</span>
            <input required inputMode="decimal" pattern="\d+(\.\d{1,2})?" title="An amount in dollars, like 300.00" className={field} value={f.amount} onChange={set("amount")} placeholder="300.00" />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Worker&apos;s PayPal email</span>
            <input required type="email" className={field} value={f.freelancerEmail} onChange={set("freelancerEmail")} placeholder="sb-…@personal.example.com" />
            <span className="mt-1 block text-ink-2">
              Trying it out?{" "}
              <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => setF({ ...f, freelancerEmail: DEMO_WORKER_EMAIL })}>
                Use the sandbox worker account
              </button>
            </span>
          </label>
        </div>
        {f.verifier === "code_pr" && (
          <label className="block text-sm">
            <span className="font-medium">Repository</span>
            <span className="block text-ink-2">Where the pull request will be opened, as owner/name.</span>
            <input className={field} value={f.repo} onChange={set("repo")} placeholder="TanmayShah29/milestone-demo" pattern="[\w.-]+/[\w.-]+" />
          </label>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Due date</span>
            <span className="block text-ink-2">Optional; 7 days if left empty.</span>
            <input type="date" className={field} value={f.dueDate} onChange={set("dueDate")} />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Follows another milestone</span>
            <span className="block text-ink-2">Optional; for payment in stages.</span>
            <select className={field} value={f.afterMilestoneId} onChange={set("afterMilestoneId")}>
              <option value="">No</option>
              {held.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.title || h.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <p role="alert" className="rounded-md border border-failed/40 bg-failed-field p-3 text-sm text-ink">
            {error}
          </p>
        )}
        <button disabled={!!busy} className="inline-flex items-center gap-2 rounded-md bg-accent px-5 py-3 font-medium text-accent-ink hover:opacity-90 disabled:opacity-60">
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {busy ? busy.text : "Create and draft the terms"}
          {busy && <Elapsed key={busy.since} since={busy.since} />}
        </button>
        <p className="text-xs text-ink-3">Nothing is charged here. Money is held on PayPal only after both sides sign the terms and you fund.</p>
      </form>
    </main>
  );
}
