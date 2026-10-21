import type { ModelCall } from "@/lib/ai/client";
import { termsSchema } from "@/lib/contract/terms";
import { db, withMilestoneLock } from "@/lib/db";
import { InvariantViolation } from "@/lib/errors";
import { audit, getMilestone, transition, type Milestone } from "@/lib/milestones/repo";
import { defaultDeps, releaseFunds, syncMilestone, type Deps } from "@/lib/money/flow";
import { githubClient, parsePrUrl, type GitHub } from "./github";
import { decide, type Verdict } from "./policy";
import { verifyCodePr, verifyText } from "./verifiers";

// Deliver → review → decide → (objection window) → release. The verifier and the AI only produce a
// Verdict; `decide` (fixed code) picks the outcome, and only releaseFunds moves money (money rule 1).

export type ReviewDeps = { github: GitHub; aiCall?: ModelCall; money: Deps };

export function defaultReviewDeps(): ReviewDeps {
  return { github: githubClient(), money: defaultDeps() };
}

export function objectionWindowMs(): number {
  const s = Number(process.env.OBJECTION_WINDOW_SECONDS ?? "120"); // 48 h in production; 2 min for the demo
  return (Number.isFinite(s) && s >= 0 ? s : 120) * 1000;
}

/** The worker hands in the deliverable. A PR must be in the contract's repo and cite the signed terms. */
export async function submitDeliverable(milestoneId: string, input: { prUrl?: string; text?: string }, deps: ReviewDeps = defaultReviewDeps()): Promise<Milestone> {
  return withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    if (m.state !== "FUNDED" && m.state !== "CHANGES_REQUESTED") throw new InvariantViolation(`milestone is ${m.state}; work can be submitted once it is funded`);
    if (m.verifier === "rubric_text") {
      const text = input.text?.trim() ?? "";
      if (text.length < 20 || text.length > 60_000) throw new InvariantViolation("the deliverable text must be 20 to 60,000 characters");
      return transition(db(), m, "SUBMITTED", "freelancer", { deliverable_text: text }, { event: "deliverable:submitted" });
    }
    const ref = input.prUrl ? parsePrUrl(input.prUrl) : undefined;
    if (!ref) throw new InvariantViolation("prUrl must be a GitHub pull request URL");
    if (m.repo && `${ref.owner}/${ref.repo}`.toLowerCase() !== m.repo.toLowerCase()) throw new InvariantViolation(`the PR must be in ${m.repo}, the repository in the signed terms`);
    const pr = await deps.github.pr(ref.owner, ref.repo, ref.number);
    if (pr.state !== "open" && !pr.merged) throw new InvariantViolation("that pull request is closed");
    if (!m.criteria_hash || !pr.body.includes(`Milestone-Terms: ${m.criteria_hash}`)) {
      throw new InvariantViolation(`add this line to the PR description so CI runs the signed tests: Milestone-Terms: ${m.criteria_hash}`);
    }
    return transition(db(), m, "SUBMITTED", "freelancer", { pr_url: input.prUrl!.trim() }, { event: "deliverable:submitted", detail: { headSha: pr.headSha } });
  });
}

/** Run the verifier and apply the policy. Idempotent per commit: a commit's verdict is computed once. */
export async function reviewMilestone(milestoneId: string, deps: ReviewDeps = defaultReviewDeps()): Promise<Milestone> {
  return withMilestoneLock(milestoneId, async () => {
    let m = await getMilestone(milestoneId);
    if (m.state !== "SUBMITTED" && m.state !== "IN_REVIEW") return m;
    if (m.state === "SUBMITTED") m = await transition(db(), m, "IN_REVIEW", "system", {}, { event: "review:started" });
    const terms = termsSchema.parse(m.criteria);

    // A commit already decided keeps its decision (never re-review the same commit).
    let sha: string | null = null;
    if (m.verifier === "code_pr") {
      const ref = parsePrUrl(m.pr_url ?? "")!;
      sha = (await deps.github.pr(ref.owner, ref.repo, ref.number)).headSha;
      const prior = await db().query<{ verdict: Verdict; decision: string }>("select verdict, decision from reviews where milestone_id = $1 and head_sha = $2 and status = 'done'", [m.id, sha]);
      if (prior.rows[0]) return applyDecision(m, prior.rows[0].verdict, deps, false);
    }

    const result = m.verifier === "code_pr" ? await verifyCodePr(m, terms, deps) : await verifyText(m, terms, deps);
    if (result.status === "pending") {
      await db().query(
        `insert into reviews (milestone_id, head_sha, status, reasons) values ($1, $2, 'pending', $3)
         on conflict (milestone_id, head_sha) do update set reasons = excluded.reasons, updated_at = now()`,
        [m.id, result.headSha ?? "text", JSON.stringify([result.reason])],
      );
      return m;
    }
    return applyDecision(m, result.verdict, deps, true);
  });
}

