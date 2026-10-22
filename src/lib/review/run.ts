import { AiBusy, AiUnreadable, configuredModels, type ModelCall } from "@/lib/ai/client";
import { termsSchema, type Terms } from "@/lib/contract/terms";
import { db, withMilestoneLock } from "@/lib/db";
import { stateLabel } from "@/lib/client/states";
import { InvariantViolation } from "@/lib/errors";
import { audit, getMilestone, transition, type Milestone } from "@/lib/milestones/repo";
import { cancelHold, defaultDeps, releaseFunds, syncMilestone, type Deps } from "@/lib/money/flow";
import { githubClient, parsePrUrl, type GitHub, type PullRequest } from "./github";
import { HOLD_DECIDE_MARGIN_MS, humanCheckDeadline, objectionReleaseMs, objectionWindowMs } from "./deadlines";
import { decide, humanTimeoutOutcome, type Verdict } from "./policy";
import { citedTerms, termsLineProblem, verifyCodePr, verifyText } from "./verifiers";

// Deliver → review → decide → (objection window) → release. The verifier and the AI only produce a
// Verdict; `decide` (fixed code) picks the outcome, and only releaseFunds moves money (money rule 1).

export type ReviewDeps = { github: GitHub; aiCall?: ModelCall; money: Deps };

export function defaultReviewDeps(): ReviewDeps {
  return { github: githubClient(), money: defaultDeps() };
}

export { humanCheckDeadline, objectionReleaseMs, objectionWindowMs };

/** A second review the AI couldn't finish (busy, unreadable) is retried at most this often. */
const SECOND_REVIEW_RETRY_MS = 5 * 60_000;

/** The most a client's objection or change request reason may be. */
export const REASON_MAX = 1000;

function cleanReason(reason: string | undefined): string | null {
  const r = reason?.trim() ?? "";
  if (r.length > REASON_MAX) throw new InvariantViolation(`Keep the reason under ${REASON_MAX.toLocaleString("en-US")} characters.`);
  return r || null;
}

