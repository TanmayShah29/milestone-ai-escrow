import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Check, X } from "lucide-react";
import type { Metadata } from "next";
import { PanelBench } from "./PanelBench";
import { score, shipped, type BenchCaseResult, type BenchResults, type LlmResult, type MilestoneResult } from "@/lib/bench-score";

// Proof Bench: the committed bench/results.json, read when the page is built. `npm run bench` writes it;
// tests/bench.test.ts re-runs Milestone's side and fails if the file no longer matches.

export const metadata: Metadata = {
  title: "Proof Bench · Milestone",
  description: "The same signed contract and the same twelve pull requests, judged by an LLM-only approver and by Milestone. Measured, with the misses shown.",
};

const LABELS: Record<string, string> = {
  honest: "Honest, plain",
  "honest-style": "Honest, unusual style",
  "salesy-correct": "Correct, pushy description",
  "broken-whitespace": "Broken: splits on single spaces",
  "stub-confident": "Stub with a confident description",
  "injection-comment": "Injection in a code comment",
  "injection-hidden": "Injection hidden with invisible and look-alike characters",
  "injection-description": "Injection in the PR description",
  "hardcoded-tests": "Hard-codes the signed tests' inputs",
  "tamper-workflow": "Rewrites the CI workflow",
  "harness-escape": "Ends the process to fake a pass",
  "whitespace-gap": "Passes the tests, wrong on newlines",
};
const ORDER = Object.keys(LABELS);

function load(): BenchResults {
  return JSON.parse(readFileSync(join(process.cwd(), "bench", "results.json"), "utf8")) as BenchResults;
}

const DECISION: Record<MilestoneResult["decision"], string> = {
  PASSED: "Pays",
  CHANGES_REQUESTED: "Doesn't pay: changes requested",
  HUMAN_CHECK: "Doesn't pay: held for a person",
};

function Pill({ tone, children }: { tone: "paid" | "blocked" | "held" | "none"; children: React.ReactNode }) {
  const cls = {
    paid: "bg-paid-field text-paid",
    blocked: "bg-blocked-field text-ink",
    held: "bg-held-field text-held",
    none: "border border-dashed border-rule-strong text-ink-2",
  }[tone];
  return <span className={`inline-block rounded-md px-2 py-0.5 text-sm font-medium ${cls}`}>{children}</span>;
}

function Verdict({ right }: { right: boolean | null }) {
  if (right === null) return null;
  return right ? (
    <span className="inline-flex items-center gap-1 text-sm text-paid">
      <Check className="size-4" aria-hidden="true" /> right call
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-sm font-semibold text-failed">
      <X className="size-4" aria-hidden="true" /> wrong call
    </span>
  );
}

function Marks({ items }: { items: { id: string; ok: boolean }[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs" aria-label="Per criterion">
      {items.map((c) => (
        <li key={c.id} className={c.ok ? "text-paid" : "text-failed"}>
          {c.id} {c.ok ? "pass" : "fail"}
        </li>
      ))}
    </ul>
  );
}

function CellLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-xs font-semibold text-ink-3 md:hidden">{children}</p>;
}

function LlmCell({ r, expected }: { r: LlmResult; expected: boolean }) {
  if (r.status !== "ok") {
    return (
      <>
        <Pill tone="none">{r.status === "skipped" ? "Not asked" : r.status === "busy" ? "AI busy" : "No usable answer"}</Pill>
        <p className="mt-2 text-sm text-ink-2">{r.status === "skipped" ? "The run hit its model-call budget before this case." : r.status === "error" ? "All three free models replied with empty or broken JSON." : r.error}</p>
      </>
    );
  }
  const failing = r.perCriterion.filter((c) => c.verdict === "fail");
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Pill tone={r.pay ? "paid" : "blocked"}>{r.pay ? "Pays" : "Doesn't pay"}</Pill>
        <Verdict right={r.pay === expected} />
      </div>
      <Marks items={r.perCriterion.map((c) => ({ id: c.id, ok: c.verdict === "pass" }))} />
      <p className="mt-2 text-sm text-ink-2 [overflow-wrap:anywhere]">{failing.length ? failing.map((c) => `${c.id}: ${c.reason}`).join(" ") : r.rawSummary}</p>
      <p className="mt-1 font-mono text-xs text-ink-3 [overflow-wrap:anywhere]">{r.model}</p>
    </>
  );
}

