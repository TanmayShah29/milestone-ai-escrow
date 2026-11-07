"use client";

import { useEffect, useRef, useState } from "react";

// Act 2: one $25.00 payment, followed through the five steps as the visitor scrolls. The stage stays put
// while the steps scroll past it; every call and file named here is the real one (src/lib/money/flow.ts,
// claims.ts requestIdFor, the milestone-demo workflow). Figures are from milestone-demo PR #1.

const REPO = "https://github.com/TanmayShah29/milestone-ai-escrow/blob/main/";
const HASH = "48a51380573e1d02a1c66c14a600c34041a3c6823275d0a3ec9cc1deefab03d1";

type At = 0 | 1 | 2; // client's card, PayPal hold, worker's PayPal
type Step = {
  name: string;
  title: string;
  text: string;
  at: At;
  runs: string[];
  guard: { label: string; href: string };
  ai: string | null; // what the AI does at this step, or null when it does nothing
  rules: string;
};

const STEPS: Step[] = [
  {
    name: "Agree",
    title: "Agree on what done means",
    text: "The AI turns the brief into criteria and writes a test for each one code can check. A second AI writes fake code to cheat them, and any test it fools is rewritten. Then both sides sign the terms' fingerprint.",
    at: 0,
    runs: ["sha256(terms)", `→ ${HASH.slice(0, 16)}…`, "signed by client and worker"],
    guard: { label: "src/lib/contract/terms.ts", href: `${REPO}src/lib/contract/terms.ts` },
    ai: "Writes the tests, then tries to cheat them",
    rules: "Locks the terms by fingerprint",
  },
  {
    name: "Fund",
    title: "Hold the money on PayPal",
    text: "The client approves a PayPal authorization hold for $25.00, with a PayPal account or a card. Nothing is charged yet. The worker can see the money exists before starting.",
    at: 1,
    runs: ["POST /v2/checkout/orders", "POST /v2/checkout/orders/{id}/authorize", "PayPal-Request-Id: ms_{id}_authorize_1"],
    guard: { label: "src/lib/money/flow.ts", href: `${REPO}src/lib/money/flow.ts` },
    ai: null,
    rules: "Places the hold, with one idempotency key",
  },
  {
    name: "Deliver",
    title: "Deliver a pull request",
    text: "The worker, a person or an AI agent, opens a pull request that cites the fingerprint. CI throws away any tests the PR brought and runs the signed ones, one check per criterion.",
    at: 1,
    runs: [`Milestone-Terms: ${HASH.slice(0, 6)}…${HASH.slice(-4)}`, "acceptance (C1)  acceptance (C2)", "acceptance (C3)  contract"],
    guard: { label: "milestone-demo/.github/workflows/milestone.yml", href: "https://github.com/TanmayShah29/milestone-demo/blob/main/.github/workflows/milestone.yml" },
    ai: null,
    rules: "Runs only the signed tests",
  },
  {
    name: "Verify",
    title: "Tests decide. The AI only advises",
    text: "The signed tests decide every criterion code can check. The AI reads only what's left, here the README. A separate scan, not the model, looks for text aimed at the reviewer.",
    at: 1,
    runs: ["C1 C2 C3 → CI test: passed", "C4 → AI review: passed (recommendation)", "scanForInjection(diff) → nothing found"],
    guard: { label: "src/lib/review/policy.ts", href: `${REPO}src/lib/review/policy.ts` },
    ai: "Reviews the README only. Its answer is a recommendation",
    rules: "Decides: every must-have passed",
  },
  {
    name: "Release",
    title: "Release by rule, not by a person",
    text: "After a short objection window, code captures the hold and PayPal pays the worker, minus fees. This run took only the 5% platform fee; Milestone now also passes on PayPal's checkout and payout fees, so $25 pays about $21.94. If a must-have had failed, the money would still be on hold.",
    at: 2,
    runs: ["POST /v2/payments/authorizations/{id}/capture", "POST /v1/payments/payouts", "$25.00 captured → $23.75 to the worker (5% fee)"],
    guard: { label: "src/lib/money/flow.ts", href: `${REPO}src/lib/money/flow.ts` },
    ai: null,
    rules: "Captures, then pays out",
  },
];

const STATIONS = [
  { label: "Client's card", note: ["Not charged", "Not charged", "Not charged", "Not charged", "Charged $25.00"] },
  { label: "PayPal hold", note: ["Nothing yet", "$25.00 authorized", "$25.00 held", "$25.00 held", "Captured"] },
  { label: "Worker's PayPal", note: ["Nothing yet", "Nothing yet", "Nothing yet", "Nothing yet", "$23.75 paid"] },
];

/** The AI on one side of a "no path to money" line, the fixed rules on the money's side. */
function Fence({ s, k: i }: { s: Step; k: number }) {
  return (
      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2 text-xs sm:gap-3">
        <div className={`rounded-md border p-2.5 transition-colors duration-[var(--t-state)] sm:p-3 ${s.ai ? "border-ink bg-panel" : "border-rule bg-paper"}`}>
          <p className={`font-semibold ${s.ai ? "text-ink" : "text-ink-3"}`}>AI</p>
          <p key={`ai-${i}`} className={`detail-in mt-1 ${s.ai ? "text-ink-2" : "text-ink-3"}`}>
            {s.ai ?? "Not involved in this step"}
          </p>
        </div>
        <div className="flex flex-col items-center justify-center gap-1 px-0.5">
          <span className="w-px flex-1 border-l border-dashed border-failed" aria-hidden="true" />
          <span className="text-center text-[10px] font-medium uppercase leading-tight tracking-wide text-failed">
            No path
            <br />
            to money
          </span>
          <span className="w-px flex-1 border-l border-dashed border-failed" aria-hidden="true" />
        </div>
        <div className="rounded-md border border-paid/50 bg-paid-field p-2.5 sm:p-3">
          <p className="font-semibold text-paid">Fixed rules (code)</p>
          <p key={`r-${i}`} className="detail-in mt-1 text-ink">
            {s.rules}
          </p>
        </div>
      </div>
  );
}

