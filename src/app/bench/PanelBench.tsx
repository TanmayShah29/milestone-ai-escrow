import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cases, PANEL_BENCH_VERSION, scorePanel, type PanelResults } from "@/lib/bench-panel";

// Proof Bench v2 on /bench: the production AI panel measured against hand-labelled cases
// (bench/panel/results.json, written by `npm run bench:panel`). Shows only what has been judged so far.

function load(): PanelResults {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "bench", "panel", "results.json"), "utf8")) as PanelResults;
  } catch {
    return { version: PANEL_BENCH_VERSION, runs: [] };
  }
}

const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

export function PanelBench() {
  const s = scorePanel(load());
  const orders = { ab: new Set(load().runs.filter((r) => r.order === "ab").map((r) => r.caseId)).size, ba: new Set(load().runs.filter((r) => r.order === "ba").map((r) => r.caseId)).size };
  return (
    <section aria-labelledby="panel-title" className="mt-14">
      <h2 id="panel-title" className="text-2xl font-semibold tracking-tight">
        The AI panel, measured
      </h2>
      <p className="mt-3 max-w-3xl text-ink-2">
        Criteria that no test can check go to a panel of three free models. Each vote counts only if code finds its quote in the diff, and fixed rules turn the votes into a verdict. Here the production panel judges {cases.length} labelled cases: good work, subtly
        wrong work, padded work, work that ignores the spec, injections in seven languages, and invisible-character tricks. Each case is meant to run with its criteria in both orders, to measure position bias.
      </p>
      <p className="mt-2 text-sm text-ink-3">
        Bench <span className="font-mono">{s.version}</span>, pinned in every new contract. Judged so far: {orders.ab} of {cases.length} cases in the first order, {orders.ba} in the second ({s.calls} model calls, run a few a day under the free tier&apos;s cap).
      </p>
      {s.runs === 0 ? (
        <p className="mt-6 rounded-lg border border-rule bg-panel p-5 text-sm text-ink-2">The first run is in progress.</p>
      ) : (
        <>
          {s.panel.wrongPays === 0 && s.panel.falsePass === 0 && (
            <p className="mt-6 text-lg font-semibold text-ink">
              When the panel is unsure, it asks a person instead of paying: <span className="text-paid">0 wrong payouts</span> in {s.panel.casesJudged} cases judged so far
              {s.injection.cases > 0 && s.injection.caught === s.injection.cases && (
                <>
                  , and <span className="text-paid">every injection attempt caught</span> ({s.injection.caught} of {s.injection.cases}, in seven languages and invisible characters)
                </>
              )}
              .
            </p>
          )}
          <dl className={`mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-rule bg-rule ${s.injection.cases > 0 ? "sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-4"}`}>
            {(
              [
                ["Wrong payouts", `${s.panel.wrongPays} of ${s.panel.casesJudged}`, s.panel.wrongPays === 0, "cases where a bad deliverable would have been paid"],
                ...(s.injection.cases > 0 ? [["Injection attempts caught", `${s.injection.caught} of ${s.injection.cases}`, s.injection.caught === s.injection.cases, `the scan caught ${s.injection.scan}; a panel model flagged ${s.injection.anyMember}`] as const] : []),
                ["False passes", String(s.panel.falsePass), s.panel.falsePass === 0, "a criterion passed that shouldn't have"],
                ["Sent to a person", String(s.panel.escalated), false, "unclear or unquoted votes are never paid on"],
                ["Criteria judged right", `${s.panel.correct} of ${s.panel.criteria}`, false, "an unsure vote counts as not right"],
              ] as const
            ).map(([label, value, good, note]) => (
              <div key={label} className="bg-panel p-4">
                <dt className="text-sm text-ink-2">{label}</dt>
                <dd className={`money mt-1 text-3xl font-semibold tracking-tight ${good ? "text-paid" : "text-ink"}`}>{value}</dd>
                <dd className="mt-1 text-xs text-ink-3">{note}</dd>
              </div>
            ))}
          </dl>
          <details className="mt-4 rounded-lg border border-rule bg-panel p-4">
            <summary className="cursor-pointer text-sm font-medium text-ink">
              Per-model results (run in progress: {orders.ab} of {cases.length} cases)
            </summary>
            {s.injection.cases > 0 && (
              <p className="mt-3 text-sm text-ink-3">
                Injection cases caught: {s.injection.caught} of {s.injection.cases} (the deterministic scan {s.injection.scan}, at least one panel member {s.injection.anyMember}).
              </p>
            )}
            <div className="mt-3 overflow-x-auto rounded-lg border border-rule">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-left text-ink-2">
                  <tr className="border-b border-rule">
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium">Accuracy</th>
                    <th className="px-4 py-3 font-medium">Cohen&apos;s κ</th>
                    <th className="px-4 py-3 font-medium">Grounded</th>
                    <th className="px-4 py-3 font-medium">Flagged injection</th>
                    <th className="px-4 py-3 font-medium">Order flips</th>
                  </tr>
                </thead>
                <tbody>
                  {s.models.map((m) => (
                    <tr key={m.model} className="border-b border-rule last:border-0">
                      <td className="px-4 py-3 font-mono text-xs">{m.model}</td>
                      <td className="px-4 py-3">
                        {pct(m.accuracy)} <span className="text-ink-3">of {m.votes}</span>
                      </td>
                      <td className="px-4 py-3">{m.kappa ?? "n/a"}</td>
                      <td className="px-4 py-3">{pct(m.groundingRate)}</td>
                      <td className="px-4 py-3">{m.injectionFlags.of ? `${m.injectionFlags.flagged} of ${m.injectionFlags.of}` : "no cases yet"}</td>
                      <td className="px-4 py-3">{m.positionFlips.pairs ? `${m.positionFlips.flips} of ${m.positionFlips.pairs}` : "not yet"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-sm text-ink-3">
              Accuracy counts an unclear or ungrounded vote as not right. κ compares each model&apos;s grounded votes with the labels (1 = perfect, 0 = chance). A wrong payout is a run where every criterion passed, one shouldn&apos;t have, and nothing flagged an
              injection. Limits: one author wrote the cases and the labels, the cases are small, and the models are free and change without notice.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
