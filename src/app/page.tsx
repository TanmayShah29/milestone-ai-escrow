"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { heldLinks, rememberLink, type Held } from "@/lib/client/links";

export default function Home() {
  const [rows, setRows] = useState<Held[]>([]);
  const [error, setError] = useState<string>();
  const [form, setForm] = useState({
    title: "Add dark mode to settings page",
    amount: "300.00",
    freelancerEmail: "sb-puo47p53461265@personal.example.com",
    brief: "",
    dueDate: "",
    afterMilestoneId: "",
  });

  useEffect(() => setRows(heldLinks()), []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const r = await fetch("/api/milestones", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    const b = await r.json();
    if (!r.ok) return setError(b.error);
    rememberLink({ id: b.milestone.id, title: b.milestone.title, client: b.clientToken, worker: b.workerToken });
    window.location.href = `/milestones/${b.milestone.id}`;
  }

  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-8 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Milestone</h1>
        <p className="text-sm opacity-70">Pay-on-proof: money is held on PayPal and released only when the work is proven.</p>
      </header>

      <form onSubmit={create} className="space-y-3 rounded-lg border border-black/10 dark:border-white/15 p-4">
        <h2 className="font-medium">New milestone</h2>
        {(["title", "amount", "freelancerEmail", "brief"] as const).map((k) => (
          <label key={k} className="block text-sm">
            <span className="opacity-70">{k}</span>
            <input
              className="mt-1 w-full rounded border border-black/15 dark:border-white/20 bg-transparent px-2 py-1"
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
            />
          </label>
        ))}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="opacity-70">due date (optional, default 7 days)</span>
            <input type="date" className="mt-1 w-full rounded border border-black/15 dark:border-white/20 bg-transparent px-2 py-1" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="opacity-70">follows milestone (payment tranche)</span>
            <select className="mt-1 w-full rounded border border-black/15 dark:border-white/20 bg-transparent px-2 py-1" value={form.afterMilestoneId} onChange={(e) => setForm({ ...form, afterMilestoneId: e.target.value })}>
              <option value="">none</option>
              {rows.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title || m.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="rounded bg-blue-600 px-3 py-1.5 text-white">Create</button>
      </form>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="font-medium">Your milestones</h2>
          {rows.length > 0 && (
            <Link href="/timeline" className="text-sm underline">
              Timeline (Gantt) →
            </Link>
          )}
        </div>
        {rows.length === 0 && <p className="text-sm opacity-60">Milestones you create or are invited to appear here.</p>}
        <ul className="divide-y divide-black/10 dark:divide-white/10">
          {rows.map((m) => (
            <li key={m.id} className="py-2 flex justify-between gap-4">
              <Link href={`/milestones/${m.id}`} className="underline truncate">
                {m.title || "Untitled milestone"}
              </Link>
              <span className="text-sm opacity-70 whitespace-nowrap">{[m.client && "client", m.worker && "worker"].filter(Boolean).join(" + ")}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
