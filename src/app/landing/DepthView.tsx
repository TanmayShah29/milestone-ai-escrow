"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type DepthFacts = { tests: number; testFiles: number; attacks: string[]; states: string[]; edges: [string, string][] };

const REPO = "https://github.com/TanmayShah29/milestone-ai-escrow";

const LABEL: Record<string, string> = {
  DRAFT: "Draft",
  AGREED: "Signed",
  FUNDED: "Money held",
  SUBMITTED: "Submitted",
  IN_REVIEW: "In review",
  PASSED: "Passed",
  RELEASED: "Captured",
  PAID_OUT: "Paid",
  OFFERED: "Open bounty",
  CHANGES_REQUESTED: "Changes asked",
  HUMAN_CHECK: "Needs a person",
  CONTESTED: "Objected",
  PAYOUT_FAILED: "Payout returned",
  DISPUTE: "PayPal dispute",
  CANCELLED: "Cancelled",
  LOCKED: "Locked",
  ARBITRATION: "Arbitration",
};
const POS: Record<string, [number, number]> = {
  DRAFT: [70, 50],
  AGREED: [190, 50],
  FUNDED: [310, 50],
  SUBMITTED: [430, 50],
  IN_REVIEW: [550, 50],
  PASSED: [670, 50],
  RELEASED: [790, 50],
  PAID_OUT: [910, 50],
  OFFERED: [250, 150],
  CHANGES_REQUESTED: [430, 150],
  HUMAN_CHECK: [550, 150],
  CONTESTED: [670, 150],
  PAYOUT_FAILED: [790, 150],
  DISPUTE: [910, 150],
  CANCELLED: [310, 250],
  LOCKED: [550, 250],
  ARBITRATION: [670, 250],
};
const HAPPY = ["DRAFT", "AGREED", "FUNDED", "SUBMITTED", "IN_REVIEW", "PASSED", "RELEASED", "PAID_OUT"];
const HW = 52;
const HH = 15;

