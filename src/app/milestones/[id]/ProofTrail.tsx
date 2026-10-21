import { eventLabel } from "@/lib/client/states";

export type AuditRow = { id: number; actor: string; event: string; from_state: string | null; to_state: string | null; paypal_id: string | null; created_at: string };

const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** Every step as a dated mark with its reference: the record of what happened to the money and the work. */
export function ProofTrail({ audit }: { audit: AuditRow[] }) {
  const rows = [...audit].reverse();
  return (
    <section aria-labelledby="trail-h" className="rounded-lg border border-rule bg-panel p-4 sm:p-5">
      <h2 id="trail-h" className="text-lg font-semibold">
        Proof trail
      </h2>
      <p className="mt-1 text-sm text-ink-2">Every step, with the PayPal or GitHub reference that proves it. Newest first.</p>
      <ol className="mt-4 space-y-0">
        {rows.map((a) => (
          <li key={a.id} className="grid grid-cols-[7.5rem_1fr] gap-3 border-t border-rule py-2 text-sm first:border-t-0 sm:grid-cols-[8.5rem_1fr_auto]">
            <time dateTime={a.created_at} className="text-xs text-ink-3">
              {fmt.format(new Date(a.created_at))}
            </time>
            <span className="text-ink">{eventLabel(a.event)}</span>
            {a.paypal_id && (
              <span className="col-start-2 truncate font-mono text-xs text-ink-2 sm:col-start-auto" title={a.paypal_id}>
                {a.paypal_id}
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
