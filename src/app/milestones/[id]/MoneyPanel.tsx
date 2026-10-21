import { TriangleAlert } from "lucide-react";
import { cancelledAt, holdExpiryWarning, moneyLine, usd, type MilestoneView } from "@/lib/client/states";

const TONE: Record<string, string> = {
  held: "border-held/40 bg-held-field/60",
  paid: "border-paid/40 bg-paid-field/60",
  failed: "border-failed/40 bg-failed-field/60",
  neutral: "border-rule bg-panel",
  blocked: "border-rule bg-blocked-field/60",
  active: "border-rule bg-panel",
};

function Ref({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-rule/70 py-1.5 first:border-t-0">
      <dt className="text-xs text-ink-2">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-xs text-ink" title={String(value)}>
        {String(value)}
      </dd>
    </div>
  );
}

/** The work is due after the PayPal hold expires: say so where the money is shown. */
export function HoldWarning({ text }: { text: string }) {
  return (
    <p className="mt-3 flex items-start gap-2 rounded-md border border-held/40 bg-held-field p-3 text-sm text-ink">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-held" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

/** Where the money is, what it's worth to the worker, and the PayPal references that prove it. */
export function MoneyPanel({ m }: { m: MilestoneView }) {
  const line = moneyLine(m);
  const fee = m.fee_cents ?? Math.round(m.amount_cents * 0.05);
  const payout = m.payout_cents ?? m.amount_cents - fee;
  const cancelled = m.state === "CANCELLED";
  const warning = holdExpiryWarning(m);
  return (
    <section aria-labelledby="money-h" className={`rounded-lg border p-4 ${TONE[line.tone]}`}>
      <h2 id="money-h" className="text-sm font-medium text-ink-2">
        Where the money is
      </h2>
      <p className="mt-1 text-xl font-semibold text-ink">{line.headline}</p>
      <p className="mt-1 text-sm text-ink-2">{line.detail}</p>

      {warning && <HoldWarning text={warning} />}

      {cancelled ? (
        <p className="mt-4 text-sm text-ink">
          {cancelledAt(m) >= 2 ? (
            <>
              Hold was <span className="font-semibold">{usd(m.authorized_cents ?? m.amount_cents)}</span> · nothing charged
            </>
          ) : (
            <>Nothing was held or charged</>
          )}
        </p>
      ) : (
        <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt className="text-xs text-ink-2">Client pays</dt>
            <dd className="font-semibold">{usd(m.amount_cents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-2">Platform fee</dt>
            <dd className="font-semibold">{usd(fee)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-2">Worker gets</dt>
            <dd className="font-semibold">{usd(payout)}</dd>
          </div>
        </dl>
      )}

      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">PayPal references (sandbox)</summary>
        <dl className="mt-2">
          <Ref label="Order" value={m.paypal_order_id} />
          <Ref label="Authorization (hold)" value={m.paypal_authorization_id} />
          <Ref label="Capture" value={m.paypal_capture_id} />
          <Ref label="Payout batch" value={m.paypal_payout_batch_id} />
          <Ref label="Payout item" value={m.paypal_payout_item_id} />
          {!m.paypal_order_id && <p className="text-xs text-ink-3">No PayPal activity yet.</p>}
        </dl>
        {String(m.paypal_order_id ?? "").startsWith("DEMO-") && (
          <p className="mt-2 text-xs text-ink-3">Demo replay: these ids are illustrative. The pull request and CI logs are real.</p>
        )}
      </details>
    </section>
  );
}