function edgePath(a: string, b: string) {
  const [x1, y1] = POS[a]!;
  const [x2, y2] = POS[b]!;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.min(HW / Math.abs(dx || 1e-9), HH / Math.abs(dy || 1e-9));
  const sx = x1 + dx * t;
  const sy = y1 + dy * t;
  const ex = x2 - dx * (t + 0.06 * (40 / Math.hypot(dx, dy)));
  const ey = y2 - dy * (t + 0.06 * (40 / Math.hypot(dx, dy)));
  // bend every edge a little to one side, so a pair of opposite moves draws as two separate curves
  const len = Math.hypot(dx, dy);
  const bend = Math.min(18, len / 8);
  const cx = (sx + ex) / 2 + (-dy / len) * bend;
  const cy = (sy + ey) / 2 + (dx / len) * bend;
  return `M${sx.toFixed(1)} ${sy.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
}

function StateGraph({ states, edges }: { states: string[]; edges: [string, string][] }) {
  const [sel, setSel] = useState("IN_REVIEW");
  const [seen, setSeen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && (setSeen(true), io.disconnect()), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // One tab stop for the whole graph; arrow keys move between states in reading order.
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const order = [...states].sort((a, b) => (POS[a]![1] - POS[b]![1]) * 10 + (POS[a]![0] - POS[b]![0]));
    const next = order[(order.indexOf(sel) + d + order.length) % order.length]!;
    setSel(next);
    (e.currentTarget.querySelector(`[data-state="${next}"]`) as SVGGElement | null)?.focus();
  };
  const isHappy = (a: string, b: string) => HAPPY.indexOf(b) === HAPPY.indexOf(a) + 1 && HAPPY.includes(a);
  const out = edges.filter(([a]) => a === sel).map(([, b]) => b);
  const into = edges.filter(([, b]) => b === sel).map(([a]) => a);
  return (
    <div ref={ref}>
      {/* Phones: the same machine as a list, no sideways scroll. */}
      <ul className="space-y-2 sm:hidden">
        {states.map((st) => {
          const next = edges.filter(([a]) => a === st).map(([, b]) => b);
          return (
            <li key={st} className="rounded-md border border-rule bg-paper p-3 text-sm">
              <p className={`font-semibold ${HAPPY.includes(st) ? "text-ink" : "text-ink-2"}`}>{LABEL[st] ?? st}</p>
              <p className="mt-1 text-xs text-ink-2">{next.length ? <>can move to <span className="text-paid">{next.map((n) => LABEL[n]).join(", ")}</span></> : "final: nothing moves out of it"}</p>
            </li>
          );
        })}
      </ul>
      <div className="hidden sm:block">
        <svg viewBox="0 0 980 290" role="group" onKeyDown={onKey} aria-label={`The milestone state machine: ${states.length} states and ${edges.length} allowed moves. The path along the top is the one a passing milestone takes.`}>
          <defs>
            {["base", "out", "in", "happy"].map((k) => (
              <marker key={k} id={`arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 L8 4 L0 8 z" fill={k === "out" ? "var(--paid)" : k === "in" ? "var(--ink-2)" : k === "happy" ? "var(--ink)" : "var(--rule-strong)"} />
              </marker>
            ))}
          </defs>
          {edges.map(([a, b]) => {
            const o = a === sel;
            const i = b === sel;
            const h = isHappy(a, b);
            const kind = o ? "out" : i ? "in" : h ? "happy" : "base";
            return (
              <path
                key={`${a}-${b}`}
                d={edgePath(a, b)}
                fill="none"
                stroke={kind === "out" ? "var(--paid)" : kind === "in" ? "var(--ink-2)" : kind === "happy" ? "var(--ink)" : "var(--rule-strong)"}
                strokeWidth={o || i ? 1.8 : h ? 1.4 : 1}
                opacity={h && !seen ? 0 : o || i || h ? 1 : 0.7}
                markerEnd={`url(#arrow-${kind})`}
                className={h && seen ? "seal-ink" : "transition-[stroke,opacity] duration-[var(--t-state)]"}
                {...(h && seen ? { pathLength: 1, style: { animationDelay: `${HAPPY.indexOf(a) * 110}ms` } } : {})}
              />
            );
          })}
          {states.map((s) => {
            const [x, y] = POS[s] ?? [0, 0];
            const active = s === sel;
            const linked = out.includes(s) || into.includes(s);
            const end = TERMINAL.has(s);
            return (
              <g
                key={s}
                tabIndex={s === sel ? 0 : -1}
                data-state={s}
                role="button"
                aria-pressed={active}
                aria-label={`${LABEL[s] ?? s}: ${edges.filter(([a]) => a === s).length} moves out`}
                onClick={() => setSel(s)}
                onFocus={() => setSel(s)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSel(s)}
                className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[var(--focus)]"
              >
                <rect
                  x={x - HW}
                  y={y - HH}
                  width={HW * 2}
                  height={HH * 2}
                  rx={8}
                  fill={active ? "var(--ink)" : end ? "var(--blocked-field)" : "var(--panel)"}
                  stroke={active ? "var(--ink)" : linked ? "var(--ink-2)" : HAPPY.includes(s) ? "var(--ink)" : "var(--rule-strong)"}
                  strokeWidth={active ? 1.5 : 1}
                  className="transition-[fill,stroke] duration-[var(--t-state)]"
                />
                <text x={x} y={y + 4} textAnchor="middle" fontSize="11.5" fontWeight={active || HAPPY.includes(s) ? 600 : 400} fill={active ? "var(--panel)" : "var(--ink)"} className="pointer-events-none select-none">
                  {LABEL[s] ?? s}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p key={sel} aria-live="polite" className="detail-in mt-3 hidden text-sm text-ink-2 sm:block">
        <span className="font-semibold text-ink">{LABEL[sel]}</span>
        {out.length ? (
          <>
            {" "}
            can only move to <span className="text-paid">{out.map((s) => LABEL[s]).join(", ")}</span>.
          </>
        ) : (
          " is final: nothing moves out of it."
        )}{" "}
        Every other move is refused in code, and every move that happens writes a signed audit row.
      </p>
    </div>
  );
}
const TERMINAL = new Set(["PAYOUT_FAILED", "DISPUTE", "CANCELLED"]);

const OPERATIONS = [
  ["Create the order", "POST /v2/checkout/orders"],
  ["Authorize the hold", "POST /v2/checkout/orders/{id}/authorize"],
  ["Read the order", "GET /v2/checkout/orders/{id}"],
  ["Reauthorize (days 4 to 29)", "POST /v2/payments/authorizations/{id}/reauthorize"],
  ["Void the hold", "POST /v2/payments/authorizations/{id}/void"],
  ["Capture on proof", "POST /v2/payments/authorizations/{id}/capture"],
  ["Pay the worker", "POST /v1/payments/payouts"],
  ["Check the payout", "GET /v1/payments/payouts/{batch_id}"],
  ["Verify every webhook", "POST /v1/notifications/verify-webhook-signature"],
];

const RUNS = [
  { pr: 1, title: "A freelancer's slugify utility", outcome: "All four conditions passed; $23.75 paid out automatically." },
  { pr: 2, title: "The same job, done badly", outcome: "Told the AI reviewer to pass everything. Caught, two tests failed, money held; fixed and paid later." },
  { pr: 3, title: "An AI agent as the contractor", outcome: "Read the terms, opened the PR and submitted it through MCP; $14.25 paid." },
  { pr: 10, title: "An agent hired by another agent", outcome: "First attempt failed the signed tests, so no money moved. Fixed from the verdict; $13.10 paid." },
];

type Key = "states" | "attacks" | "paypal" | "tests" | "runs";

export function DepthView({ facts }: { facts: DepthFacts }) {
  const [k, setK] = useState<Key>("states");
  const tiles: { key: Key; n: number; label: string }[] = [
    { key: "states", n: facts.states.length, label: `states, ${facts.edges.length} allowed moves` },
    { key: "attacks", n: facts.attacks.length, label: "attacks in the threat model" },
    { key: "paypal", n: OPERATIONS.length, label: "PayPal operations" },
    { key: "tests", n: facts.tests, label: "automated tests" },
    { key: "runs", n: RUNS.length, label: "real paid runs, public" },
  ];
  return (
    <section aria-labelledby="depth-h" className="border-y border-rule bg-panel">
      <div className="mx-auto max-w-6xl px-4 py-16">
        <h2 id="depth-h" className="text-3xl font-semibold tracking-tight sm:text-4xl">
          What&apos;s underneath
        </h2>
        <p className="mt-3 max-w-xl text-ink-2">Counted from the code when this page was built. Pick one to open what&apos;s behind it.</p>

        <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-5" role="tablist" aria-label="What's underneath">
          {tiles.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={k === t.key}
              aria-controls="depth-panel"
              onClick={() => setK(t.key)}
              className={`group relative bg-panel p-4 text-left transition-colors duration-[var(--t-state)] last:col-span-2 sm:last:col-span-1 ${k === t.key ? "bg-paper" : "hover:bg-paper"}`}
            >
              <span className="money block text-4xl font-semibold text-ink">{t.n}</span>
              <span className="mt-1 block text-sm text-ink-2">{t.label}</span>
              <span className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-ink transition-transform duration-[var(--t-state)] ease-[var(--ease-out)]" style={{ transform: `scaleX(${k === t.key ? 1 : 0})` }} />
            </button>
          ))}
        </div>

        <div id="depth-panel" role="tabpanel" className="mt-6 min-h-64">
          <div key={k} className="detail-in">
            {k === "states" && (
              <>
                <p className="mb-3 text-sm text-ink-2">The milestone is a state machine. Hover or tap a state to see where it&apos;s allowed to go. The top row is the path a passing milestone takes.</p>
                <StateGraph states={facts.states} edges={facts.edges} />
              </>
            )}
            {k === "attacks" && (
              <>
                <ul className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                  {facts.attacks.map((a, n) => (
                    <li key={a} className="detail-in flex gap-3 border-b border-rule py-2" style={{ animationDelay: `${Math.min(n, 5) * 40}ms` }}>
                      <span className="w-5 shrink-0 font-mono text-xs text-ink-3">{n + 1}</span>
                      <span className="text-ink">{a}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-sm text-ink-2">
                  Each row names its defense and the risk that remains.{" "}
                  <a href={`${REPO}#threat-model`} target="_blank" rel="noreferrer" className="font-medium text-ink underline">
                    The full threat model
                  </a>
                </p>
              </>
            )}
            {k === "paypal" && (
              <>
                <ul className="divide-y divide-rule border-y border-rule text-sm">
                  {OPERATIONS.map(([name, call], n) => (
                    <li key={call} className="detail-in grid gap-1 py-2 sm:grid-cols-[14rem_1fr]" style={{ animationDelay: `${Math.min(n, 5) * 40}ms` }}>
                      <span className="text-ink">{name}</span>
                      <span className="break-all font-mono text-xs text-ink-2">{call}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-sm text-ink-2">Every call that moves money carries a PayPal-Request-Id made from the milestone, the action and the attempt, and every PayPal id is stored on the milestone. Only code calls these; none is a tool the AI can use.</p>
              </>
            )}
            {k === "tests" && (
              <div className="max-w-2xl text-sm text-ink-2">
                <p>
                  <span className="font-semibold text-ink">{facts.tests} tests</span> in {facts.testFiles} files cover the money flow, the state machine, webhooks, the injection scan, the test sandbox, the proof chain and the API.
                </p>
                <p className="mt-3">
                  And the contract&apos;s own tests are tested: every AI-written test must fail against empty code before anyone can sign, and a second AI tries to fake its way past them.
                </p>
                <a href={REPO} target="_blank" rel="noreferrer" className="mt-4 inline-block font-medium text-ink underline">
                  Read the code
                </a>
              </div>
            )}
            {k === "runs" && (
              <>
                <ul className="divide-y divide-rule border-y border-rule">
                  {RUNS.map((r) => (
                    <li key={r.pr} className="grid gap-1 py-3 sm:grid-cols-[16rem_1fr_auto] sm:items-baseline sm:gap-6">
                      <p className="font-medium text-ink">{r.title}</p>
                      <p className="text-sm text-ink-2">{r.outcome}</p>
                      <a href={`https://github.com/TanmayShah29/milestone-demo/pull/${r.pr}`} target="_blank" rel="noreferrer" className="text-sm text-ink underline">
                        Pull request #{r.pr}
                      </a>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-sm text-ink-2">
                  And measured against an AI-only approver on twelve pull requests, including where Milestone gets it wrong:{" "}
                  <Link href="/bench" className="font-medium text-ink underline">
                    Proof Bench
                  </Link>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
