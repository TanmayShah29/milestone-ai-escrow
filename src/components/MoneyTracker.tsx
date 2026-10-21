import { Check } from "lucide-react";
import { STEPS, stepIndex, type Tone } from "@/lib/client/states";

const TONE_CLS: Record<Tone, string> = {
  neutral: "bg-blocked-field text-ink",
  active: "bg-blocked-field text-ink",
  held: "bg-held-field text-held",
  paid: "bg-paid-field text-paid",
  failed: "bg-failed-field text-failed",
  blocked: "bg-blocked-field text-blocked",
};

export function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-medium ${TONE_CLS[tone]}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Agree → Fund → Deliver → Verify → Release, with the current step marked. */
export function MoneyTracker({ state, compact = false }: { state: string; compact?: boolean }) {
  const current = stepIndex(state);
  const cancelled = current === -1;
  return (
    <ol className={`flex items-center ${compact ? "gap-1" : "gap-2"}`} aria-label={cancelled ? "Cancelled" : `Step ${Math.min(current + 1, 5)} of 5: ${STEPS[Math.min(current, 4)]}`}>
      {STEPS.map((step, i) => {
        const done = !cancelled && i < current;
        const here = !cancelled && i === current;
        return (
          <li key={step} className="flex flex-1 items-center gap-2 last:flex-none" aria-current={here ? "step" : undefined}>
            <span
              className={`flex shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${compact ? "size-5" : "size-7"} ${
                done ? "border-paid bg-paid text-panel" : here ? "border-ink bg-panel text-ink ring-2 ring-ink/15" : "border-rule-strong bg-panel text-ink-3"
              }`}
            >
              {done ? <Check className={compact ? "size-3" : "size-4"} aria-hidden="true" /> : i + 1}
            </span>
            {!compact && <span className={`hidden text-sm sm:inline ${here ? "font-semibold text-ink" : done ? "text-ink-2" : "text-ink-3"}`}>{step}</span>}
            {i < STEPS.length - 1 && <span className={`h-px flex-1 ${done ? "bg-paid" : "bg-rule-strong"}`} aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
