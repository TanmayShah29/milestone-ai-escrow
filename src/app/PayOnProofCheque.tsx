"use client";

import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { GuillocheSeal } from "@/components/GuillocheSeal";

// The landing page's object: a cheque that only clears on proof. Its conditions are a real run's acceptance
// criteria (milestone-demo #1); on load they pass one by one and the cheque clears. Reduced motion shows the
// cleared state at once.

const CONDITIONS = [
  { text: "slugify lowercases and trims its input", by: "CI test" },
  { text: "Runs of punctuation become one hyphen", by: "CI test" },
  { text: "Accents transliterated; empty input returns empty", by: "CI test" },
  { text: "README documents it with an example", by: "AI review" },
];
const SEAL_HASH =
  "48a51380573e1d02a1c66c14a600c34041a3c6823275d0a3ec9cc1deefab03d1"; // the run's real terms fingerprint

function waveBand(
  width: number,
  y: number,
  amp: number,
  k: number,
  phase: number,
) {
  let d = "";
  for (let x = 0; x <= width; x += 4)
    d += `${x === 0 ? "M" : "L"}${x} ${(y + amp * Math.sin((x / width) * Math.PI * 2 * k + phase)).toFixed(2)}`;
  return d;
}

export function PayOnProofCheque() {
  const [passed, setPassed] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return setPassed(CONDITIONS.length + 1);
    const t = setInterval(
      () => setPassed((p) => (p > CONDITIONS.length ? p : p + 1)),
      650,
    );
    return () => clearInterval(t);
  }, []);
  const cleared = passed > CONDITIONS.length;

  return (
    <div className="relative overflow-hidden rounded-xl border border-rule-strong bg-panel shadow-[0_2px_6px_rgb(19_35_58/0.06),0_24px_60px_-28px_rgb(19_35_58/0.35)]">
      {/* Guilloche border bands, top and bottom, like a cheque's security print. */}
      <svg
        className="pointer-events-none absolute inset-x-0 top-0 h-6 w-full"
        viewBox="0 0 1000 24"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <path
            key={i}
            d={waveBand(1000, 12, 6, 28, i * 1.25)}
            fill="none"
            stroke={i % 2 ? "var(--seal-2)" : "var(--seal)"}
            strokeWidth="0.6"
            opacity="0.55"
          />
        ))}
      </svg>
      <svg
        className="pointer-events-none absolute inset-x-0 bottom-0 h-6 w-full"
        viewBox="0 0 1000 24"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <path
            key={i}
            d={waveBand(1000, 12, 6, 28, i * 1.25 + 0.6)}
            fill="none"
            stroke={i % 2 ? "var(--seal)" : "var(--seal-2)"}
            strokeWidth="0.6"
            opacity="0.55"
          />
        ))}
      </svg>

      <div className="grid gap-6 px-5 pb-10 pt-10 sm:px-10 md:grid-cols-[1fr_auto] md:gap-10 lg:pb-8 lg:pt-8">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule-strong pb-3">
            <p className="text-sm text-ink-2">
              Pay to the order of{" "}
              <span className="font-semibold text-ink">the worker</span>
            </p>
            <p className="font-mono text-sm text-ink-2">
              No. ms-demo-1 · PayPal sandbox
            </p>
          </div>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-4 lg:mt-3">
            <p className="text-sm text-ink-2">
              Held on PayPal until every condition below passes.
              <span className="block text-ink-3">
                Released by fixed rules, never by the AI.
              </span>
            </p>
            <p className="sm:text-right">
              <span className="block text-xs text-ink-2">Amount</span>
              <span className="text-4xl font-semibold tracking-tight sm:text-5xl">
                $25.00
              </span>
            </p>
          </div>

          <div className="mt-6 flex flex-col lg:mt-4">
            <div className="order-2 mt-6 md:order-1 md:mt-0">
              <p className="text-sm font-medium text-ink">Conditions</p>
              <ol className="mt-2 divide-y divide-rule border-y border-rule">
                {CONDITIONS.map((c, i) => {
                  const ok = passed > i;
                  return (
                    <li
                      key={c.text}
                      className="flex items-center gap-3 py-2 text-sm"
                    >
                      <CircleCheck
                        className={`size-5 shrink-0 transition-colors duration-300 ${ok ? "text-paid" : "text-rule-strong"}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 text-ink">{c.text}</span>
                      <span
                        className={`whitespace-nowrap text-xs ${ok ? "text-paid" : "text-ink-3"}`}
                      >
                        {ok ? `Passed · ${c.by}` : c.by}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>

            <div className="order-1 md:order-2 md:mt-6 lg:mt-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Link
                  href="/demo"
                  className="inline-flex items-center justify-center rounded-md bg-accent px-5 py-3 font-medium text-accent-ink no-underline hover:opacity-90"
                >
                  Try the demo, no login
                </Link>
                <Link
                  href="/new"
                  className="inline-flex items-center justify-center rounded-md border border-rule-strong px-5 py-3 font-medium text-ink no-underline hover:bg-paper"
                >
                  Create a milestone
                </Link>
              </div>
              <p className="mt-2 text-[11px] text-ink-3">
                Conditions, fingerprint and amounts from a real sandbox run: milestone-demo pull request #1.
              </p>
            </div>
          </div>
        </div>

        <div className="relative flex flex-col items-center justify-center gap-3 md:w-56">
          <GuillocheSeal hash={SEAL_HASH} sealed size={176} label={false} />
          <p className="text-center text-xs text-ink-2">
            Terms sealed by both sides
            <span className="block font-mono text-ink-3">48a513…03d1</span>
          </p>
          <div
            role="status"
            aria-live="polite"
            className={`rotate-[-6deg] rounded-md border-2 px-3 py-1.5 text-center font-semibold uppercase tracking-wide transition-all duration-500 ${cleared ? "scale-100 border-paid text-paid opacity-100" : "scale-110 border-transparent text-transparent opacity-0"}`}
          >
            Cleared · $23.75 paid
          </div>
        </div>
      </div>
    </div>
  );
}
