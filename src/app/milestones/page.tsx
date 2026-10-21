"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MoneyTracker, StatusPill } from "@/components/MoneyTracker";
import { heldLinks } from "@/lib/client/links";
import { STATUS, usd, type MilestoneView, type Role } from "@/lib/client/states";

// The milestones this browser holds links for (there are no accounts: links are the keys).

type Row = { id: string; role: Role; m?: MilestoneView; error?: string };

export default function Milestones() {
  const [rows, setRows] = useState<Row[]>();
  useEffect(() => {
    const held = heldLinks();
    Promise.all(
      held.map(async (h): Promise<Row> => {
        const token = h.client ?? h.worker;
        const role: Role = h.client ? "client" : "worker";
        const r = await fetch(`/api/milestones/${h.id}`, { headers: { "x-milestone-token": token ?? "" } }).catch(() => undefined);
        if (!r?.ok) return { id: h.id, role, error: "Couldn't load" };
        return { id: h.id, role, m: (await r.json()).milestone };
      }),
    ).then(setRows);
  }, []);

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Your milestones</h1>
          <p className="mt-1 text-ink-2">Milestones you created or were invited to, in this browser.</p>
        </div>
        {rows && rows.length > 0 && (
          <Link href="/timeline" className="text-sm text-ink underline">
            See them on the timeline
          </Link>
        )}
      </div>

      {!rows && <p className="mt-10 text-ink-2" aria-busy="true">Loading…</p>}
      {rows && rows.length === 0 && (
        <div className="mt-10 rounded-lg border border-dashed border-rule-strong p-8">
          <p className="font-medium">No milestones here yet.</p>
          <p className="mt-1 text-sm text-ink-2">Create one, open a link someone sent you, or try the guided demo.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/new" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink no-underline">
              New milestone
            </Link>
            <Link href="/demo" className="rounded-md border border-rule-strong px-4 py-2 text-sm no-underline">
              Try the demo
            </Link>
          </div>
        </div>
      )}
      {rows && rows.length > 0 && (
        <ul className="mt-8 divide-y divide-rule border-y border-rule">
          {rows.map(({ id, role, m, error }) => {
            const status = m ? (STATUS[m.state] ?? { label: m.state, tone: "neutral" as const }) : undefined;
            return (
              <li key={id}>
                <Link href={`/milestones/${id}`} className="grid gap-3 py-4 no-underline hover:bg-panel sm:grid-cols-[1fr_auto] sm:items-center sm:px-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{m?.title ?? error ?? "Milestone"}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-2">
                      {status && <StatusPill label={status.label} tone={status.tone} />}
                      <span className="capitalize">You: {role}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-5">
                    {m && (
                      <div className="w-40">
                        <MoneyTracker state={m.state} compact />
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
