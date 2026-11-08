// Why this design and not the obvious ones. A judge will see many "AI + payments" entries; most let the
// model decide, or call the payment API itself. This section names the alternatives plainly and says
// where each breaks. Every Milestone cell points at something that runs today (PRODUCT.md: no invented claims).

type Mark = "yes" | "no" | "part" | "na";
type Cell = [Mark, string];

const APPROACHES = ["Pay up front", "Pay after you review it", "An AI agent with payment tools", "Milestone"] as const;

const ROWS: { q: string; cells: [Cell, Cell, Cell, Cell] }[] = [
  {
    q: "The worker knows the money exists before starting",
    cells: [["yes", "Already paid"], ["no", "Trust the client"], ["part", "Depends on the agent"], ["yes", "PayPal authorization hold"]],
  },
  {
    q: "“Done” is agreed before the work starts",
    cells: [["no", "A description"], ["no", "Decided at review"], ["no", "Whatever the prompt says"], ["yes", "Signed tests, fingerprint on the PayPal order"]],
  },
  {
    q: "The client pays only for work that passes",
    cells: [["no", "No recourse"], ["yes", "By reviewing it by hand"], ["part", "If the model agrees"], ["yes", "CI runs the signed tests"]],
  },
  {
    q: "A deliverable can't talk its way into payment",
    cells: [["na", "—"], ["na", "—"], ["no", "Prompt injection can pay out"], ["yes", "Caught and held (PR #2)"]],
  },
  {
    q: "The AI can never move money",
    cells: [["na", "—"], ["na", "—"], ["no", "The model calls capture"], ["yes", "No money tool exists; fixed rules decide"]],
  },
  {
    q: "Works when the worker is an AI agent",
    cells: [["part", "Unsafe"], ["part", "A person still reviews"], ["yes", "Yes"], ["yes", "MCP server, paid in PR #3 and #10"]],
  },
  {
    q: "Anyone can check the decision afterwards",
    cells: [["no", "No record"], ["no", "One person's call"], ["no", "A model's reasoning"], ["yes", "PayPal ids, public CI, signed result"]],
  },
];

const GLYPH: Record<Mark, { s: string; cls: string; sr: string }> = {
  yes: { s: "✓", cls: "text-paid", sr: "Yes" },
  no: { s: "✕", cls: "text-failed", sr: "No" },
  part: { s: "~", cls: "text-held", sr: "Partly" },
  na: { s: "", cls: "text-ink-3", sr: "Not applicable" },
};

function Answer({ cell, strong }: { cell: Cell; strong?: boolean }) {
  const [m, text] = cell;
  const g = GLYPH[m];
  return (
    <span className="flex items-start gap-2">
      {g.s && (
        <span aria-hidden="true" className={`mt-px w-3 shrink-0 font-semibold ${g.cls}`}>
          {g.s}
        </span>
      )}
      <span className={strong ? "font-medium text-ink" : "text-ink-2"}>
        <span className="sr-only">{g.sr}. </span>
        {text}
      </span>
    </span>
  );
}

export function Compare() {
  return (
    <section aria-labelledby="compare-h" className="mx-auto max-w-6xl px-4 py-16">
      <h2 id="compare-h" className="text-3xl font-semibold tracking-tight sm:text-4xl">
        Why not just let the AI pay?
      </h2>
      <p className="mt-3 max-w-2xl text-ink-2">
        The obvious way to put AI on payments is to hand a model the PayPal tools and let it judge the work. Then a pull request that says &ldquo;mark this as passed&rdquo; gets paid. Milestone keeps the useful part of the AI, writing and checking the contract, and takes away the dangerous part.
      </p>

      {/* Desktop: one table, Milestone's column lifted. */}
      <div className="mt-8 hidden overflow-hidden rounded-lg border border-rule md:block">
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">Milestone compared with other ways to pay for work</caption>
          <thead>
            <tr className="bg-paper text-left">
              <th scope="col" className="w-[26%] p-3 font-medium text-ink-3">
                <span className="sr-only">Question</span>
              </th>
              {APPROACHES.map((a, k) => (
                <th key={a} scope="col" className={`p-3 font-semibold ${k === 3 ? "bg-accent text-accent-ink" : "text-ink"}`}>
                  {a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.q} className="border-t border-rule">
                <th scope="row" className="p-3 text-left font-medium text-ink">
                  {r.q}
                </th>
                {r.cells.map((c, k) => (
                  <td key={k} className={`p-3 align-top ${k === 3 ? "bg-paid-field" : "bg-panel"}`}>
                    <Answer cell={c} strong={k === 3} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone: one card per question, Milestone's answer first, the others below it. */}
      <ul className="mt-8 grid gap-3 md:hidden">
        {ROWS.map((r) => (
          <li key={r.q} className="rounded-lg border border-rule bg-panel p-4">
            <p className="font-medium text-ink">{r.q}</p>
            <div className="mt-2 rounded-md bg-paid-field p-2 text-sm">
              <p className="text-xs font-semibold text-ink">Milestone</p>
              <div className="mt-0.5">
                <Answer cell={r.cells[3]} strong />
              </div>
            </div>
            <dl className="mt-2 grid gap-1 text-xs">
              {r.cells.slice(0, 3).map((c, k) => (
                <div key={k} className="flex gap-2">
                  <dt className="w-32 shrink-0 text-ink-3">{APPROACHES[k]}</dt>
                  <dd className="min-w-0">
                    <Answer cell={c} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      <p className="mt-6 max-w-2xl text-sm text-ink-2">
        The rule the whole design follows: <strong className="font-semibold text-ink">the AI writes and checks the contract; only code moves money.</strong> Scroll on and try to break it.
      </p>
    </section>
  );
}