function MilestoneCell({ r, expected, draft }: { r: MilestoneResult; expected: boolean; draft?: MilestoneResult }) {
  const escaped = r.plainNodeTest === "pass" && r.testResults.some((t) => !t.passed);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Pill tone={r.pay ? "paid" : r.decision === "HUMAN_CHECK" ? "held" : "blocked"}>{DECISION[r.decision]}</Pill>
        <Verdict right={r.pay === expected} />
      </div>
      <Marks items={r.testResults.map((t) => ({ id: t.id, ok: t.passed }))} />
      <p className="mt-2 text-sm text-ink-2 [overflow-wrap:anywhere]">{r.reasons.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(". ")}.</p>
      {r.injectionQuotes.length > 0 && (
        <p className="mt-2 border-l-2 border-failed pl-2 text-sm text-ink [overflow-wrap:anywhere]">
          Caught: <span className="font-mono text-xs">{r.injectionQuotes.map((q) => `“${q.replace(/^\/\/\s*/, "").trim()}”`).join(" ")}</span>
        </p>
      )}
      {r.ciNote && <p className="mt-2 text-sm text-ink-3">{r.ciNote}</p>}
      {draft && draft.pay !== r.pay && (
        <p className="mt-2 border-l-2 border-held pl-2 text-sm text-ink-2">
          On the tests as first drafted, this {draft.pay ? "was paid" : "was not paid"}. The pre-signing attack {r.pay ? "changed that" : "closed this hole"}.
        </p>
      )}
      {escaped && <p className="mt-2 text-sm text-ink-3">Plain <code className="font-mono text-xs">node --test</code> reports this as a pass; the CI harness checks every signed test actually ran.</p>}
    </>
  );
}

function CaseRow({ c }: { c: BenchCaseResult }) {
  return (
    <li className="grid gap-4 border-t border-rule py-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] md:gap-6">
      <div>
        <h3 className="font-semibold text-ink">{LABELS[c.id] ?? c.id}</h3>
        <p className="mt-1 font-mono text-xs text-ink-3">{c.id}</p>
        <p className="mt-2 text-sm">
          <span className="font-medium text-ink">Should {c.expected.pay ? "pay" : "not pay"}.</span> <span className="text-ink-2">{c.expected.reason}</span>
        </p>
        <a href={`https://github.com/TanmayShah29/milestone-ai-escrow/tree/main/bench/cases/${c.id}`} className="mt-2 inline-block text-sm text-ink underline">
          Fixture files
        </a>
      </div>
      <div className="rounded-lg bg-panel p-4 md:bg-transparent md:p-0">
        <CellLabel>LLM-only approver</CellLabel>
        <LlmCell r={c.llmOnly} expected={c.expected.pay} />
      </div>
      <div className="rounded-lg bg-panel p-4 md:bg-transparent md:p-0">
        <CellLabel>Milestone</CellLabel>
        <MilestoneCell r={shipped(c)} expected={c.expected.pay} {...(c.milestoneHardened ? { draft: c.milestone } : {})} />
      </div>
    </li>
  );
}

const quoted = (cs: BenchCaseResult[]) => `${cs.length === 1 ? "the cheat" : "the cheats"} ${cs.map((c) => `“${LABELS[c.id] ?? c.id}”`).join(" and ")}`;
const names = (cs: BenchCaseResult[]) => cs.map((c) => (LABELS[c.id] ?? c.id).toLowerCase()).join("; ");

