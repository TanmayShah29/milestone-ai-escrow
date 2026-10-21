"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { heldLinks, rememberLink, type Held } from "@/lib/client/links";

// Create a milestone: describe the work, and the AI drafts the terms straight away. The client reviews,
// edits and signs them on the milestone page.

const field = "mt-1 w-full rounded-md border border-rule-strong bg-panel px-3 py-2 text-ink placeholder:text-ink-3";

export default function NewMilestone() {
  const [held, setHeld] = useState<Held[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [f, setF] = useState({ title: "", brief: "", amount: "", freelancerEmail: "", repo: "", dueDate: "", afterMilestoneId: "", verifier: "code_pr" as "code_pr" | "rubric_text" });
  useEffect(() => setHeld(heldLinks().filter((h) => h.client)), []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy("Creating the milestone…");
    const r = await fetch("/api/milestones", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) {
      setBusy(undefined);
      return setError(b.error ?? "Couldn't create the milestone. The demo server may be waking up; try again.");
    }
    const id = b.milestone.id as string;
    rememberLink({ id, title: b.milestone.title, client: b.clientToken, worker: b.workerToken });
    setBusy("Drafting your terms with AI… (about 20 seconds)");
    const d = await fetch(`/api/milestones/${id}/draft-terms`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-milestone-token": b.clientToken },
      body: JSON.stringify({ repo: f.repo, stack: "TypeScript, node:test" }),
    }).catch(() => undefined);
    const err = d && !d.ok ? ((await d.json().catch(() => ({}))) as { error?: string }).error : undefined;
    window.location.href = `/milestones/${id}${err ? `?error=${encodeURIComponent(`Terms not drafted: ${err} You can draft them from the milestone page.`)}` : ""}`;
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
            <input required inputMode="decimal" pattern="\d+(\.\d{1,2})?" className={field} value={f.amount} onChange={set("amount")} placeholder="300.00" />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Worker&apos;s PayPal email</span>
            <input required type="email" className={field} value={f.freelancerEmail} onChange={set("freelancerEmail")} placeholder="sb-…@personal.example.com" />
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
          {busy ?? "Create and draft the terms"}
        </button>
        <p className="text-xs text-ink-3">Nothing is charged here. Money is held on PayPal only after both sides sign the terms and you fund.</p>
      </form>
    </main>
  );
}