async function applyDecision(m: Milestone, verdict: Verdict, deps: ReviewDeps, fresh: boolean): Promise<Milestone> {
  const { decision, reasons } = decide(verdict);
  const key = verdict.headSha ?? `text-${m.id}-${Date.now()}`;
  if (fresh) {
    await db().query(
      `insert into reviews (milestone_id, head_sha, status, verdict, decision, reasons, model) values ($1, $2, 'done', $3, $4, $5, $6)
       on conflict (milestone_id, head_sha) do update set status = 'done', verdict = excluded.verdict, decision = excluded.decision,
         reasons = excluded.reasons, model = excluded.model, updated_at = now()`,
      [m.id, key, JSON.stringify(verdict), decision, JSON.stringify(reasons), verdict.model],
    );
  }
  const set = decision === "PASSED" ? { release_after: new Date(Date.now() + objectionWindowMs()) } : {};
  const out = await transition(db(), m, decision, "system", set, {
    event: `review:${decision.toLowerCase()}`,
    detail: { reasons, summary: verdict.summary, headSha: verdict.headSha, model: verdict.model, injection: verdict.injection.detected, tampering: verdict.tampering },
  });
  if (fresh && m.verifier === "code_pr" && m.pr_url) await postComment(m, verdict, decision, reasons, deps);
  return out;
}

async function postComment(m: Milestone, v: Verdict, decision: string, reasons: string[], deps: ReviewDeps) {
  const ref = parsePrUrl(m.pr_url!)!;
  const icon = (x: string) => (x === "pass" ? "✅" : x === "fail" ? "❌" : "❔");
  const body = [
    `### Milestone review: **${decision.replace("_", " ")}**`,
    `$${(m.amount_cents / 100).toFixed(2)} held on PayPal · terms \`${m.criteria_hash?.slice(0, 12)}\` · commit \`${v.headSha?.slice(0, 7)}\``,
    "",
    "| | Criterion | Checked by | Evidence |",
    "|---|---|---|---|",
    ...v.criteria.map((c) => `| ${icon(c.verdict)} | ${c.id} (${c.kind}) | ${c.source === "test" ? "CI test" : `AI (${Math.round(c.confidence * 100)}%)`} | ${(c.evidence[0] ?? "").replace(/\|/g, "\\|").slice(0, 140)} |`),
    "",
    `**Decision (fixed rules, not the model):** ${reasons.join("; ")}.`,
    ...(v.injection.detected ? ["", `⚠️ Text aimed at the AI reviewer was found and ignored: \`${(v.injection.quotes[0] ?? "").replace(/`/g, "'")}\``] : []),
    ...(v.feedbackForWorker ? ["", v.feedbackForWorker] : []),
  ].join("\n");
  try {
    await deps.github.comment(ref.owner, ref.repo, ref.number, body);
  } catch (err) {
    await audit(db(), { milestoneId: m.id, actor: "system", event: "review:comment_failed", detail: { error: String(err) } });
  }
}

/** The client settles a HUMAN_CHECK. */
export async function humanDecision(milestoneId: string, approve: boolean): Promise<Milestone> {
  return withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    if (m.state !== "HUMAN_CHECK") throw new InvariantViolation("there is nothing waiting for your decision");
    return approve
      ? transition(db(), m, "PASSED", "client", { release_after: new Date(Date.now() + objectionWindowMs()) }, { event: "review:approved_by_client" })
      : transition(db(), m, "CHANGES_REQUESTED", "client", {}, { event: "review:changes_by_client" });
  });
}

/** The client objects inside the window; the money stays held. */
export async function objectToRelease(milestoneId: string): Promise<Milestone> {
  return withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    if (m.state !== "PASSED") throw new InvariantViolation("you can only object while a passed milestone waits to be released");
    if (m.release_after && m.release_after.getTime() <= Date.now()) throw new InvariantViolation("the objection window has closed");
    return transition(db(), m, "CONTESTED", "client", {}, { event: "release:objected" });
  });
}

/**
 * Move a milestone forward without a human: review once CI is done, release once the objection window
 * has passed, and sync payouts. Safe to call often (page polling, a cron ping): every step is idempotent.
 */
export async function tick(milestoneId: string, deps: ReviewDeps = defaultReviewDeps()): Promise<Milestone> {
  let m = await getMilestone(milestoneId);
  if (m.state === "SUBMITTED" || m.state === "IN_REVIEW") m = await reviewMilestone(m.id, deps);
  if (m.state === "PASSED" && m.release_after && m.release_after.getTime() <= Date.now()) m = await releaseFunds(m.id, deps.money);
  if (m.state === "RELEASED") m = await syncMilestone(m.id, deps.money);
  return m;
}

export async function tickAll(deps: ReviewDeps = defaultReviewDeps()): Promise<{ id: string; state?: string; error?: string }[]> {
  const { rows } = await db().query<{ id: string }>(
    "select id from milestones where state in ('SUBMITTED','IN_REVIEW','PASSED','RELEASED') and updated_at > now() - interval '7 days' order by updated_at limit 10",
  );
  const out = [];
  for (const { id } of rows) {
    try {
      out.push({ id, state: (await tick(id, deps)).state });
    } catch (err) {
      out.push({ id, error: String(err).slice(0, 200) });
    }
  }
  return out;
}
