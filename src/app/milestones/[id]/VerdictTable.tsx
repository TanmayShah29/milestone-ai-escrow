import { CircleCheck, CircleHelp, CircleX, ShieldAlert } from "lucide-react";

export type Review = {
  head_sha: string;
  status: "pending" | "done";
  decision: string | null;
  reasons: string[] | null;
  model: string | null;
  verdict: {
    criteria: { id: string; kind: string; source: "test" | "ai"; verdict: "pass" | "fail" | "unclear"; confidence: number; evidence: string[] }[];
    summary: string;
    feedbackForWorker: string;
    injection: { detected: boolean; quotes: string[] };
    tampering: string[];
  } | null;
};

const RESULT = {
  pass: { icon: CircleCheck, label: "Pass", cls: "text-paid" },
  fail: { icon: CircleX, label: "Fail", cls: "text-failed" },
  unclear: { icon: CircleHelp, label: "Unclear", cls: "text-held" },
} as const;

const DECISION: Record<string, string> = { PASSED: "Passed", CHANGES_REQUESTED: "Changes requested", HUMAN_CHECK: "Needs the client's decision" };

function Evidence({ text }: { text: string }) {
  const url = /(https:\/\/\S+)/.exec(text)?.[1];
  if (!url) return <span className="text-ink-2">{text}</span>;
  const label = text.replace(url, "").replace(/:\s*$/, "").trim() || "CI job";
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-ink underline">
      {label} log
    </a>
  );
}

/** The verdict as a certificate of analysis: one row per criterion, then the rule-based sign-off. */
export function VerdictTable({ review, criteriaText }: { review: Review; criteriaText: Record<string, string> }) {
  const v = review.verdict;
  if (!v) return null;
  return (
    <section aria-labelledby="verdict-h" className="rounded-lg border border-rule bg-panel p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="verdict-h" className="text-lg font-semibold">
          Verdict: {DECISION[review.decision ?? ""] ?? review.decision}
        </h2>
        <p className="text-xs text-ink-2">
          Commit <span className="font-mono">{review.head_sha.slice(0, 7)}</span>
          {review.model ? <> · reviewed by {review.model}</> : null}
        </p>
      </div>

      {v.injection.detected && (
        <div role="alert" className="mt-3 flex gap-3 rounded-md border border-failed/50 bg-failed-field p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-failed" aria-hidden="true" />
          <div>
            <p className="font-semibold text-failed">The work contains text aimed at the AI reviewer. It was ignored.</p>
            <p className="mt-1 break-words font-mono text-xs text-ink">{v.injection.quotes[0]}</p>
          </div>
        </div>
      )}
      {v.tampering.length > 0 && (
        <div role="alert" className="mt-3 flex gap-3 rounded-md border border-failed/50 bg-failed-field p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-failed" aria-hidden="true" />
          <p className="text-ink">
            <span className="font-semibold text-failed">The pull request changes protected files</span> ({v.tampering.join(", ")}), so a person must decide.
          </p>
        </div>
      )}

      <ul className="mt-4 divide-y divide-rule sm:hidden">
        {v.criteria.map((c) => {
          const r = RESULT[c.verdict];
          return (
            <li key={c.id} className="py-3 text-sm">
              <p className={`flex items-center gap-1.5 font-medium ${r.cls}`}>
                <r.icon className="size-4" aria-hidden="true" />
                {r.label}
                <span className="font-normal text-ink-2">· {c.source === "test" ? "CI test" : `AI review, ${Math.round(c.confidence * 100)}%`}</span>
              </p>
              <p className="mt-1 text-ink">
                <span className="font-mono text-xs text-ink-3">{c.id}</span> {criteriaText[c.id] ?? ""}
              </p>
              <p className="mt-1 text-xs">
                <Evidence text={c.evidence[0] ?? ""} />
              </p>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-rule-strong text-xs text-ink-2">
              <th scope="col" className="py-2 pr-3 font-medium">Criterion</th>
              <th scope="col" className="py-2 pr-3 font-medium">Checked by</th>
              <th scope="col" className="py-2 pr-3 font-medium">Result</th>
              <th scope="col" className="py-2 font-medium">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {v.criteria.map((c) => {
              const r = RESULT[c.verdict];
              return (
                <tr key={c.id} className="border-b border-rule align-top last:border-b-0">
                  <td className="py-2.5 pr-3">
                    <span className="font-mono text-xs text-ink-3">{c.id}</span> <span className="text-ink">{criteriaText[c.id] ?? ""}</span>
                    {c.kind === "nice" && <span className="ml-1 text-xs text-ink-3">(nice to have)</span>}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3 text-ink-2">{c.source === "test" ? "CI test" : `AI review, ${Math.round(c.confidence * 100)}%`}</td>
                  <td className={`whitespace-nowrap py-2.5 pr-3 font-medium ${r.cls}`}>
                    <span className="inline-flex items-center gap-1">
                      <r.icon className="size-4" aria-hidden="true" />
                      {r.label}
                    </span>
                  </td>
                  <td className="max-w-[260px] py-2.5 text-xs">
                    <Evidence text={c.evidence[0] ?? ""} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 border-t border-rule pt-3 text-sm text-ink">
        <span className="font-semibold">Decided by fixed rules, not the model:</span> {review.reasons?.join("; ")}.
      </p>
      {v.feedbackForWorker && <p className="mt-2 text-sm text-ink-2">{v.feedbackForWorker}</p>}
    </section>
  );
}
