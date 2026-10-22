"use client";

import Link from "next/link";
import type { CustomCellRendererProps } from "ag-grid-react";
import { StatusPill } from "@/components/MoneyTracker";
import { HOLD_URGENT_DAYS, STATUS_COPY, type LedgerRow, type PortfolioRow } from "@/lib/client/ledger";
import { usd } from "@/lib/client/states";

// Cell renderers shared by the ledger and the portfolio grid. Every status carries words, never colour alone.

export function LedgerStatusCell({ data }: CustomCellRendererProps<LedgerRow>) {
  if (!data?.status) return null;
  const s = STATUS_COPY[data.status];
  return <StatusPill label={s.label} tone={s.tone} />;
}

export function AttemptCell({ data, node }: CustomCellRendererProps<LedgerRow>) {
  if (!data || node.rowPinned) return null;
  if (data.attempt == null) return <span className="text-ink-3">—</span>;
  return (
    <span className={data.attempt > 1 ? "font-semibold text-ink" : "text-ink-2"}>
      {data.attempt}
      {data.attempt > 1 && <span className="sr-only"> (a retry with a new key)</span>}
    </span>
  );
}

export function attemptTooltip(row: LedgerRow | undefined): string | undefined {
  if (!row || row.key.startsWith("total:")) return undefined;
  if (row.attempt == null || !row.requestId) return "Recorded in the proof trail, not by the retry engine, so there is no attempt key.";
  const why =
    row.status === "failed"
      ? "PayPal refused it, so the next attempt gets a new key."
      : row.status === "unknown"
        ? "The answer was lost; a sync re-reads PayPal before any retry."
        : "Resending with the same key can't run the call twice.";
  return `PayPal-Request-Id ${row.requestId}: attempt ${row.attempt}, the idempotency key. ${why}`;
}

export function MonoCell({ value, node }: CustomCellRendererProps<LedgerRow, string | null>) {
  if (node.rowPinned) return null;
  if (!value) return <span className="text-ink-3">—</span>;
  return <span className="font-mono text-[13px] text-ink">{value}</span>;
}

export function LedgerMilestoneCell({ data }: CustomCellRendererProps<LedgerRow>) {
  if (!data?.milestoneId) return null;
  return (
    <Link href={`/milestones/${data.milestoneId}`} tabIndex={-1} className="text-ink underline decoration-rule-strong hover:decoration-ink">
      {data.milestone}
    </Link>
  );
}

/** The title links to the deal room; a client link not yet saved carries the "Save your link" reminder. */
export function TitleCell({ data }: CustomCellRendererProps<PortfolioRow>) {
  if (!data) return null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Link href={`/milestones/${data.id}`} tabIndex={-1} className="min-w-0 truncate font-medium text-ink underline decoration-rule-strong hover:decoration-ink">
        {data.title}
      </Link>
      {data.saveLink && <span className="shrink-0 rounded bg-held-field px-1.5 py-0.5 text-xs font-medium text-held">Save your link</span>}
    </span>
  );
}

export function PortfolioStatusCell({ data }: CustomCellRendererProps<PortfolioRow>) {
  if (!data) return null;
  return <StatusPill label={data.status} tone={data.tone} />;
}

export function MoneyNowCell({ data }: CustomCellRendererProps<PortfolioRow>) {
  if (!data) return null;
  const { word, cents, tone } = data.money;
  if (word === "None") return <span className="text-ink-3">None yet</span>;
  const cls = tone === "held" ? "text-held" : tone === "paid" ? "text-paid" : tone === "failed" ? "text-failed" : "text-ink";
  return (
    <span>
      <span className={`font-medium ${cls}`}>{word}</span> <span className="text-ink">{usd(cents)}</span>
    </span>
  );
}

export function HoldCell({ data }: CustomCellRendererProps<PortfolioRow>) {
  if (!data) return null;
  const d = data.holdDays;
  if (d == null) return <span className="text-ink-3">No live hold</span>;
  const urgent = d < HOLD_URGENT_DAYS;
  const text = d === 0 ? "Expires today" : `${d} day${d === 1 ? "" : "s"} left`;
  return <span className={urgent ? "font-semibold text-failed" : "text-ink"}>{urgent ? `${text}, act soon` : text}</span>;
}

export function NextActionCell({ data }: CustomCellRendererProps<PortfolioRow>) {
  if (!data) return null;
  return data.next.yours ? (
    <span className="font-semibold text-ink">
      <span className="mr-1.5 rounded bg-ink px-1.5 py-0.5 text-xs font-semibold text-panel">Your move</span>
      {data.next.text}
    </span>
  ) : (
    <span className="text-ink-2">{data.next.text}</span>
  );
}