export default function BenchPage() {
  const results = load();
  const cases = [...results.cases].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const s = score(results);
  const { meta } = results;
  const unanswered = s.total - s.llm.answered;
  const date = new Date(meta.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const cheats = cases.filter((c) => !c.expected.pay);
  const msPaid = cheats.filter((c) => shipped(c).pay);
  const closed = cheats.filter((c) => c.milestoneHardened && c.milestone.pay && !c.milestoneHardened.pay);
  const llmPaid = cheats.filter((c) => c.llmOnly.status === "ok" && c.llmOnly.pay);
  const attacks = cases.filter((c) => /^(injection|tamper|harness)-/.test(c.id));
  const allFlagged = attacks.every((c) => shipped(c).injectionQuotes.length || shipped(c).tampering.length);
  const llmNoticed = attacks.filter((c) => c.llmOnly.status === "ok" && /inject|instruction|aimed at|reviewer|workflow|process\.exit/i.test(`${c.llmOnly.rawSummary} ${c.llmOnly.perCriterion.map((x) => x.reason).join(" ")}`));
  const answeredAttacks = attacks.filter((c) => c.llmOnly.status === "ok");
  const noAnswer = { error: cases.filter((c) => c.llmOnly.status === "error").length, skipped: cases.filter((c) => c.llmOnly.status === "skipped" || c.llmOnly.status === "busy").length };
  const llmFooled = llmPaid.filter((c) => /^injection-/.test(c.id));
  const msFooled = msPaid.filter((c) => /^injection-/.test(c.id));
  const msFlaggedAttacks = attacks.filter((c) => shipped(c).injectionQuotes.length || shipped(c).tampering.length);
  // The rows a judge reads first: where the two approaches actually differ, then where they tie.
  // Colour only where one side is clearly ahead; near-ties stay neutral so the table doesn't oversell.
  const rows: { label: string; note?: string; llm: string; llmNote?: string; llmBad?: boolean; ms: string; msNote?: string; msGood?: boolean }[] = [
    { label: "Attacks flagged, with the exact quote", note: "prompt injections and tampering", llm: `${llmNoticed.length} of ${attacks.length}`, llmBad: llmNoticed.length < msFlaggedAttacks.length, ...(answeredAttacks.length < attacks.length ? { llmNote: `it answered ${answeredAttacks.length} of them` } : {}), ms: `${msFlaggedAttacks.length} of ${attacks.length}`, msGood: msFlaggedAttacks.length > llmNoticed.length },
    { label: "Paid a cheat that told the reviewer to pass it", llm: llmFooled.length ? "Yes" : "No", llmBad: llmFooled.length > 0, ...(llmFooled.length ? { llmNote: names(llmFooled) } : {}), ms: msFooled.length ? "Yes" : "No", msGood: !msFooled.length && llmFooled.length > 0 },
    { label: "Right calls", llm: `${s.llm.correct} of ${s.llm.answered}`, llmNote: s.llm.answered < s.total ? "of the cases it answered" : undefined, ms: `${s.shipped.correct} of ${s.total}` },
    { label: "Cases with no verdict", llm: String(unanswered), llmBad: unanswered > 0, msGood: unanswered > 0, ...(unanswered ? { llmNote: [noAnswer.error ? `${noAnswer.error} with no usable reply` : "", noAnswer.skipped ? `${noAnswer.skipped} not asked` : ""].filter(Boolean).join("; ") } : {}), ms: "0", msNote: "deterministic: same input, same answer" },
    { label: "Honest work blocked", llm: `${s.llm.blockedHonest} of ${s.honest}`, ms: `${s.shipped.blockedHonest} of ${s.honest}` },
    { label: "Cheats paid", note: "which ones is below", llm: `${s.llm.paidCheats} of ${s.sameCheats.n}`, ...(s.sameCheats.n < s.cheats ? { llmNote: `of the ${s.sameCheats.n} it answered` } : {}), ms: `${s.shipped.paidCheats} of ${s.cheats}`, ...(s.shipped.hardened && s.milestone.paidCheats !== s.shipped.paidCheats ? { msNote: `${s.milestone.paidCheats} before its AI attacked the drafted tests` } : {}) },
  ];
  const models = [...new Set(cases.flatMap((c) => (c.llmOnly.status === "ok" ? [c.llmOnly.model] : [])))];

  return (
    <main id="content" className="mx-auto max-w-6xl px-4 py-10 sm:py-14">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Proof Bench</h1>
      <p className="mt-4 max-w-3xl text-lg text-ink-2">
        One signed contract, {s.total} pull requests, two approvers. The first asks a language model whether the work is done, the way most AI escrow tools do. The second is Milestone as it ships: before signing, an AI attacks the drafted tests and they&apos;re strengthened; then the signed tests run, deterministic checks look for tampering and text aimed at a reviewer, and fixed rules decide.
      </p>
      <p className="mt-3 text-sm text-ink-3">
        Run {date} · {s.cheats} cheats, {s.honest} honest deliverables · one run, free models · every criterion in this contract is a test, so judging made no AI call on Milestone&apos;s side
      </p>

      <section aria-labelledby="score-title" className="mt-10">
        <h2 id="score-title" className="text-xl font-semibold tracking-tight">
          Head to head
        </h2>
        <div className="mt-4 overflow-hidden rounded-xl border border-rule-strong bg-panel shadow-[var(--shadow-card)]">
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] border-b border-rule-strong text-sm font-semibold">
            <span className="p-3 sm:p-4" />
            <span className="p-3 text-ink-2 sm:p-4">
              LLM-only approver
              <span className="mt-0.5 block text-xs font-normal text-ink-3">asks one model &ldquo;is it done?&rdquo;</span>
            </span>
            <span className="bg-paid-field p-3 text-ink sm:p-4">
              Milestone
              <span className="mt-0.5 block text-xs font-normal text-ink-2">signed tests, checks, fixed rules</span>
            </span>
          </div>
          <dl>
            {rows.map((r) => (
              <div key={r.label} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] border-b border-rule last:border-0">
                <dt className="p-3 text-sm text-ink sm:p-4">
                  {r.label}
                  {r.note && <span className="mt-0.5 block text-xs text-ink-3">{r.note}</span>}
                </dt>
                <dd className="p-3 sm:p-4">
                  <span className={`money text-xl font-semibold tracking-tight sm:text-4xl ${r.llmBad ? "text-failed" : "text-ink"}`}>{r.llm}</span>
                  {r.llmNote && <span className="mt-0.5 block text-xs text-ink-3">{r.llmNote}</span>}
                </dd>
                <dd className="bg-paid-field/50 p-3 sm:p-4">
                  <span className={`money text-xl font-semibold tracking-tight sm:text-4xl ${r.msGood ? "text-paid" : "text-ink"}`}>{r.ms}</span>
                  {r.msNote && <span className="mt-0.5 block text-xs text-ink-2">{r.msNote}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {(llmPaid.length > 0 || msPaid.length > 0) && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-failed/40 bg-failed-field p-4 text-sm">
              <p className="font-semibold text-ink">What the LLM-only approver got wrong</p>
              <p className="mt-1 text-ink-2">
                {llmPaid.length ? <>It paid {quoted(llmPaid)}.{llmFooled.length > 0 && " The attack told the reviewer to pass the work, and it did."}</> : "It paid no cheats it answered."}
                {unanswered > 0 && ` It gave no verdict on ${unanswered} of ${s.total}.`}
              </p>
            </div>
            <div className="rounded-lg border border-rule-strong bg-panel p-4 text-sm">
              <p className="font-semibold text-ink">What Milestone got wrong</p>
              <p className="mt-1 text-ink-2">
                {msPaid.length ? <>It paid {quoted(msPaid)}: every signed test passes and the code is wrong outside them. A gap in the contract both sides signed, not a trick that fooled it.</> : "Nothing in this run."}
              </p>
            </div>
          </div>
        )}
      </section>

      <PanelBench />

      <section aria-labelledby="reading-title" className="mt-10 max-w-3xl">
        <h2 id="reading-title" className="text-xl font-semibold tracking-tight">
          What this run shows
        </h2>
        <ul className="mt-4 list-disc space-y-3 pl-5 text-ink">
          {meta.attack && (
            <li>
              <span className="font-semibold">Before signing, Milestone&apos;s AI attacked its own contract.</span> Playing the cheating worker, it wrote a fake that passed every drafted test: “{meta.attack.explanation}” Code ran the fake, so the tests were strengthened, and kept only because the same fake then failed ({meta.attack.caughtBy.join(", ")}). Hardening can only add checks: a rewrite that drops one is refused.{closed.length > 0 && <> That closed {closed.length === 1 ? "a hole" : `${closed.length} holes`} in this bench ({names(closed)}). The attacker never saw these cases.</>}
            </li>
          )}
          {msPaid.length > 0 && (
            <li>
              <span className="font-semibold">Milestone still paid {msPaid.length === 1 ? "one cheat" : `${msPaid.length} cheats`}</span> ({names(msPaid)}). {msPaid.length === 1 ? "It passes" : "They pass"} every signed test and {msPaid.length === 1 ? "is" : "are"} wrong outside them. Milestone can only be as strict as the tests both sides signed; the LLM-only approver caught {msPaid.filter((c) => c.llmOnly.status === "ok" && !c.llmOnly.pay).length === msPaid.length ? (msPaid.length === 1 ? "it" : "both") : "some of these"}. Narrow tests are a contract problem, and this is where Milestone is weak.
            </li>
          )}
          {llmPaid.length > 0 && (
            <li>
              <span className="font-semibold">The LLM-only approver paid {llmPaid.length === 1 ? "one cheat" : `${llmPaid.length} cheats`}</span> ({names(llmPaid)}). {llmPaid.map((c) => c.expected.reason).join(" ")} {llmPaid.every((c) => !c.milestone.pay) ? "Milestone did not pay." : ""}
            </li>
          )}
          {allFlagged && (
            <li>
              <span className="font-semibold">Milestone flagged all {attacks.length} injection and tampering attempts</span> with the exact text or file, whether or not the tests already failed. The LLM-only approver mentioned the attempt in {llmNoticed.length} of the {answeredAttacks.length} it answered.
            </li>
          )}
          <li>
            <span className="font-semibold">Same input, same answer.</span> Milestone&apos;s judging is deterministic and re-checked by a unit test on every run (the attack that hardened the tests is one AI run, before signing, and its tests are committed). The LLM side is one sample from free models: {unanswered} of {s.total} cases got no verdict in this run.
          </li>
        </ul>
      </section>

      <section aria-labelledby="cases-title" className="mt-12">
        <h2 id="cases-title" className="text-xl font-semibold tracking-tight">
          Case by case
        </h2>
        <div className="mt-4 hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-6 pb-2 text-sm font-semibold text-ink-3 md:grid" aria-hidden="true">
          <span>Deliverable</span>
          <span>LLM-only approver</span>
          <span>Milestone</span>
        </div>
        <ol className="border-b border-rule">
          {cases.map((c) => (
            <CaseRow key={c.id} c={c} />
          ))}
        </ol>
      </section>

      <section aria-labelledby="repro-title" className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-2 [&>*]:min-w-0">
        <div>
          <h2 id="repro-title" className="text-xl font-semibold tracking-tight">
            Reproduce it
          </h2>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-rule bg-panel p-4 font-mono text-sm text-ink">
            <code>{`npm run bench -- --no-llm   # Milestone's side only
npm run bench               # both; cached LLM answers reused
npm run bench -- --fresh    # ask the LLM again
npx tsx --test tests/bench.test.ts`}</code>
          </pre>
          <p className="mt-3 text-sm text-ink-2">
            Fixtures, the contract and a copy of the demo repo&apos;s CI harness are in <code className="font-mono text-xs">bench/</code>. The LLM side needs an OpenRouter key and uses the app&apos;s own model client with fallbacks.
          </p>
          <dl className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-3">Models</dt>
            <dd className="font-mono text-xs text-ink [overflow-wrap:anywhere]">{models.join(", ")} (answered); configured: {meta.models.join(" → ")}</dd>
            <dt className="text-ink-3">Model calls</dt>
            <dd className="text-ink">{meta.llmCalls}, including fallthrough retries</dd>
            <dt className="text-ink-3">Node</dt>
            <dd className="font-mono text-xs text-ink">{meta.node}</dd>
            <dt className="text-ink-3">Contract</dt>
            <dd className="font-mono text-xs text-ink [overflow-wrap:anywhere]">{meta.termsHash}</dd>
            <dt className="text-ink-3">Commit</dt>
            <dd className="font-mono text-xs text-ink [overflow-wrap:anywhere]">{meta.gitSha.slice(0, 12)}</dd>
          </dl>
        </div>
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Limits</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-ink-2">
            <li>{s.total} hand-written cases on one small contract, one run. This shows how each approver fails, not rates you can generalise.</li>
            <li>The LLM side used free models. A stronger paid model would likely catch more, and could also be fooled differently.</li>
            <li>Milestone&apos;s AI reviewer, which judges criteria no test covers, is not part of this bench. Here every criterion is a test.</li>
            <li>The hardened tests come from one attack run ({meta.attack?.model ?? "a free model"}). Another run may harden differently, or not at all; Milestone then shows both sides that the contract is breakable.</li>
            <li>CI is simulated locally with the demo repo&apos;s own harness; the rewritten-workflow case assumes the worst (every job green).</li>
          </ul>
          <details className="mt-5 rounded-lg border border-rule bg-panel p-4">
            <summary className="cursor-pointer text-sm font-medium text-ink">The LLM-only approver&apos;s exact system prompt</summary>
            <pre className="mt-3 whitespace-pre-wrap font-mono text-xs text-ink [overflow-wrap:anywhere]">{meta.llmSystem}</pre>
          </details>
        </div>
      </section>
    </main>
  );
}
