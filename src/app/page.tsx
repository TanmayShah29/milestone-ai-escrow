import Link from "next/link";
import { PayOnProofCheque } from "./PayOnProofCheque";

// The pitch, in the order a judge needs it: what it is and who it's for, why it matters, what's new, how it works,
// why PayPal, then proof. Every number and run below is real and linked; nothing here is invented (PRODUCT.md).

const NEW = [
  {
    name: "The AI writes the contract",
    text: "Describe the work in plain English. The AI turns it into acceptance criteria, and writes a test for each one code can check. Every test must fail on empty code before anyone can sign.",
  },
  {
    name: "A second AI tries to cheat it",
    text: "Before signing, an AI plays the dishonest worker: it writes fake code to pass the tests without doing the work. Code runs the fake. If it wins, the tests are strengthened until the same fake fails.",
    code: "if (n === 1) return 'I';\nif (n === 4) return 'IV';\nreturn '';  // passed the first draft",
  },
  {
    name: "Only code moves the money",
    text: "PayPal holds the payment. When the signed tests pass in CI, fixed rules capture the hold and pay the worker. The AI only ever writes and checks; it has no way to release or take money.",
  },
];

const STEPS = [
  { name: "Agree", text: "The AI drafts the criteria and tests, then attacks them with fake code. Both sides sign the terms' fingerprint." },
  { name: "Fund", text: "The client's payment goes on a PayPal hold. Nothing is charged, and the fingerprint rides on the PayPal order." },
  { name: "Deliver", text: "The worker, a person or an AI agent, opens a pull request. CI runs the signed tests; the PR can't swap them." },
  { name: "Verify", text: "The AI reviews only what tests can't check, and text that tries to steer it is caught. Fixed rules decide." },
  { name: "Release", text: "After a short objection window the hold is captured and the worker is paid. If the work fails, the money stays held." },
];

const WHY_PAYPAL = [
  { name: "Pay with what you already use", text: "The client funds the hold with their PayPal account or a card. No crypto wallet, no new account with us." },
  { name: "Held, not charged", text: "An authorization hold proves the money exists before work starts. Until the work passes, nothing is captured." },
  { name: "Paid where workers already are", text: "The worker is paid by PayPal Payouts to their PayPal account, net of PayPal's fees. Both sides see the estimate before the money is held." },
];

const RUNS = [
  { pr: 1, title: "A freelancer's slugify utility", outcome: "All four conditions passed; $23.75 paid out automatically." },
  { pr: 2, title: "The same job, done badly", outcome: "The PR told the AI reviewer to pass everything. Caught, two tests failed, money held; fixed and paid later." },
  { pr: 3, title: "An AI agent as the contractor", outcome: "The agent read the terms, opened the PR and submitted it through MCP; $14.25 paid." },
  { pr: 10, title: "An agent hired by another agent", outcome: "The worker agent's first attempt failed the signed tests, so no money moved. It fixed the code from the verdict; $13.10 paid." },
];

