"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { writeDemo } from "@/lib/client/demo";
import { rememberLink } from "@/lib/client/links";

type Seeded = { id: string; title: string; client: string; worker: string; story: "paid" | "caught" | "fund" };

export default function DemoPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function start() {
    setBusy(true);
    setError(undefined);
    const r = await fetch("/api/demo", { method: "POST" }).catch(() => undefined);
    const b = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) {
      setBusy(false);
      return setError(b.error ?? "The demo server didn't answer. It may be waking up; try again in a moment.");
    }
    const ms = b.milestones as Seeded[];
    for (const m of ms) rememberLink({ id: m.id, title: m.title, client: m.client, worker: m.worker });
    writeDemo({ milestones: ms.map(({ id, title, story }) => ({ id, title, story })) });
    window.location.href = `/milestones/${ms.find((m) => m.story === "fund")!.id}`;
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-14 sm:py-20">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Try Milestone in about a minute</h1>
      <p className="mt-4 text-lg text-ink-2">We&apos;ll set up a small project with three milestones, each showing one part of the idea. You&apos;ll be both the client and the worker; switch sides at the top of each milestone.</p>
      <ul className="mt-6 space-y-3 text-ink">
        <li><span className="font-semibold">Hold real money.</span> Fund a milestone with PayPal&apos;s sandbox test card and watch the hold appear. No login, no real money.</li>
        <li><span className="font-semibold">See proof pay out.</span> A finished milestone with its verdict, proof trail and sealed terms.</li>
        <li><span className="font-semibold">Watch a trick fail.</span> A pull request that told the AI reviewer to pass everything, caught by the rules.</li>
      </ul>
      <button onClick={start} disabled={busy} className="mt-8 inline-flex items-center gap-2 rounded-md bg-accent px-5 py-3 font-medium text-accent-ink hover:opacity-90 disabled:opacity-60">
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        {busy ? "Setting up your project… (the demo server can take up to a minute to wake)" : "Start the demo"}
      </button>
      {error && (
        <p role="alert" className="mt-4 rounded-md border border-failed/40 bg-failed-field p-3 text-sm text-ink">
          {error}
        </p>
      )}
      <p className="mt-10 text-sm text-ink-3">Everything runs on PayPal&apos;s sandbox. The finished milestones replay real runs; their pull requests are real and public on GitHub.</p>
    </main>
  );
}