/** The worker hands in the deliverable. A PR must be in the contract's repo and cite the signed terms. */
export async function submitDeliverable(milestoneId: string, input: { prUrl?: string; text?: string }, deps: ReviewDeps = defaultReviewDeps()): Promise<Milestone> {
  return withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    if (m.state !== "FUNDED" && m.state !== "CHANGES_REQUESTED") throw new InvariantViolation(`Work can be submitted once the milestone is funded. Right now it is: ${stateLabel(m.state)}.`);
    if (m.verifier === "rubric_text") {
      const text = input.text?.trim() ?? "";
      if (text.length < 20 || text.length > 60_000) throw new InvariantViolation("The deliverable must be between 20 and 60,000 characters.");
      return transition(db(), m, "SUBMITTED", "freelancer", { deliverable_text: text }, { event: "deliverable:submitted" });
    }
    const ref = input.prUrl ? parsePrUrl(input.prUrl) : undefined;
    if (!ref) throw new InvariantViolation("Paste a GitHub pull request link, like https://github.com/owner/repo/pull/12.");
    if (m.repo && `${ref.owner}/${ref.repo}`.toLowerCase() !== m.repo.toLowerCase()) throw new InvariantViolation(`The pull request must be in ${m.repo}, the repository named in the signed terms.`);
    const pr = await deps.github.pr(ref.owner, ref.repo, ref.number);
    if (pr.state !== "open" && !pr.merged) throw new InvariantViolation("That pull request is closed. Reopen it, or open a new one, then submit again.");
    const { count } = citedTerms(pr.body);
    if (termsLineProblem(pr.body, m.criteria_hash)) {
      const line = `Milestone-Terms: ${m.criteria_hash}`;
      throw new InvariantViolation(
        count === 0
          ? `Add this line to the pull request description so CI runs the signed tests, then submit again: ${line}`
          : count > 1
            ? `The pull request description has more than one Milestone-Terms line. Keep only this one, then submit again: ${line}`
            : `The pull request description cites different terms. Replace that line with this one, then submit again: ${line}`,
      );
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

    // A commit already decided keeps its decision (never re-review the same commit), unless the PR no
    // longer cites the signed terms: then the verifier blocks it, whatever was decided before.
    let pr: PullRequest | undefined;
    if (m.verifier === "code_pr") {
      const ref = parsePrUrl(m.pr_url ?? "")!;
      pr = await deps.github.pr(ref.owner, ref.repo, ref.number);
      if (!termsLineProblem(pr.body, m.criteria_hash)) {
        const prior = await db().query<{ verdict: Verdict; decision: string }>("select verdict, decision from reviews where milestone_id = $1 and head_sha = $2 and status = 'done'", [m.id, pr.headSha]);
        if (prior.rows[0]) return applyDecision(m, prior.rows[0].verdict, deps, false);
      }
    }

    const result = m.verifier === "code_pr" ? await verifyCodePr(m, terms, deps, pr) : await verifyText(m, terms, deps);
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
  // A blocked verdict is about the PR description, not the commit: keep it off the commit's key, so the
  // commit is reviewed for real once the description is fixed.
  const key = verdict.headSha && !verdict.blocked ? verdict.headSha : `${verdict.blocked ? "blocked" : "text"}-${m.id}-${Date.now()}`;
  if (fresh) {
    await db().query(
      `insert into reviews (milestone_id, head_sha, status, verdict, decision, reasons, model) values ($1, $2, 'done', $3, $4, $5, $6)
       on conflict (milestone_id, head_sha) do update set status = 'done', verdict = excluded.verdict, decision = excluded.decision,
         reasons = excluded.reasons, model = excluded.model, updated_at = now()`,
      [m.id, key, JSON.stringify(verdict), decision, JSON.stringify(reasons), verdict.model],
    );
  }
  // A failed review speaks for itself: drop any earlier client reason so the worker doesn't read a stale one.
  const set = decision === "PASSED" ? { release_after: new Date(Date.now() + objectionWindowMs()) } : decision === "CHANGES_REQUESTED" ? { changes_reason: null } : {};
  const out = await transition(db(), m, decision, "system", set, {
    event: `review:${decision.toLowerCase()}`,
    detail: { reasons, summary: verdict.summary, headSha: verdict.headSha, model: verdict.model, injection: verdict.injection.detected, tampering: verdict.tampering },
  });
  if (fresh && m.verifier === "code_pr" && m.pr_url) await postComment(m, verdict, decision, reasons, deps);
  return out;
}

async function postComment(m: Milestone, v: Verdict, decision: string, reasons: string[], deps: ReviewDeps, heading = "Milestone review") {
  const ref = parsePrUrl(m.pr_url!)!;
  const icon = (x: string) => (x === "pass" ? "✅" : x === "fail" ? "❌" : "❔");
  const body = [
    `### ${heading}: **${decision.replace("_", " ")}**`,
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

/**
 * The client settles a HUMAN_CHECK. Asking for changes takes a reason the worker reads (changes_reason).
 * After an objection the reason is required, and asking for changes counts as the client's one objection:
 * contested_at stays set, so the fixed resubmission, once it passes, can't be objected to again.
 */
export async function humanDecision(milestoneId: string, approve: boolean, opts: { reason?: string } = {}): Promise<Milestone> {
  return withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    if (m.state !== "HUMAN_CHECK") throw new InvariantViolation("There's nothing waiting for your decision right now.");
    if (approve) return transition(db(), m, "PASSED", "client", { release_after: new Date(Date.now() + objectionWindowMs()) }, { event: "review:approved_by_client" });
    const reason = cleanReason(opts.reason);
    if (m.contested_at && !reason) throw new InvariantViolation("You already objected once, so say what needs to change. The worker reads it before fixing the work.");
    return transition(db(), m, "CHANGES_REQUESTED", "client", { changes_reason: reason }, { event: "review:changes_by_client", detail: { reason, afterObjection: !!m.contested_at } });
  });
}

/**
 * The client objects inside the window; the money stays held. An objection buys exactly one second
 * review of the same commit (see resolveObjection), so it can't park the money until the hold lapses.
 * The optional reason is stored for the worker to read (objection_reason).
 */
export async function objectToRelease(milestoneId: string, opts: { reason?: string } = {}): Promise<Milestone> {
  return withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    if (m.state !== "PASSED") throw new InvariantViolation("You can only object while approved work waits to be released.");
    if (m.contested_at) throw new InvariantViolation("You already objected to this work once; there is one objection per milestone.");
    if (m.release_after && m.release_after.getTime() <= Date.now()) throw new InvariantViolation("The objection window has closed.");
    const reason = cleanReason(opts.reason);
    // release_after now carries the date the money releases if the second review passes.
    const now = Date.now();
    return transition(db(), m, "CONTESTED", "client", { contested_at: new Date(now), release_after: new Date(now + objectionReleaseMs()), objection_reason: reason }, { event: "release:objected", detail: { reason } });
  });
}

