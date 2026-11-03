import Link from "next/link";

// The label over the public showcase of judge runs (/timeline, /ledger, /milestones). `onBack` is set when
// this browser has milestones of its own, so the viewer can switch back to them.
export function ShowcaseNotice({ count, onBack, className = "" }: { count: number; onBack?: () => void; className?: string }) {
  return (
    <div role="note" className={`rounded-md border border-rule-strong bg-panel px-3 py-2 text-sm text-ink-2 ${className}`}>
      <p>
        <span className="font-medium text-ink">Showing {count === 1 ? "a recent live judge run" : `${count} recent live judge runs`}</span> — real PayPal sandbox ids, read only. Start your own on{" "}
        <Link href="/demo" className="text-ink underline">
          /demo
        </Link>
        .
        {onBack && (
          <>
            {" "}
            <button type="button" onClick={onBack} className="text-ink underline">
              Back to your milestones
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** "View live judge runs": offered beside a viewer's own milestones when the showcase has runs. */
export function ShowcaseToggle({ onShow }: { onShow: () => void }) {
  return (
    <button type="button" onClick={onShow} className="text-sm text-ink underline">
      View live judge runs
    </button>
  );
}