/** The money rail and who acts at this step. */
function Stage({ i }: { i: number }) {
  const s = STEPS[i]!;
  return (
    <div className="flex w-full flex-col gap-4 rounded-xl border border-rule-strong bg-panel p-4 shadow-[var(--shadow-card)] sm:p-6">
      <div className="overflow-hidden rounded-lg bg-paper px-3 pb-3 pt-5 sm:px-5">
        <div className="relative mx-[16.66%] h-9">
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-rule-strong" />
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 origin-left bg-paid transition-transform duration-[var(--t-travel)] ease-[var(--ease-out)]" style={{ transform: `scaleX(${s.at / 2})` }} />
          {[0, 1, 2].map((k) => (
            <span key={k} className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border transition-colors duration-[var(--t-state)] ${k <= s.at ? "border-paid bg-paid" : "border-rule-strong bg-panel"}`} style={{ left: `${k * 50}%` }} />
          ))}
          <div className="absolute inset-0 transition-transform duration-[var(--t-travel)] ease-[var(--ease-out)]" style={{ transform: `translateX(${s.at * 50}%)` }}>
            <span
              className={`money absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-3 py-1 font-mono text-sm font-semibold shadow-sm transition-colors duration-[var(--t-state)] ${
                s.at === 2 ? "border-paid bg-paid text-panel" : s.at === 1 ? "border-held bg-held-field text-held" : "border-ink bg-panel text-ink"
              }`}
            >
              {s.at === 2 ? "$23.75" : "$25.00"}
            </span>
          </div>
        </div>
        <ol className="mt-3 grid grid-cols-3 text-center text-xs">
          {STATIONS.map((st, k) => (
            <li key={st.label} className={k === s.at ? "font-semibold text-ink" : "text-ink-2"}>
              {st.label}
              <span key={`${k}-${i}`} className={`detail-in block font-normal ${k === s.at ? (k === 1 ? "text-held" : k === 2 ? "text-paid" : "text-ink-2") : "text-ink-3"}`}>
                {st.note[i]}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <Fence s={s} k={i} />
    </div>
  );
}

const STEP_MS = 4500;

// One screen, not a long scroll: five step tabs that advance on their own while the section is on screen,
// and stop for good once the visitor picks one. Reduced motion never advances on its own.
export function FollowTheMoney() {
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(!!e?.isIntersecting), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!auto || !inView || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = window.setInterval(() => setI((k) => (k + 1) % STEPS.length), STEP_MS);
    return () => window.clearInterval(t);
  }, [auto, inView]);

  const pick = (k: number) => {
    setAuto(false);
    setI(k);
  };
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + STEPS.length) % STEPS.length;
    pick(next);
    document.getElementById(`step-tab-${next}`)?.focus();
  };
  const s = STEPS[i]!;

  return (
    <section ref={ref} aria-labelledby="follow-h" className="border-y border-rule bg-paper">
      <div className="mx-auto max-w-6xl px-4 py-16">
        <h2 id="follow-h" className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Follow the $25
        </h2>
        <p className="mt-3 max-w-xl text-ink-2">One real payment from milestone-demo PR #1, from the client&apos;s card to the worker, in five steps.</p>

        <div role="tablist" aria-label="Steps" onKeyDown={onKey} className="mt-8 grid grid-cols-5 gap-1.5 sm:gap-2">
          {STEPS.map((x, k) => (
            <button
              key={x.name}
              id={`step-tab-${k}`}
              role="tab"
              type="button"
              aria-selected={k === i}
              aria-controls="step-panel"
              tabIndex={k === i ? 0 : -1}
              onClick={() => pick(k)}
              className={`relative min-h-11 overflow-hidden rounded-md border px-1 text-xs font-medium transition-colors duration-[var(--t-tap)] sm:text-sm ${k === i ? "border-ink bg-panel text-ink" : k < i ? "border-paid/40 bg-panel text-paid" : "border-rule-strong bg-panel text-ink-2 hover:text-ink"}`}
            >
              <span className="hidden sm:inline">{k + 1}. </span>
              {x.name}
              {k === i && auto && inView && <span key={`p-${i}`} aria-hidden="true" className="step-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-ink" style={{ animationDuration: `${STEP_MS}ms` }} />}
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-10">
          <div id="step-panel" role="tabpanel" aria-labelledby={`step-tab-${i}`} key={i} className="detail-in">
            <h3 className="text-2xl font-semibold tracking-tight text-ink">{s.title}</h3>
            <p className="mt-2 max-w-md leading-relaxed text-ink-2">{s.text}</p>
            <div className="mt-4 rounded-md border border-rule bg-panel p-3">
              <p className="text-xs font-medium text-ink-2">What runs</p>
              {s.runs.map((line) => (
                <p key={line} className="mt-1 break-all font-mono text-[11px] leading-relaxed text-ink sm:text-xs">
                  {line}
                </p>
              ))}
              <a href={s.guard.href} target="_blank" rel="noreferrer" className="mt-2 inline-block break-all text-[11px] text-ink-2 underline">
                Enforced in {s.guard.label}
              </a>
            </div>
          </div>
          <div aria-live="polite">
            <p className="sr-only">
              Step {i + 1} of 5, {s.name}. The money is at: {STATIONS[s.at]!.label}.
            </p>
            <Stage i={i} />
          </div>
        </div>
      </div>
    </section>
  );
}
