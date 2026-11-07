import Link from "next/link";
import { PayOnProofCheque } from "./PayOnProofCheque";
import { AttackLab } from "./landing/AttackLab";
import { Depth } from "./landing/Depth";
import { FollowTheMoney } from "./landing/FollowTheMoney";
import { AgentsHire } from "./landing/AgentsHire";
import { PayPalTrail } from "./landing/PayPalTrail";

// The landing page is one journey (docs/design/experience-plan.md): the cheque (try it), follow the $25
// (how it works), try to cheat it (why it holds), what's underneath (how deep it goes), then run it live.
// Every number and run is real and linked; nothing here is invented (PRODUCT.md).

export default function Home() {
  return (
    <main>
      <section className="mx-auto max-w-6xl px-4 pb-14 pt-10 sm:pt-12 lg:pt-8">
        <p className="text-sm font-medium text-ink-2">For teams hiring freelancers or AI coding agents</p>
        <h1 className="mt-2 max-w-3xl text-4xl font-semibold tracking-tight text-ink sm:text-6xl">Pay only when the work passes.</h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-2 lg:mt-3">AI writes the tests and tries to cheat them. A PayPal authorization hold keeps the money. Fixed rules pay the worker when the signed tests pass, and the AI can never move it.</p>
        <div className="mt-8 lg:mt-6">
          <PayOnProofCheque />
        </div>
        <PayPalTrail />
        <p className="mt-6 max-w-3xl text-sm text-ink-2">
          <span className="font-semibold text-ink">71% of freelancers</span> have had trouble getting paid, and &ldquo;done&rdquo; is where disputes start. AI agents make it sharper: they take paid work in minutes, and no one should let an agent pay itself.{" "}
          <a href="https://onlabor.org/wp-content/uploads/2017/05/FU_NonpaymentReport_r3.pdf" target="_blank" rel="noreferrer" className="text-ink-3 underline">
            Freelancers Union, 2015
          </a>
        </p>
      </section>

      <FollowTheMoney />

      <AttackLab />

      <Depth />

      <AgentsHire />

      <section className="border-t border-rule bg-ink text-panel">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-16 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-3xl font-semibold tracking-tight">Now watch real money move.</p>
            <p className="mt-2 max-w-xl text-panel/75">One click places a real PayPal sandbox hold, opens a real pull request and runs real CI. About 2 minutes, no login.</p>
          </div>
          <Link href="/demo" className="inline-flex min-h-12 items-center justify-center rounded-md bg-panel px-6 font-semibold text-ink no-underline transition-opacity duration-[var(--t-tap)] hover:opacity-90">
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
