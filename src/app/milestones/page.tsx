"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useHeldMilestones } from "@/components/grid/useHeldMilestones";
import { MoneyTracker, StatusPill } from "@/components/MoneyTracker";
import { ShowcaseNotice, ShowcaseToggle } from "@/components/ShowcaseNotice";
import { portfolioRow } from "@/lib/client/ledger";
import { outcomeText, useShowcase, type ShowcaseRunView } from "@/lib/client/showcase";
import { STATUS, cancelledAt, usd } from "@/lib/client/states";

// The milestones this browser holds links for (there are no accounts: links are the keys).
// From the sm breakpoint up they're an AG Grid portfolio; phones keep the cards. A browser with no links
// sees the recent live judge runs instead (read only), so a first-time judge doesn't land on an empty page.

const PortfolioGrid = dynamic(() => import("@/components/grid/PortfolioGrid"), {
  ssr: false,
  loading: () => <p className="mt-8 text-ink-2" aria-busy="true">Loading the table…</p>,
});

const WIDE = "(min-width: 640px)";
const subscribeWide = (cb: () => void) => {
  const q = window.matchMedia(WIDE);
  q.addEventListener("change", cb);
  return () => q.removeEventListener("change", cb);
};
const useWide = () => useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);

export default function Milestones() {
  const rows = useHeldMilestones();
  const wide = useWide();
  const gridRows = useMemo(() => (rows ?? []).flatMap((r) => (r.m ? [portfolioRow(r.m, r.role, r.saveLink)] : [])), [rows]);
  const failed = (rows ?? []).filter((r) => !r.m);
  const runs = useShowcase(!!rows);
  const [view, setView] = useState<"own" | "showcase">("own");
  const showing = !!rows && !!runs?.length && (rows.length === 0 || view === "showcase");
  const showcaseRows = useMemo(() => (runs ?? []).map((r) => ({ ...portfolioRow(r.milestone, "client", false), next: { text: outcomeText(r), yours: false }, prUrl: r.prUrl })), [runs]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{showing ? "Live judge runs" : "Your milestones"}</h1>
          <p className="mt-1 text-ink-2">{showing ? "Real runs on PayPal's sandbox: a hold on a test card, a real pull request, CI on the signed tests, then fixed rules." : "Milestones you created or were invited to, in this browser."}</p>
        </div>
        {(showing || (rows && rows.length > 0)) && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {!showing && !!runs?.length && <ShowcaseToggle onShow={() => setView("showcase")} />}
            <Link href="/timeline" className="text-ink underline">
              See them on the timeline
            </Link>
            <Link href="/ledger" className="text-ink underline">
              See every PayPal call
            </Link>
          </div>
        )}
      </div>

      {(!rows || (rows.length === 0 && !runs)) && <p className="mt-10 text-ink-2" aria-busy="true">Loading…</p>}
      {showing && (
        <div className="mt-8">
          <ShowcaseNotice count={runs!.length} onBack={rows!.length > 0 ? () => setView("own") : undefined} className="mb-4" />
          {wide ? <PortfolioGrid key="showcase" rows={showcaseRows} readOnly /> : <ShowcaseCards runs={runs!} />}
        </div>
      )}
      {!showing && rows && rows.length === 0 && runs && (
        <section className="mt-10 max-w-2xl border-t border-rule pt-8" aria-labelledby="empty-title">
          <h2 id="empty-title" className="text-lg font-semibold text-ink">
            This browser holds no milestones yet
          </h2>
          <p className="mt-2 text-ink-2">
            There are no accounts: each milestone opens from a private link, and the ones you create or open here are listed on this page. The demo walks through a
            full run, from signed terms to a PayPal hold to payment on proof, in the sandbox.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link href="/demo" className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink no-underline hover:opacity-90">
              Try the demo, no login
            </Link>
            <Link href="/new" className="inline-flex items-center justify-center rounded-md border border-rule-strong bg-panel px-4 py-2.5 text-sm font-medium text-ink no-underline hover:bg-paper">
              Create a milestone
            </Link>
          </div>
        </section>
      )}
      {!showing && rows && rows.length > 0 && wide && (
        <div className="mt-8">
          {failed.length > 0 && (
            <p className="mb-4 text-sm text-failed" role="status">
              Couldn&apos;t load{" "}
              {failed.map((r, i) => (
                <span key={r.id}>
                  {i > 0 && ", "}
                  <Link href={`/milestones/${r.id}`} className="text-failed underline">
                    milestone {i + 1}
                  </Link>
                </span>
              ))}
              . Open it to try again.
            </p>
          )}
          <PortfolioGrid key="own" rows={gridRows} />
        </div>
      )}
      {!showing && rows && rows.length > 0 && !wide && (
        <ul className="mt-8 divide-y divide-rule border-y border-rule">
          {rows.map(({ id, role, m, error, saveLink }) => {
            const status = m ? (STATUS[m.state] ?? { label: m.state, tone: "neutral" as const }) : undefined;
            return (
              <li key={id}>
                <Link href={`/milestones/${id}`} className="grid gap-3 py-4 no-underline hover:bg-panel sm:grid-cols-[1fr_auto] sm:items-center sm:px-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{m?.title ?? error ?? "Milestone"}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-2">
                      {status && <StatusPill label={status.label} tone={status.tone} />}
                      <span className="capitalize">You: {role}</span>
                      {saveLink && <span className="rounded bg-held-field px-1.5 py-0.5 text-xs font-medium text-held">Save your link</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-5">
                    {m && (
                      <div className="w-40">
                        <MoneyTracker state={m.state} compact cancelledAt={m.state === "CANCELLED" ? cancelledAt(m) : undefined} />
                      </div>
                    )}
                    <span className="w-24 text-right text-lg font-semibold text-ink">{m ? usd(m.amount_cents) : ""}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

// Phones: the judge runs as cards, with no deal-room link (this browser holds none); the PR is real.
function ShowcaseCards({ runs }: { runs: ShowcaseRunView[] }) {
  return (
    <ul className="divide-y divide-rule border-y border-rule">
      {runs.map((r) => {
        const m = r.milestone;
        const status = STATUS[m.state] ?? { label: m.state, tone: "neutral" as const };
        return (
          <li key={m.id} className="grid gap-3 py-4">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 font-medium text-ink">{m.title}</p>
              <span className="shrink-0 text-lg font-semibold text-ink">{usd(m.amount_cents)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
              <StatusPill label={status.label} tone={status.tone} />
              <span>{outcomeText(r)}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div className="w-40">
                <MoneyTracker state={m.state} compact cancelledAt={m.state === "CANCELLED" ? cancelledAt(m) : undefined} />
              </div>
              {r.prUrl && (
                <a href={r.prUrl} target="_blank" rel="noreferrer" className="text-sm text-ink underline">
                  Pull request
                </a>
              )}
            </div>
            {typeof m.paypal_authorization_id === "string" && <p className="font-mono text-xs text-ink-3">Authorization {m.paypal_authorization_id}</p>}
          </li>
        );
      })}
    </ul>
  );
}
