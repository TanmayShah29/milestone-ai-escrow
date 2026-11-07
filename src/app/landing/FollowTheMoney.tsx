"use client";

import { useEffect, useRef, useState } from "react";
import { GuillocheSeal } from "@/components/GuillocheSeal";

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

function Stage({ i }: { i: number }) {
  const s = STEPS[i]!;
  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-rule-strong bg-panel p-3 shadow-[var(--shadow-card)] sm:gap-4 sm:p-6">
      {/* Step dots */}
      <ol className="hidden items-center gap-2 sm:flex" aria-hidden="true">
        {STEPS.map((x, k) => (
          <li key={x.name} className="flex flex-1 items-center gap-2 last:flex-none">
            <span className={`text-xs font-medium transition-colors duration-[var(--t-state)] ${k === i ? "text-ink" : k < i ? "text-paid" : "text-ink-3"}`}>{x.name}</span>
            {k < STEPS.length - 1 && (
              <span className="relative h-px flex-1 bg-rule-strong">
                <span className="absolute inset-0 origin-left bg-paid transition-transform duration-[var(--t-travel)] ease-[var(--ease-out)]" style={{ transform: `scaleX(${k < i ? 1 : 0})` }} />
              </span>
            )}
          </li>
        ))}
      </ol>

      {/* The money rail */}
      <div className="overflow-hidden rounded-lg bg-paper px-3 pb-2.5 pt-4 sm:px-5 sm:pb-3 sm:pt-5">
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

      {/* Who acts: the AI on one side of the fence, the rules on the money's side (inline per step on phones) */}
      <div className="hidden lg:block">
        <Fence s={s} k={i} />
      </div>

      {/* What actually runs */}
      <div className="hidden gap-4 lg:flex">
        <div className="min-w-0 flex-1 rounded-md border border-rule bg-paper p-3">
          <p className="text-xs font-medium text-ink-2">What runs</p>
          <div key={`run-${i}`} className="mt-1.5 space-y-1">
            {s.runs.map((line) => (
              <p key={line} className="detail-in break-all font-mono text-[11px] leading-relaxed text-ink sm:text-xs">
                {line}
              </p>
            ))}
          </div>
          <a href={s.guard.href} target="_blank" rel="noreferrer" className="mt-2 inline-block break-all text-[11px] text-ink-2 underline">
            Enforced in {s.guard.label}
          </a>
        </div>
        <div className="hidden shrink-0 flex-col items-center justify-center sm:flex">
          <GuillocheSeal hash={HASH} sealed size={96} label={false} />
          <p className="mt-1 font-mono text-[10px] text-ink-3">
            {HASH.slice(0, 6)}…{HASH.slice(-4)}
          </p>
        </div>
      </div>
    </div>
  );
}

export function FollowTheMoney() {
  const [i, setI] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setI(Number((e.target as HTMLElement).dataset.step));
      },
      // On phones the pinned stage covers the top of the screen, so a step counts once its text is below it.
      { rootMargin: window.matchMedia("(min-width: 1024px)").matches ? "-45% 0px -45% 0px" : "-38% 0px -57% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <section aria-labelledby="follow-h" className="border-y border-rule bg-paper">
      <div className="mx-auto max-w-6xl px-4 pt-16">
        <h2 id="follow-h" className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Follow the $25
        </h2>
        <p className="mt-3 max-w-xl text-ink-2">One real payment from milestone-demo PR #1, from the client&apos;s card to the worker. Scroll, and watch where the money is.</p>
      </div>

      <div className="mx-auto grid max-w-6xl gap-x-12 px-4 pb-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        {/* The stage: pinned while the steps scroll past */}
        <div className="sticky top-16 z-10 -mx-4 bg-paper/95 px-4 pb-3 pt-4 backdrop-blur lg:order-2 lg:mx-0 lg:h-[calc(100vh-6rem)] lg:bg-transparent lg:px-0 lg:py-8 lg:backdrop-blur-none">
          <div className="lg:flex lg:h-full lg:items-center" aria-live="polite">
            <p className="sr-only">
              Step {i + 1} of 5, {STEPS[i]!.name}. The money is at: {STATIONS[STEPS[i]!.at]!.label}.
            </p>
            <Stage i={i} />
          </div>
        </div>

        <div className="lg:order-1">
          {STEPS.map((s, k) => (
            <article
              key={s.name}
              ref={(el) => {
                refs.current[k] = el;
              }}
              data-step={k}
              className="flex min-h-[60vh] flex-col justify-center py-10 lg:min-h-[80vh]"
            >
              <p className={`text-sm font-medium transition-colors duration-[var(--t-state)] ${k === i ? "text-ink" : "text-ink-3"}`}>
                Step {k + 1} · {s.name}
              </p>
              <h3 className={`mt-2 text-2xl font-semibold tracking-tight transition-colors duration-[var(--t-state)] sm:text-3xl ${k === i ? "text-ink" : "text-ink-3"}`}>{s.title}</h3>
              <p className={`mt-3 max-w-md leading-relaxed transition-colors duration-[var(--t-state)] ${k === i ? "text-ink-2" : "text-ink-3"}`}>{s.text}</p>
              <div className="mt-4 lg:hidden">
                <Fence s={s} k={k} />
              </div>
              <div className="mt-3 rounded-md border border-rule bg-panel p-3 lg:hidden">
                <p className="text-xs font-medium text-ink-2">What runs</p>
                {s.runs.map((line) => (
                  <p key={line} className="mt-1 break-all font-mono text-[11px] leading-relaxed text-ink">
                    {line}
                  </p>
                ))}
                <a href={s.guard.href} target="_blank" rel="noreferrer" className="mt-2 inline-block break-all text-[11px] text-ink-2 underline">
                  Enforced in {s.guard.label}
                </a>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