/**
 * The client didn't decide a HUMAN_CHECK by its deadline (humanCheckDeadline). Fixed rules, no model:
 *  - the latest verdict flagged no tampering and no injection → PASSED with release_after = now, so tick's
 *    usual release path captures and pays out;
 *  - it flagged either → void the hold through the money flow's cancel (CANCELLED); nothing is charged;
 *  - only procedural flags (untrusted CI, a PR too large to scan) and a must-have not confirmed → nothing
 *    automatic: it waits for the client (audited once), and an expired hold ends it.
 * See humanTimeoutOutcome in policy.ts.
 */
export async function expireHumanCheck(milestoneId: string, deps: ReviewDeps = defaultReviewDeps()): Promise<Milestone> {
  return withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    const deadline = humanCheckDeadline(m);
    if (!deadline || deadline.getTime() > Date.now()) return m;
    const { rows } = await db().query<{ verdict: Verdict }>(
      "select verdict from reviews where milestone_id = $1 and status = 'done' and verdict is not null order by updated_at desc, id desc limit 1",
      [m.id],
    );
    const { outcome, reasons } = humanTimeoutOutcome(rows[0]?.verdict);
    const why = m.contested_at ? "within 72 hours of the objection's second review" : "3 days before the PayPal hold expires";
    const detail = { outcome, reasons: [`the client didn't decide ${why}`, ...reasons], deadline: deadline.toISOString(), afterObjection: !!m.contested_at };
    if (outcome === "release") return transition(db(), m, "PASSED", "system", { release_after: new Date() }, { event: "review:human_timeout", detail });
    if (outcome === "wait") {
      const { rows: seen } = await db().query("select 1 from audit_log where milestone_id = $1 and event = 'review:human_timeout' and created_at >= $2 limit 1", [m.id, m.human_check_at ?? m.updated_at]);
      if (!seen[0]) await audit(db(), { milestoneId: m.id, actor: "system", event: "review:human_timeout", fromState: "HUMAN_CHECK", toState: "HUMAN_CHECK", detail });
      return m;
    }
    // Void: the money flow owns the PayPal call, its idempotency key and the CANCELLED transition.
    const out = await cancelHold(m.id, deps.money, { actor: "system" });
    await audit(db(), { milestoneId: m.id, actor: "system", event: "review:human_timeout", fromState: "HUMAN_CHECK", toState: out.state, detail });
    return out;
  });
}

/**
 * The one second review after an objection: the same commit, CI results re-read (not re-run: the GitHub
 * token has no Actions permission), the PR description re-checked, and the review-only criteria judged
 * by a different model than the first review. It bypasses the per-commit cache and is stored under its
 * own key. `decide` (fixed code) picks the outcome:
 *  - PASSED → back to PASSED with release_after = objection + 72 h; tick then releases as usual.
 *  - CHANGES_REQUESTED or HUMAN_CHECK → that state, with the verdict.
 *  - AI busy or CI not final → stay CONTESTED and retry later; no usable verdict by objection + 72 h → HUMAN_CHECK.
 */