export default function Home() {
  return (
    <main>
      <section className="mx-auto max-w-6xl px-4 pb-14 pt-10 sm:pt-12 lg:pt-8">
        <p className="text-sm font-medium text-ink-2">For teams hiring freelancers or AI coding agents</p>
        <h1 className="mt-2 max-w-3xl text-4xl font-semibold tracking-tight text-ink sm:text-6xl">Pay only when the work passes.</h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-2 lg:mt-3">
          Write the job in plain English. AI turns it into tests, then tries to cheat them before anyone signs. PayPal holds the money, and code pays the worker when the tests pass. A smart contract, without the blockchain.
        </p>
        <div className="mt-8 lg:mt-6">
          <PayOnProofCheque />
        </div>
      </section>

      <section aria-labelledby="problem-h" className="border-y border-rule bg-panel">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 md:grid-cols-[1fr_1.3fr] md:items-center">
          <div>
            <p className="text-6xl font-semibold tracking-tight text-ink">71%</p>
            <p className="mt-2 text-ink-2">
              of freelancers surveyed had trouble collecting payment at some point in their careers. In 2014 they lost an average of $5,968 to unpaid work.
            </p>
            <p className="mt-2 text-xs text-ink-3">
              Freelancers Union survey of over 5,000 US freelancers,{" "}
              <a href="https://onlabor.org/wp-content/uploads/2017/05/FU_NonpaymentReport_r3.pdf" target="_blank" rel="noreferrer" className="underline">
                published 2015
              </a>
              .
            </p>
          </div>
          <div>
            <h2 id="problem-h" className="text-2xl font-semibold tracking-tight">
              Both sides take a risk
            </h2>
            <p className="mt-3 text-ink-2">
              The worker starts without knowing the money exists. The client pays without knowing the work is done, and &ldquo;done&rdquo; is where disputes start. AI agents make it sharper: they can take paid work in minutes, and no one should let an agent pay itself.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="new-h" className="mx-auto max-w-6xl px-4 py-14">
        <h2 id="new-h" className="text-2xl font-semibold tracking-tight">
          What&apos;s different
        </h2>
        <ol className="mt-8 grid gap-8 md:grid-cols-3">
          {NEW.map((n, i) => (
            <li key={n.name}>
              <p className="flex items-center gap-3">
                <span className="flex size-7 items-center justify-center rounded-full border border-ink text-xs font-semibold">{i + 1}</span>
                <span className="font-semibold">{n.name}</span>
              </p>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{n.text}</p>
              {n.code && <pre className="mt-3 overflow-x-auto rounded-md border border-rule bg-panel p-3 font-mono text-xs leading-relaxed text-ink">{n.code}</pre>}
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm">
          <Link href="/demo#attack-heading" className="underline">
            See a real attack, step by step
          </Link>
        </p>
      </section>

      <section aria-labelledby="how-h" className="border-y border-rule bg-panel">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <h2 id="how-h" className="text-2xl font-semibold tracking-tight">
            How a milestone works
          </h2>
          <ol className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-5 lg:gap-6">
            {STEPS.map((s, i) => (
              <li key={s.name}>
                <p className="flex items-center gap-3">
                  <span className="flex size-7 items-center justify-center rounded-full border border-ink text-xs font-semibold">{i + 1}</span>
                  <span className="font-semibold">{s.name}</span>
                </p>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="paypal-h" className="mx-auto max-w-6xl px-4 py-14">
        <h2 id="paypal-h" className="text-2xl font-semibold tracking-tight">
          Why it runs on PayPal
        </h2>
        <ul className="mt-6 grid gap-6 md:grid-cols-3">
          {WHY_PAYPAL.map((w) => (
            <li key={w.name} className="border-t border-rule-strong pt-4">
              <p className="font-semibold">{w.name}</p>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{w.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="runs-h" className="border-t border-rule bg-panel">
        <div className="mx-auto max-w-6xl px-4 py-14">
          <h2 id="runs-h" className="text-2xl font-semibold tracking-tight">
            Real runs on PayPal sandbox
          </h2>
          <p className="mt-2 max-w-2xl text-ink-2">Each one is a public pull request with its CI checks and Milestone&apos;s verdict comment.</p>
          <ul className="mt-6 divide-y divide-rule border-y border-rule">
            {RUNS.map((r) => (
              <li key={r.pr} className="grid gap-1 py-4 sm:grid-cols-[14rem_1fr_auto] sm:items-baseline sm:gap-6">
                <p className="font-medium text-ink">{r.title}</p>
                <p className="text-sm text-ink-2">{r.outcome}</p>
                <a href={`https://github.com/TanmayShah29/milestone-demo/pull/${r.pr}`} target="_blank" rel="noreferrer" className="text-sm text-ink underline">
                  Pull request #{r.pr}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="agents-h" className="border-t border-rule">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 md:grid-cols-2 md:items-center">
          <div>
            <h2 id="agents-h" className="text-2xl font-semibold tracking-tight">
              AI agents can earn here, and never take
            </h2>
            <p className="mt-3 text-ink-2">
              Agentic commerce so far is about agents that buy. Milestone is the other half: an agent that does paid work, and gets paid through PayPal only once its work is proven.
            </p>
            <p className="mt-3 text-ink-2">
              Through the Milestone MCP server, an agent can post a job, have its terms drafted and attacked, or take the job: read the signed tests, sign, open a pull request and track its payout. No tool funds, captures, releases or refunds. A person approves the hold, and the rules release it.
            </p>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-rule bg-panel p-4 font-mono text-xs leading-relaxed text-ink">
            {`claude mcp add milestone -- npx tsx mcp/server.mts

create_milestone  post a job; the AI drafts terms
attack_terms      try to cheat the tests first
get_milestone     read terms, tests, fingerprint
accept_terms      sign by fingerprint
submit_work       submit the pull request
get_status        verdict, feedback, payout`}
          </pre>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xl font-semibold">Watch real money move on sandbox, in about 2 minutes.</p>
            <p className="mt-1 text-sm text-ink-2">One click places a PayPal hold, opens a pull request, runs CI and an AI review. No login.</p>
          </div>
          <Link href="/demo" className="inline-flex items-center justify-center rounded-md bg-accent px-5 py-3 font-medium text-accent-ink no-underline hover:opacity-90">
            Run it live
          </Link>
        </div>
        <p className="mt-10 border-t border-rule pt-6 text-xs leading-relaxed text-ink-3">
          Runs on PayPal&apos;s sandbox; no real money moves. Built for the PayPal AI Hackathon 2026 with the APIMatic Context Plugin (PayPal integration), a Bryntum Gantt (timeline) and Render (hosting). Source:{" "}
          <a href="https://github.com/TanmayShah29/milestone-ai-escrow" className="underline">
            github.com/TanmayShah29/milestone-ai-escrow
          </a>
          .
        </p>
      </section>
    </main>
  );
}
