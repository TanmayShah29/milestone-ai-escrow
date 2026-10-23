import assert from "node:assert/strict";
import { APICallError } from "ai";
import { after, beforeEach, describe, it } from "node:test";
import { depsWith, jsonResponse, resetDb, seedMilestone, stubFetch } from "./helpers";
import { db, withMilestoneLock } from "@/lib/db";
import type { ModelCall } from "@/lib/ai/client";
import { audit, getMilestone } from "@/lib/milestones/repo";
import { refreshHold, syncMilestone } from "@/lib/money/flow";
import type { CheckRun, GitHub, PullRequest } from "@/lib/review/github";
import { acceptanceCheckName } from "@/lib/review/verifiers";
import { humanDecision, objectToRelease, reviewMilestone, submitDeliverable, tick, type ReviewDeps } from "@/lib/review/run";

// Fixes for the opencode audit (opencode-audit.md): each test is named for the finding it closes.

beforeEach(resetDb);
after(() => db().end());

const PR_URL = "https://github.com/acme/web/pull/7";

function fakeGitHub(o: { body: string; sha?: string; ci?: string }) {
  const comments: string[] = [];
  const state = { sha: o.sha ?? "abc1234", ci: o.ci ?? "success" };
  const gh: GitHub = {
    async pr(owner, repo, n) {
      return { number: n, title: "Add dark mode", body: o.body, state: "open", merged: false, headSha: state.sha, baseRepo: `${owner}/${repo}`, htmlUrl: PR_URL } satisfies PullRequest;
    },
    async files() {
      return [{ filename: "src/theme.ts", status: "added", additions: 10, deletions: 0, patch: "+export const dark = true;" }];
    },
    async checkRuns() {
      return runs.map((r) => ({ ...r, conclusion: r.name === "contract" ? "success" : state.ci, headSha: state.sha }));
    },
    async workflowRun(_owner, _repo, id) {
      return { id, path: ".github/workflows/milestone.yml", event: "pull_request", headSha: state.sha };
    },
    async comment(_o, _r, _n, body) {
      comments.push(body);
    },
  };
  let runs: CheckRun[] = [];
  return { gh, comments, state, setRuns: (r: CheckRun[]) => (runs = r) };
}

const run = (name: string): CheckRun => ({ name, status: "completed", conclusion: "success", url: `https://ci/${name}`, startedAt: new Date().toISOString(), app: "github-actions", headSha: "abc1234", workflowRunId: 1 });
const passingAi: ModelCall = async () => JSON.stringify({ criteria: [{ id: "C2", verdict: "pass", confidence: 0.92, evidence: ["ok"] }], summary: "Looks complete", feedback_for_worker: "", injection_attempt: false });
const noMoney = () => depsWith(stubFetch(() => jsonResponse(500, {})));
const deps = (gh: GitHub, aiCall: ModelCall = passingAi): ReviewDeps => ({ github: gh, aiCall, money: noMoney() });

async function passed() {
  const id = await seedMilestone({ state: "SUBMITTED", repo: "acme/web", pr_url: PR_URL, paypal_order_id: "O1", paypal_authorization_id: "A1", authorized_cents: 30_000 });
  const hash = (await getMilestone(id)).criteria_hash!;
  const f = fakeGitHub({ body: `Adds dark mode.\n\nMilestone-Terms: ${hash}` });
  f.setRuns([run("contract"), run(acceptanceCheckName("C1", hash))]);
  assert.equal((await reviewMilestone(id, deps(f.gh))).state, "PASSED");
  return { id, ...f };
}

describe("#26 F1 / #27 F1: a commit sent back can't pass again from its cached verdict", () => {
  it("after a failing second review, the same commit is refused at submit and at review", async () => {
    const { id, gh, state } = await passed();
    await objectToRelease(id);
    state.ci = "failure"; // the second review re-reads CI on the same commit
    assert.equal((await tick(id, deps(gh))).state, "CHANGES_REQUESTED");

    state.ci = "success";
    await assert.rejects(submitDeliverable(id, { prUrl: PR_URL }, deps(gh)), /already sent back/);

    // Submitted with a new commit, then force-pushed back to the rejected one before review.
    state.sha = "def5678";
    assert.equal((await submitDeliverable(id, { prUrl: PR_URL }, deps(gh))).state, "SUBMITTED");
    state.sha = "abc1234";
    const m = await reviewMilestone(id, deps(gh));
    assert.equal(m.state, "CHANGES_REQUESTED");
  });

  it("after the client asks for changes on a post-objection HUMAN_CHECK, the same commit can't be resubmitted", async () => {
    const { id, gh } = await passed();
    await objectToRelease(id);
    await db().query("update milestones set state = 'HUMAN_CHECK', human_check_at = now() where id = $1", [id]);
    assert.equal((await humanDecision(id, false, { reason: "The toggle resets on reload." })).state, "CHANGES_REQUESTED");
    await assert.rejects(submitDeliverable(id, { prUrl: PR_URL }, deps(gh)), /already sent back/);
  });

  it("a new commit is reviewed normally", async () => {
    const { id, gh, state } = await passed();
    await objectToRelease(id);
    state.ci = "failure";
    await tick(id, deps(gh));
    state.ci = "success";
    state.sha = "def5678";
    await submitDeliverable(id, { prUrl: PR_URL }, deps(gh));
    assert.equal((await reviewMilestone(id, deps(gh))).state, "PASSED");
  });
});

