import Link from "next/link";
import { PayOnProofCheque } from "./PayOnProofCheque";
import { AttackLab } from "./landing/AttackLab";
import { Depth } from "./landing/Depth";
import { FollowTheMoney } from "./landing/FollowTheMoney";
import { AgentsHire } from "./landing/AgentsHire";
import { PayPalTrail } from "./landing/PayPalTrail";
import { Compare } from "./landing/Compare";

// The landing page is one journey (docs/design/experience-plan.md): the cheque (try it), follow the $25
// (how it works), try to cheat it (why it holds), what's underneath (how deep it goes), then run it live.
// Every number and run is real and linked; nothing here is invented (PRODUCT.md).

export default function Home() {
  return (
    <main>
      {/* First screen: the idea, the cheque that proves it, and the two ways in. Nothing else competes. */}
      <section className="mx-auto max-w-6xl px-4 pb-12 pt-4 sm:pt-10 lg:grid lg:min-h-[calc(100svh-3.5rem)] lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] lg:items-center lg:gap-12 lg:py-8">
        <div>
          <h1 className="max-w-xl text-4xl font-semibold tracking-tight text-ink sm:text-5xl xl:text-6xl">Pay only when the work passes.</h1>
          <p className="mt-3 max-w-md text-ink-2 sm:text-lg">A PayPal hold that only fixed rules release, once the signed tests pass. AI writes the tests and tries to cheat them. It can never move the money.</p>
          <div className="mt-6 hidden gap-3 lg:flex">
            <Link href="/demo" className="inline-flex min-h-12 items-center justify-center rounded-md bg-accent px-5 font-medium text-accent-ink no-underline transition-opacity duration-[var(--t-tap)] hover:opacity-90">
              Run it live, no login
            </Link>
            <Link href="/new" className="inline-flex min-h-12 items-center justify-center rounded-md border border-rule-strong px-5 font-medium text-ink no-underline transition-colors duration-[var(--t-tap)] hover:bg-panel">
              Create a milestone
            </Link>
          </div>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:hidden">
          <Link href="/demo" className="inline-flex min-h-12 items-center justify-center rounded-md bg-accent px-4 text-center font-medium text-accent-ink no-underline">
            Run it live
          </Link>
          <Link href="/new" className="inline-flex min-h-12 items-center justify-center rounded-md border border-rule-strong px-4 text-center font-medium text-ink no-underline">
            Create one
          </Link>
        </div>
          <ul className="mt-5 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-2" aria-label="Proof">
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="text-paid">&#10003;</span>
              <a href="https://github.com/TanmayShah29/milestone-demo/pull/1" target="_blank" rel="noreferrer" className="underline decoration-rule-strong underline-offset-2 hover:text-ink">Real sandbox payouts on public PRs</a>
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="text-paid">&#10003;</span>
              <a href="https://github.com/TanmayShah29/milestone-demo/pull/2" target="_blank" rel="noreferrer" className="underline decoration-rule-strong underline-offset-2 hover:text-ink">Prompt injection caught, money held</a>
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden="true" className="text-paid">&#10003;</span>
              <a href="#compare-h" className="underline decoration-rule-strong underline-offset-2 hover:text-ink">No AI can move money</a>
            </li>
          </ul>
        </div>
        <div className="mt-5 lg:mt-0">
          <PayOnProofCheque />
        </div>
      </section>

      <FollowTheMoney />

      <div className="mx-auto max-w-6xl px-4">
        <PayPalTrail />
      </div>

      <Compare />

      <AttackLab />

      <Depth />

      <AgentsHire />

      {/* The close, in the same surface as the cheque: a light panel, not a dark band. */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="flex flex-col gap-6 rounded-xl border border-rule-strong bg-panel p-6 shadow-[var(--shadow-card)] sm:flex-row sm:items-center sm:justify-between sm:p-10">
          <div>
            <p className="text-3xl font-semibold tracking-tight text-ink">Now watch real money move.</p>
            <p className="mt-2 max-w-xl text-ink-2">One click places a real PayPal sandbox hold, opens a real pull request and runs real CI. About 2 minutes, no login.</p>
            <p className="mt-4 flex items-center gap-2 text-xs text-ink-3" aria-hidden="true">
              <span className="rounded-full border border-ink px-2 py-0.5 font-mono font-semibold text-ink">$12.00</span>
              <span className="h-px w-6 bg-rule-strong" />
              <span className="text-held">PayPal hold</span>
              <span className="h-px w-6 bg-rule-strong" />
              <span className="text-paid">Worker&apos;s PayPal</span>
            </p>
          </div>
          <Link href="/demo" className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-md bg-accent px-6 font-semibold text-accent-ink no-underline transition-opacity duration-[var(--t-tap)] hover:opacity-90">
            Run it live
          </Link>
        </div>
      </section>

      <p className="mx-auto max-w-6xl px-4 py-8 text-xs leading-relaxed text-ink-3">
        Runs on PayPal&apos;s sandbox; no real money moves. Built for the PayPal AI Hackathon 2026 with the APIMatic Context Plugin (PayPal integration), a Bryntum Gantt (timeline) and Render (hosting). Source:{" "}
        <a href="https://github.com/TanmayShah29/milestone-ai-escrow" className="underline">
          github.com/TanmayShah29/milestone-ai-escrow
        </a>
        .
      </p>
    </main>
  );
}
