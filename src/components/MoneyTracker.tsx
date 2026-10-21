import { Check, X } from "lucide-react";
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

/**
 * Agree → Fund → Deliver → Verify → Release, with the current step marked. A cancelled milestone keeps the
 * steps it completed and marks where it stopped (`cancelledAt`, from `cancelledAt()` in states.ts).
 */
export function MoneyTracker({ state, compact = false, cancelledAt }: { state: string; compact?: boolean; cancelledAt?: number }) {
  const current = stepIndex(state);
  const cancelled = current === -1;
  const stop = cancelled ? cancelledAt : undefined;
  const label = cancelled
    ? stop != null
      ? `Cancelled at step ${stop + 1} of 5: ${STEPS[stop]}`
      : "Cancelled"
    : current >= 5
      ? "All 5 steps done"
      : `Step ${current + 1} of 5: ${STEPS[current]}`;
  return (
    <ol className={`flex items-center ${compact ? "gap-1" : "gap-2"}`} aria-label={label}>
      {STEPS.map((step, i) => {
        const done = cancelled ? stop != null && i < stop : i < current;
        const here = !cancelled && i === current;
        const stoppedHere = stop === i;
        return (
          <li key={step} className="flex flex-1 items-center gap-2 last:flex-none" aria-current={here ? "step" : undefined}>
            <span
              className={`flex shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${compact ? "size-5" : "size-7"} ${
                done
                  ? "border-paid bg-paid text-panel"
                  : stoppedHere
                    ? "border-blocked bg-blocked-field text-blocked"
                    : here
                      ? "border-ink bg-panel text-ink ring-2 ring-ink/15"
                      : "border-rule-strong bg-panel text-ink-3"
              }`}
            >
              {done ? <Check className={compact ? "size-3" : "size-4"} aria-hidden="true" /> : stoppedHere ? <X className={compact ? "size-3" : "size-4"} aria-hidden="true" /> : i + 1}
            </span>
            {!compact && (
              <span className={`hidden text-sm sm:inline ${here ? "font-semibold text-ink" : stoppedHere ? "font-semibold text-blocked" : done ? "text-ink-2" : "text-ink-3"}`}>{stoppedHere ? "Cancelled" : step}</span>
            )}
            {i < STEPS.length - 1 && <span className={`h-px flex-1 ${done ? "bg-paid" : "bg-rule-strong"}`} aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
