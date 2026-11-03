"use client";

import { useEffect, useState } from "react";
import type { ActionRow, AuditRow } from "@/lib/client/ledger";
import type { MilestoneView } from "@/lib/client/states";

// The public showcase of finished judge live runs (GET /api/showcase), for browsers that hold no
// milestone links. Read only: nothing here carries a token, and the pages that show it offer no actions.

export type ShowcaseRunView = {
  kind: "honest" | "cheat";
  outcome: "paid" | "caught" | "person";
  prUrl: string | null;
  worker: string;
  milestone: MilestoneView;
  audit: AuditRow[];
  actions: ActionRow[];
  timeline: { tasks: unknown[]; dependencies: unknown[]; warnings: string[] };
};

let inflight: Promise<ShowcaseRunView[]> | undefined;

/** One request per page load, shared by every caller. An error reads as "no showcase". */
export function fetchShowcase(): Promise<ShowcaseRunView[]> {
  inflight ??= fetch("/api/showcase")
    .then((r) => (r.ok ? (r.json() as Promise<{ runs: ShowcaseRunView[] }>) : { runs: [] }))
    .then((b) => b.runs ?? [])
    .catch(() => []);
  return inflight;
}

/** The showcase runs once `enabled` (undefined while loading or not asked for). */
export function useShowcase(enabled: boolean): ShowcaseRunView[] | undefined {
  const [runs, setRuns] = useState<ShowcaseRunView[]>();
  useEffect(() => {
    if (!enabled || runs) return;
    let live = true;
    fetchShowcase().then((r) => live && setRuns(r));
    return () => {
      live = false;
    };
  }, [enabled, runs]);
  return enabled ? runs : undefined;
}

/** What a run proved, in a few words (the showcase's "next action" column). */
export function outcomeText(run: Pick<ShowcaseRunView, "outcome" | "milestone">): string {
  const usd = (c: unknown) => (typeof c === "number" ? `$${(c / 100).toFixed(2)}` : "");
  if (run.outcome === "paid") return `Tests passed: PayPal paid the worker ${usd(run.milestone.payout_cents)}`;
  if (run.outcome === "caught") return run.milestone.state === "CANCELLED" ? "Cheat caught: not paid, and the hold was voided" : "Cheat caught: not paid, money still held";
  return "Sent to a person to decide";
}
