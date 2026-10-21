"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { readDemo, writeDemo, type DemoState, type DemoStory } from "@/lib/client/demo";

// A short guided tour for judges: three milestones, each showing one part of the idea, then the timeline.
// Non-modal and dismissible; it never blocks the page.

const STEPS: { story: DemoStory | "timeline"; title: string; body: string }[] = [
  { story: "fund", title: "Place a real sandbox hold", body: "This milestone's terms are signed. Fund it with the sandbox test card: PayPal's sandbox places a real hold (test money only), and nothing is captured until the work passes." },
  { story: "paid", title: "See proof pay out", body: "A finished milestone: CI ran the signed tests, the AI reviewed only the README, and fixed rules released the money. The pull request and CI logs are real; the PayPal ids shown here are illustrative." },
  { story: "caught", title: "Watch a trick fail", body: "This pull request told the AI reviewer to pass everything. The rules caught it, CI failed two tests, and the money is still held." },
  { story: "timeline", title: "See the money schedule", body: "The timeline shows each phase gated by the money: work waits for the hold, payout waits for review." },
];

export function DemoTour({ currentId, state, onTimeline = false }: { currentId?: string; state?: string; onTimeline?: boolean }) {
  const [demo, setDemo] = useState<DemoState>();
  useEffect(() => setDemo(readDemo()), []);
  if (!demo || demo.dismissed) return null;
  const idFor = (story: DemoStory) => demo.milestones.find((m) => m.story === story)?.id;
  const current = onTimeline ? 3 : STEPS.findIndex((s) => s.story !== "timeline" && idFor(s.story) === currentId);
  if (current < 0) return null;
  const href = (i: number) => (STEPS[i]!.story === "timeline" ? "/timeline" : `/milestones/${idFor(STEPS[i]!.story as DemoStory)}`);
  const base = STEPS[current]!;
  // Once the judge has funded, step one confirms what happened instead of asking again.
  const step =
    base.story === "fund" && state && state !== "AGREED"
      ? { ...base, title: "Hold placed", body: "PayPal's sandbox now holds the money; nothing is captured. Switch to Worker at the top to see what they see, or move on." }
      : base;

  const dismiss = () => {
    writeDemo({ ...demo, dismissed: true });
    setDemo({ ...demo, dismissed: true });
  };

  return (
    <aside aria-label="Guided demo" className="fixed inset-x-3 bottom-3 z-50 rounded-lg border border-ink/30 bg-panel p-4 shadow-[0_2px_4px_rgb(19_35_58/0.08),0_16px_40px_-12px_rgb(19_35_58/0.35)] sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-96">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-ink-2">
          Guided demo · {current + 1} of {STEPS.length}
        </p>
        <button
          onClick={dismiss}
          className="-m-1 rounded p-1 text-ink-2 hover:text-ink"
          aria-label="Close the guided demo"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <h2 className="mt-1 font-semibold text-ink">{step.title}</h2>
      <p className="mt-1 text-sm text-ink-2">{step.body}</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <ol className="flex gap-1.5" aria-hidden="true">
          {STEPS.map((s, i) => (
            <li key={s.story} className={`h-1.5 w-6 rounded-full ${i <= current ? "bg-ink" : "bg-rule-strong"}`} />
          ))}
        </ol>
        {current < STEPS.length - 1 ? (
          <Link href={href(current + 1)} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-ink no-underline hover:opacity-90">
            Next: {STEPS[current + 1]!.title.toLowerCase()}
          </Link>
        ) : (
          <button onClick={dismiss} className="rounded-md border border-rule-strong px-3 py-1.5 text-sm hover:bg-paper">
            Done
          </button>
        )}
      </div>
    </aside>
  );
}
