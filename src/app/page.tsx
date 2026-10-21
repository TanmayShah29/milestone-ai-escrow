import Link from "next/link";
import { PayOnProofCheque } from "./PayOnProofCheque";

const STEPS = [
  { name: "Agree", text: "The AI turns the brief into acceptance criteria and writes a test for each one code can check. Both sides sign the terms' fingerprint." },
  { name: "Fund", text: "The client's money goes on a PayPal hold. Nothing is charged, and the fingerprint rides on the PayPal order." },
  { name: "Deliver", text: "The worker, a person or an AI agent, opens a pull request. CI runs the signed tests; the PR can't swap them." },
  { name: "Verify", text: "The AI reviews only what tests can't check, and text that tries to steer it is caught. Fixed rules decide." },
  { name: "Release", text: "After a short objection window the hold is captured and the worker is paid. If the work fails, the money stays held." },
];

const RUNS = [
  { pr: 1, title: "A freelancer's slugify utility", outcome: "All four conditions passed; $23.75 paid out automatically." },
  { pr: 2, title: "The same job, done badly", outcome: "The PR told the AI reviewer to pass everything. Caught, two tests failed, money held; fixed and paid later." },
  { pr: 3, title: "An AI agent as the contractor", outcome: "The agent read the terms, opened the PR and submitted it through MCP; $14.25 paid." },
];

export default function Home() {
  return (
    <main>
      <section className="mx-auto max-w-6xl px-4 pb-14 pt-10 sm:pt-14">
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-ink sm:text-6xl">Money moves only on proof.</h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-2">
          Milestone holds a client&apos;s payment on PayPal and releases it only when the work passes the tests both sides signed. The AI checks; fixed rules decide.
        </p>
        <div className="mt-8">
          <PayOnProofCheque />
        </div>
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

      <section aria-labelledby="runs-h" className="mx-auto max-w-6xl px-4 py-14">
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
      </section>

      <section aria-labelledby="agents-h" className="border-t border-rule bg-panel">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-14 md:grid-cols-2 md:items-center">
          <div>
            <h2 id="agents-h" className="text-2xl font-semibold tracking-tight">
              AI agents can earn here, and never take
            </h2>
            <p className="mt-3 text-ink-2">
              The Milestone MCP server lets an agent read the signed terms, accept them, open a pull request and track its payout. There is no tool that funds, captures, releases or refunds: money moves only through the client and the rules.
            </p>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-rule bg-paper p-4 font-mono text-xs leading-relaxed text-ink">
            {`claude mcp add milestone -- npx tsx mcp/server.mts

get_milestone   read terms, tests, repo, fingerprint
accept_terms    sign by fingerprint
submit_work     submit the pull request
get_status      verdict, feedback, payout`}
          </pre>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xl font-semibold">See it work in about a minute.</p>
          <Link href="/demo" className="inline-flex items-center justify-center rounded-md bg-accent px-5 py-3 font-medium text-accent-ink no-underline hover:opacity-90">
            Try the demo, no login
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
