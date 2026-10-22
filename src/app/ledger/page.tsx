"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo } from "react";
import { useHeldMilestones } from "@/components/grid/useHeldMilestones";
import { buildLedgerRows } from "@/lib/client/ledger";
import type { MilestoneView } from "@/lib/client/states";

// The PayPal money ledger: every money action across the milestones this browser holds, one row per
// attempt, with the idempotency key that made each retry safe. AG Grid renders in the browser only.

const LedgerGrid = dynamic(() => import("@/components/grid/LedgerGrid"), {
  ssr: false,
  loading: () => <p className="mt-8 text-ink-2" aria-busy="true">Loading the ledger…</p>,
});

export default function LedgerPage() {
  const held = useHeldMilestones();
  const loaded = useMemo(() => (held ?? []).filter((h): h is typeof h & { m: MilestoneView } => !!h.m), [held]);
  const rows = useMemo(() => loaded.flatMap((h) => buildLedgerRows({ role: h.role, milestone: h.m, audit: h.audit, actions: h.actions })), [loaded]);
  const views = useMemo(() => loaded.map((h) => h.m), [loaded]);
  const failed = (held ?? []).filter((h) => !h.m).length;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
      <h1 className="text-3xl font-semibold tracking-tight">Ledger</h1>
      <p className="mt-1 max-w-3xl text-ink-2">Every PayPal call this browser&apos;s milestones made, with the idempotency key that makes retries safe. Sandbox.</p>

      {!held && (
        <p className="mt-10 text-ink-2" aria-busy="true">
          Loading…
        </p>
      )}
      {held && held.length === 0 && (
        <section className="mt-10 max-w-2xl border-t border-rule pt-8" aria-labelledby="empty-title">
          <h2 id="empty-title" className="text-lg font-semibold text-ink">
            No PayPal calls yet
          </h2>
          <p className="mt-2 text-ink-2">
            This browser holds no milestones. The ledger fills in as milestones you create or open here hold, capture and pay out money on PayPal.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link href="/demo" className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink no-underline hover:opacity-90">
              Try the demo, no login
            </Link>
            <Link href="/milestones" className="text-sm text-ink underline">
              Your milestones
            </Link>
          </div>
        </section>
      )}
      {held && held.length > 0 && (
        <div className="mt-8">
          {failed > 0 && (
            <p className="mb-4 text-sm text-failed" role="status">
              {failed} milestone{failed === 1 ? "" : "s"} couldn&apos;t load and {failed === 1 ? "is" : "are"} left out.
            </p>
          )}
          <LedgerGrid rows={rows} milestones={views} />
        </div>
      )}
    </main>
  );
}
