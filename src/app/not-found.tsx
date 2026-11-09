import Link from "next/link";

export default function NotFound() {
  return (
    <main id="content" className="mx-auto max-w-xl px-4 py-24">
      <p className="font-mono text-sm text-ink-3">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">This page doesn&apos;t exist</h1>
      <p className="mt-3 text-ink-2">The link may be mistyped or out of date. Deal rooms open only from their client or worker link.</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/demo" className="inline-flex items-center rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink no-underline hover:opacity-90">
          Try the judge demo
        </Link>
        <Link href="/" className="inline-flex items-center rounded-md border border-rule-strong bg-panel px-4 py-2.5 text-sm font-medium text-ink no-underline hover:bg-paper">
          Back to Milestone
        </Link>
      </div>
    </main>
  );
}