export async function resolveObjection(milestoneId: string, deps: ReviewDeps = defaultReviewDeps()): Promise<Milestone> {
  return withMilestoneLock(milestoneId, async () => {
    const m = await getMilestone(milestoneId);
    if (m.state !== "CONTESTED") return m;
    const contestedAt = m.contested_at ?? m.updated_at;
    const releaseAt = new Date(contestedAt.getTime() + objectionReleaseMs());

    // The review that passed the work: its commit is the one the second review must look at again.
    const { rows: firstRows } = await db().query<{ head_sha: string; model: string | null }>(
      "select head_sha, model from reviews where milestone_id = $1 and status = 'done' and head_sha not like '%:second:%' order by updated_at desc limit 1",
      [m.id],
    );
    const first = firstRows[0];
    const reviewedSha = first && /^[0-9a-f]{7,64}$/i.test(first.head_sha) ? first.head_sha : null;
    const key = `${reviewedSha ?? "text"}:second:${contestedAt.getTime()}`;

    const { rows: existing } = await db().query<{ status: string; verdict: Verdict | null; updated_at: Date }>(
      "select status, verdict, updated_at from reviews where milestone_id = $1 and head_sha = $2",
      [m.id, key],
    );
    const prior = existing[0];
    if (prior?.status === "done" && prior.verdict) return applySecondDecision(m, key, prior.verdict, releaseAt, first?.model ?? null, deps, false);
    if (prior?.status === "pending" && Date.now() - prior.updated_at.getTime() < SECOND_REVIEW_RETRY_MS && Date.now() < releaseAt.getTime()) return m;

    // A different model than the first review; if only that one model is configured, it is used again.
    const others = configuredModels().filter((x) => x !== first?.model);
    const verifierDeps = { ...deps, models: others.length ? others : configuredModels() };
    const terms = termsSchema.parse(m.criteria);

    let waiting: string;
    try {
      let result: Awaited<ReturnType<typeof verifyCodePr>>;
      if (m.verifier === "code_pr") {
        const ref = parsePrUrl(m.pr_url ?? "")!;
        const pr = await deps.github.pr(ref.owner, ref.repo, ref.number);
        result =
          reviewedSha && pr.headSha !== reviewedSha
            ? { status: "done", verdict: movedVerdict(terms, reviewedSha, pr.headSha) }
            : await verifyCodePr(m, terms, verifierDeps, pr);
      } else {
        result = await verifyText(m, terms, verifierDeps);
      }
      if (result.status === "done") return applySecondDecision(m, key, result.verdict, releaseAt, first?.model ?? null, deps, true);
      waiting = result.reason;
    } catch (err) {
      if (!(err instanceof AiBusy || err instanceof AiUnreadable)) throw err;
      waiting = `AI busy: ${err.message}`;
    }

    if (Date.now() >= releaseAt.getTime()) {
      return transition(db(), m, "HUMAN_CHECK", "system", {}, { event: "review:second", detail: { decision: "HUMAN_CHECK", reasons: [`no usable second review within 72 hours (${waiting})`] } });
    }
    await db().query(
      `insert into reviews (milestone_id, head_sha, status, reasons) values ($1, $2, 'pending', $3)
       on conflict (milestone_id, head_sha) do update set reasons = excluded.reasons, updated_at = now()`,
      [m.id, key, JSON.stringify([waiting])],
    );
    return m;
  });
}

/** The worker pushed after approval: the approved commit is no longer what would be paid for. */
function movedVerdict(terms: Terms, reviewed: string, now: string): Verdict {
  const blocked = `the pull request changed after it was approved (commit ${reviewed.slice(0, 7)} is now ${now.slice(0, 7)})`;
  return {
    criteria: terms.criteria.map((c) => ({ id: c.id, kind: c.kind, source: c.test ? "test" : "ai", verdict: "unclear", confidence: 0, evidence: [`not checked: ${blocked}`] })),
    summary: `Not reviewed again: ${blocked}.`,
    feedbackForWorker: "New commits were pushed after the work was approved. Submit again so the new commit is reviewed.",
    injection: { detected: false, quotes: [] },
    tampering: [],
    blocked,
    model: null,
    headSha: now,
  };
}

