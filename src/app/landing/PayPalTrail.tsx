"use client";

import { useEffect, useRef, useState } from "react";

// Real PayPal sandbox ids from two live judge runs (GET /api/showcase, Nov 3 and Nov 4, 2026): what PayPal
// actually returned, in order. The honest run goes all the way to a payout; the cheat stops at the hold.

type Step = { label: string; id: string; note?: string };
const RUNS: { title: string; pr: number; outcome: string; tone: "paid" | "held"; steps: Step[] }[] = [
  {
    title: "Honest worker",
    pr: 14,
    outcome: "$10.39 to the worker: $12.00 less PayPal's $0.80 fee, the 5% platform fee ($0.60) and the payout fee ($0.21)",
    tone: "paid",
    steps: [
      { label: "Order", id: "6A3836853A7419103" },
      { label: "Authorization", id: "4RF62367MB482750W", note: "$12.00 held" },
      { label: "Capture", id: "2GD41889TW7389829", note: "tests passed" },
      { label: "Payout batch", id: "H4T7BHLNYS6MG", note: "$10.39" },
    ],
  },
  {
    title: "Cheating worker",
    pr: 16,
    outcome: "Never captured: the signed tests failed",
    tone: "held",
    steps: [
      { label: "Order", id: "3UC49691KX5439707" },
      { label: "Authorization", id: "7KE6142615813161D", note: "$12.00 held" },
    ],
  },
];

export function PayPalTrail() {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && (setSeen(true), io.disconnect()), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className="mt-6 rounded-xl border border-rule bg-panel p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">What PayPal returned on two real runs</p>
        <a href="/ledger" className="text-sm text-ink-2 underline">
          Every PayPal call, in the ledger
        </a>
      </div>
      <div className="mt-3 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        {RUNS.map((r, ri) => (
          <div key={r.pr}>
            <p className="text-xs text-ink-2">
              <span className="font-semibold text-ink">{r.title}</span> ·{" "}
              <a href={`https://github.com/TanmayShah29/milestone-demo/pull/${r.pr}`} target="_blank" rel="noreferrer" className="underline">
                PR #{r.pr}
              </a>
            </p>
            <ol className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-2">
              {r.steps.map((s, k) => (
                <li key={s.id} className={`flex items-center gap-1.5 ${seen ? "detail-in" : "opacity-0"}`} style={seen ? { animationDelay: `${(ri * 4 + k) * 120}ms` } : undefined}>
                  {k > 0 && (
                    <span className="text-ink-3" aria-hidden="true">
                      →
                    </span>
                  )}
                  <span className="rounded-md border border-rule-strong bg-paper px-2 py-1">
                    <span className="block text-[10px] text-ink-3">
                      {s.label}
                      {s.note ? ` · ${s.note}` : ""}
                    </span>
                    <span className="block font-mono text-[11px] text-ink">{s.id}</span>
                  </span>
                </li>
              ))}
              <li className={`text-xs font-medium ${r.tone === "paid" ? "text-paid" : "text-held"} ${seen ? "detail-in" : "opacity-0"}`} style={seen ? { animationDelay: `${(ri * 4 + r.steps.length) * 120}ms` } : undefined}>
                {r.outcome}
              </li>
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}
