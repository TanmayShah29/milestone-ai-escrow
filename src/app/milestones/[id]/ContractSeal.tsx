import { GuillocheSeal } from "@/components/GuillocheSeal";
import type { MilestoneView } from "@/lib/client/states";

/** The sealed contract: the terms fingerprint drawn as a seal, with the locked contract CI runs. */
export function ContractSeal({ m }: { m: MilestoneView }) {
  const hash = m.criteria_hash ?? null;
  const sealed = !!hash && m.client_signed_hash === hash && m.worker_signed_hash === hash;
  return (
    <section aria-labelledby="seal-h" className="rounded-lg border border-rule bg-panel p-4">
      <h2 id="seal-h" className="text-sm font-medium text-ink-2">
        Contract seal
      </h2>
      <div className="mt-3 flex justify-center">
        <GuillocheSeal hash={hash} sealed={sealed} size={200} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-2">
        {sealed
          ? "Drawn from the SHA-256 fingerprint of the terms both sides signed. The same fingerprint is on the PayPal order, so any change to the terms would break the seal."
          : "Drawn from the fingerprint of the current terms. It turns solid when both sides sign."}
      </p>
      {sealed && hash && (
        <a href={`/api/contracts/${hash}`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-ink underline">
          View the locked contract CI runs
        </a>
      )}
    </section>
  );
}