async function applySecondDecision(m: Milestone, key: string, verdict: Verdict, releaseAt: Date, firstModel: string | null, deps: ReviewDeps, fresh: boolean): Promise<Milestone> {
  const { decision, reasons } = decide(verdict);
  if (fresh) {
    await db().query(
      `insert into reviews (milestone_id, head_sha, status, verdict, decision, reasons, model) values ($1, $2, 'done', $3, $4, $5, $6)
       on conflict (milestone_id, head_sha) do update set status = 'done', verdict = excluded.verdict, decision = excluded.decision,
         reasons = excluded.reasons, model = excluded.model, updated_at = now()`,
      [m.id, key, JSON.stringify(verdict), decision, JSON.stringify(reasons), verdict.model],
    );
  }
  // Pass: release at objection + 72 h, and keep contested_at so the client can't object a second time.
  // Fail: clear it, so a fixed resubmission gets a normal objection window again.
  const set = decision === "PASSED" ? { release_after: releaseAt } : decision === "CHANGES_REQUESTED" ? { contested_at: null, changes_reason: null } : {};
  const out = await transition(db(), m, decision, "system", set, {
    event: "review:second",
    detail: { decision, reasons, summary: verdict.summary, headSha: verdict.headSha, model: verdict.model, firstModel, injection: verdict.injection.detected, tampering: verdict.tampering },
  });
  if (fresh && m.verifier === "code_pr" && m.pr_url) await postComment(m, verdict, decision, reasons, deps, "Second review after the client's objection");
  return out;
}

/**
 * Move a milestone forward without a human: review once CI is done, run the second review after an
 * objection, settle a HUMAN_CHECK the client left undecided past its deadline, release once the
 * objection window (or the 72 h after an objection) has passed, and sync payouts. Safe to call often
 * (page polling, a cron ping): every step is idempotent.
 */
export async function tick(milestoneId: string, deps: ReviewDeps = defaultReviewDeps()): Promise<Milestone> {
  let m = await getMilestone(milestoneId);
  if (m.state === "SUBMITTED" || m.state === "IN_REVIEW") m = await reviewMilestone(m.id, deps);
  if (m.state === "CONTESTED") m = await resolveObjection(m.id, deps);
  if (m.state === "HUMAN_CHECK") m = await expireHumanCheck(m.id, deps);
  if (m.state === "PASSED" && m.release_after && m.release_after.getTime() <= Date.now()) m = await releaseFunds(m.id, deps.money);
  if (m.state === "RELEASED") m = await syncMilestone(m.id, deps.money);
  return m;
}

export async function tickAll(deps: ReviewDeps = defaultReviewDeps()): Promise<{ id: string; state?: string; error?: string }[]> {
  const { rows } = await db().query<{ id: string }>(
    `select id from milestones
     where (state in ('SUBMITTED','IN_REVIEW','PASSED','CONTESTED','RELEASED') and updated_at > now() - interval '7 days')
        -- A HUMAN_CHECK whose decision deadline has passed, however long ago (see humanCheckDeadline).
        or (state = 'HUMAN_CHECK' and contested_at is not null and coalesce(human_check_at, updated_at) <= now() - make_interval(secs => $1))
        or (state = 'HUMAN_CHECK' and contested_at is null and authorization_expires_at <= now() + make_interval(secs => $2))
     -- Overdue HUMAN_CHECKs that wait for the client go last, so they never crowd out other work.
     order by (state = 'HUMAN_CHECK'), updated_at limit 10`,
    [objectionReleaseMs() / 1000, HOLD_DECIDE_MARGIN_MS / 1000],
  );
  const out = [];
  for (const { id } of rows) {
    try {
      out.push({ id, state: (await tick(id, deps)).state });
    } catch (err) {
      out.push({ id, error: String(err).slice(0, 200) });
    }
  }
  // Holds past their expiry that were never captured: re-read PayPal so the milestone moves to CANCELLED
  // even if the VOIDED webhook was missed (syncMilestone's endHoldIfGone). One authorization read each.
  const { rows: lapsed } = await db().query<{ id: string }>(
    `select id from milestones
     where state in ('FUNDED','SUBMITTED','IN_REVIEW','CHANGES_REQUESTED','HUMAN_CHECK','PASSED','CONTESTED')
       and paypal_authorization_id is not null and paypal_capture_id is null and authorization_expires_at <= now()
     order by authorization_expires_at limit 5`,
  );
  for (const { id } of lapsed) {
    try {
      out.push({ id, state: (await syncMilestone(id, deps.money)).state });
    } catch (err) {
      out.push({ id, error: String(err).slice(0, 200) });
    }
  }
  return out;
}