describe("#27 F4: the commit is re-checked before an automatic release", () => {
  it("commits pushed after approval send the work back instead of paying it", async () => {
    const { id, gh, state, comments } = await passed();
    await db().query("update milestones set release_after = now() - interval '1 second' where id = $1", [id]);
    state.sha = "def5678";
    const money = stubFetch(() => jsonResponse(500, {}));
    const m = await tick(id, { github: gh, aiCall: passingAi, money: depsWith(money) });
    assert.equal(m.state, "CHANGES_REQUESTED");
    assert.equal(money.calls.length, 0, "no capture");
    assert.match(comments.at(-1)!, /Not released/);
  });
});

describe("#26 F2: a first review the AI couldn't finish backs off", () => {
  it("doesn't call the models again on every poll", async () => {
    const id = await seedMilestone({ state: "SUBMITTED", repo: "acme/web", pr_url: PR_URL, paypal_order_id: "O1", paypal_authorization_id: "A1", authorized_cents: 30_000 });
    const hash = (await getMilestone(id)).criteria_hash!;
    const f = fakeGitHub({ body: `Milestone-Terms: ${hash}` });
    f.setRuns([run("contract"), run(acceptanceCheckName("C1", hash))]);
    let calls = 0;
    const busy: ModelCall = async () => {
      calls++;
      throw new APICallError({ message: "rate limited", url: "https://openrouter.ai", requestBodyValues: {}, statusCode: 429, isRetryable: true });
    };
    await assert.rejects(reviewMilestone(id, deps(f.gh, busy)));
    const first = calls;
    assert.equal((await reviewMilestone(id, deps(f.gh, busy))).state, "IN_REVIEW");
    assert.equal(calls, first, "second poll inside the backoff makes no AI call");

    await db().query("update reviews set updated_at = now() - interval '6 minutes' where milestone_id = $1", [id]);
    assert.equal((await reviewMilestone(id, deps(f.gh))).state, "PASSED");
  });
});

describe("#34 F1: reauthorizing never moves the hold's expiry later", () => {
  it("keeps the original 29-day expiry when PayPal reports a later one", async () => {
    const original = new Date(Date.now() + 20 * 86_400_000);
    const id = await seedMilestone({ state: "FUNDED", paypal_order_id: "O1", paypal_authorization_id: "A1", authorized_cents: 30_000, authorization_expires_at: original });
    const later = new Date(Date.now() + 29 * 86_400_000).toISOString();
    const stub = stubFetch(() => jsonResponse(201, { id: "A2", status: "CREATED", expiration_time: later }));
    const m = await refreshHold(id, depsWith(stub));
    assert.equal(m.paypal_authorization_id, "A2");
    assert.equal(m.authorization_expires_at!.getTime(), original.getTime());
  });
});

describe("#33 F6: an unknown claim whose action no longer applies doesn't block sync", () => {
  it("a lost reauthorize outcome after capture still lets the payout reach PAID_OUT", async () => {
    const id = await seedMilestone({
      state: "RELEASED", paypal_order_id: "O1", paypal_authorization_id: "A1", authorized_cents: 30_000,
      paypal_capture_id: "CAP1", capture_status: "COMPLETED", captured_cents: 30_000, payout_cents: 28_000, paypal_payout_batch_id: "B1",
    });
    await db().query("insert into money_actions (milestone_id, action, attempt, request_id, status) values ($1, 'reauthorize_1', 1, $2, 'unknown')", [id, `ms_${id}_reauthorize_1_1`]);
    const stub = stubFetch(() => jsonResponse(200, { batch_header: { batch_status: "SUCCESS" }, items: [{ payout_item_id: "I1", transaction_status: "SUCCESS" }] }));
    assert.equal((await syncMilestone(id, depsWith(stub))).state, "PAID_OUT");
    const { rows } = await db().query("select 1 from audit_log where milestone_id = $1 and event = 'reauthorize_1:unsettled'", [id]);
    assert.equal(rows.length, 1);
  });
});

describe("#33 F1: waiting for a milestone lock doesn't hold a pool connection", () => {
  it("many callers queued on one milestone all finish", async () => {
    const id = await seedMilestone({ state: "FUNDED" });
    const jobs = Array.from({ length: 24 }, (_, i) =>
      withMilestoneLock(id, async () => {
        await audit(db(), { milestoneId: id, actor: "system", event: "test:lock", detail: { i } });
        return i;
      }),
    );
    assert.equal((await Promise.all(jobs)).length, 24);
  });
});
