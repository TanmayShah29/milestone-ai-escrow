import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { depsWith, jsonResponse, resetDb, sampleTerms, seedMilestone, stubFetch } from "./helpers";
import { db } from "@/lib/db";
import { editTerms, hashTerms, termsSchema, type Terms } from "@/lib/contract/terms";
import type { TestChecker } from "@/lib/contract/testcheck";
import { createMilestone, getMilestone } from "@/lib/milestones/repo";
import { captureFor, releaseFunds } from "@/lib/money/flow";
import type { CheckRun, GitHub, PullRequest } from "@/lib/review/github";
import { decide, earnedShare, type CriterionVerdict, type Verdict } from "@/lib/review/policy";
import { acceptanceCheckName } from "@/lib/review/verifiers";
import { humanDecision, reviewMilestone, type ReviewDeps } from "@/lib/review/run";

beforeEach(resetDb);
after(() => db().end());

// C1 tested must-have, C2 and C3 AI-judged nice-to-haves (sampleTerms has C1 + C2).
const terms = (paySchedule?: Terms["paySchedule"]): Terms => ({
  ...sampleTerms,
  criteria: [...sampleTerms.criteria, { id: "C3", text: "The toggle remembers the system theme", kind: "nice", check: "review" }],
  ...(paySchedule ? { paySchedule } : {}),
});
const SCHEDULE = { mustBaseBps: 8000, niceBonusBps: { C2: 1500, C3: 500 } };

describe("the signed pay schedule", () => {
  it("must add up to 100%, name only nice-to-haves, and give the must-haves at least half", () => {
    assert.ok(termsSchema.safeParse(terms(SCHEDULE)).success);
    assert.match(JSON.stringify(termsSchema.safeParse(terms({ mustBaseBps: 8000, niceBonusBps: { C2: 1000 } })).error), /adds up to 90%/);
    assert.match(JSON.stringify(termsSchema.safeParse(terms({ mustBaseBps: 8000, niceBonusBps: { C1: 2000 } })).error), /C1 is not a nice-to-have/);
    assert.equal(termsSchema.safeParse(terms({ mustBaseBps: 4000, niceBonusBps: { C2: 3000, C3: 3000 } })).success, false);
  });

  it("is part of the fingerprint, and terms without one hash as before", () => {
    const m = { id: "00000000-0000-0000-0000-000000000000", title: "t", amount_cents: 30_000, currency: "USD" as const, freelancer_email: "f@example.com", repo: null };
    assert.equal(hashTerms(m, termsSchema.parse(terms())), hashTerms(m, terms()));
    assert.notEqual(hashTerms(m, terms(SCHEDULE)), hashTerms(m, terms()));
  });

  it("can't make the must-haves alone pay less than the $10 minimum", async () => {
    const { milestone } = await createMilestone({ title: "t", brief: "", amountCents: 1_500, freelancerEmail: "w@example.com" });
    const ok: TestChecker = async () => new Map();
    await assert.rejects(editTerms(milestone.id, terms({ mustBaseBps: 5000, niceBonusBps: { C2: 2500, C3: 2500 } }), { check: ok }), /would pay \$7\.50/);
    assert.ok(await editTerms(milestone.id, terms({ mustBaseBps: 7000, niceBonusBps: { C2: 2000, C3: 1000 } }), { check: ok }));
  });
});

describe("earned shares (policy-2)", () => {
  const base: Verdict = { criteria: [], summary: "", feedbackForWorker: "", injection: { detected: false, quotes: [] }, tampering: [], model: null, headSha: "x" };
  const c = (id: string, source: "test" | "ai", verdict: CriterionVerdict["verdict"], level?: CriterionVerdict["level"], kind: "must" | "nice" = "nice"): CriterionVerdict => ({ id, kind, source, verdict, confidence: 0.5, evidence: [], ...(level ? { level } : {}) });
  const pins = { policyVersion: "policy-2", paySchedule: SCHEDULE };
  const must = c("C1", "test", "pass", "E2", "must");

  it("pays the base plus each nice-to-have met at its floor", () => {
    assert.deepEqual(decide({ ...base, criteria: [must, c("C2", "ai", "pass", "E1"), c("C3", "ai", "pass", "E1")] }, pins).shareBps, 10_000);
    const r = decide({ ...base, criteria: [must, c("C2", "ai", "pass", "E1"), c("C3", "ai", "unclear")] }, pins);
    assert.equal(r.decision, "PASSED");
    assert.equal(r.shareBps, 9500);
    assert.match(r.reasons.join(" "), /pays 95%: C3 not met/);
    assert.equal(decide({ ...base, criteria: [must, c("C2", "ai", "fail", "E1"), c("C3", "ai", "pass")] }, pins).shareBps, 8000); // C3 below its E1 floor
  });

  it("a nice-to-have with a higher floor earns its bonus only at that floor", () => {
    const floored = { ...pins, floors: { C2: "E3" as const } };
    assert.equal(earnedShare({ criteria: [c("C2", "ai", "pass", "E1"), c("C3", "ai", "pass", "E1")] }, floored).shareBps, 8500);
  });

  it("no schedule pays all of it; policy-1 carries no share at all", () => {
    assert.equal(decide({ ...base, criteria: [must] }, { policyVersion: "policy-2" }).shareBps, 10_000);
    assert.equal(decide({ ...base, criteria: [{ ...must, confidence: 1 }] }).shareBps, undefined);
  });
});

describe("partial capture", () => {
  it("captures the earned share, rounded down, never more than the amount", () => {
    assert.equal(captureFor({ amount_cents: 30_000, share_bps: null }), 30_000);
    assert.equal(captureFor({ amount_cents: 30_000, share_bps: 9500 }), 28_500);
    assert.equal(captureFor({ amount_cents: 1_999, share_bps: 3333 }), 666);
    assert.throws(() => captureFor({ amount_cents: 30_000, share_bps: 10_001 }), /out of range/);
  });

  it("captures only the share with final_capture, and pays out from what was captured", async () => {
    const id = await seedMilestone({ state: "PASSED", paypal_order_id: "ORDER1", paypal_authorization_id: "AUTH1", authorized_cents: 30_000, share_bps: 8000 });
    const stub = stubFetch(({ url }) => {
      if (url.pathname === "/v2/payments/authorizations/AUTH1/capture") return jsonResponse(201, { id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "240.00" } });
      if (url.pathname === "/v1/payments/payouts") return jsonResponse(201, { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const m = await releaseFunds(id, depsWith(stub));
    assert.equal(m.state, "RELEASED");
    assert.deepEqual(JSON.parse(stub.calls[0]!.body!), { amount: { currency_code: "USD", value: "240.00" }, final_capture: true });
    assert.equal(m.captured_cents, 24_000);
    // $240 − PayPal $8.87 (3.49% + 49¢) − platform 5% $12 − payout fee $1 (capped)
    assert.equal(m.payout_cents, 24_000 - 887 - 1_200 - 100);
    const { rows } = await db().query<{ detail: { shareBps: number } }>("select detail from audit_log where milestone_id = $1 and event = 'hold:captured'", [id]);
    assert.equal(rows[0]!.detail.shareBps, 8000);
  });
});

describe("a review settles on the earned share", () => {
  const SHA = "abc1234";
  const PR_URL = "https://github.com/acme/web/pull/7";
  const policy2 = (t: Terms): Terms => ({ ...t, policy: { platformFeeBps: 500, objectionWindowSeconds: 3600, policyVersion: "policy-2", confidenceFloor: 0.8, reviewModels: ["a/one:free", "b/two:free", "c/three:free"], verifier: "code_pr@2" } });

  async function seeded(t: Terms) {
    const id = await seedMilestone({ state: "SUBMITTED", repo: "acme/web", pr_url: PR_URL, paypal_order_id: "O1", paypal_authorization_id: "A1", authorized_cents: 30_000 });
    const hash = hashTerms(await getMilestone(id), t);
    await db().query("update milestones set criteria = $2, criteria_hash = $3, client_signed_hash = $3, worker_signed_hash = $3 where id = $1", [id, JSON.stringify(t), hash]);
    return { id, hash };
  }
  function deps(hash: string, c2: "pass" | "unclear"): ReviewDeps & { comments: string[] } {
    const comments: string[] = [];
    const run = (name: string): CheckRun => ({ name, status: "completed", conclusion: "success", url: `https://ci/${name}`, startedAt: new Date().toISOString(), app: "github-actions", headSha: SHA, workflowRunId: 1 });
    const github: GitHub = {
      async pr(owner, repo, n) {
        return { number: n, title: "Dark mode", body: `Milestone-Terms: ${hash}`, state: "open", merged: false, headSha: SHA, baseRepo: `${owner}/${repo}`, htmlUrl: PR_URL } satisfies PullRequest;
      },
      async files() {
        return [{ filename: "src/theme.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1,1 @@\n+export const toggle = { tabIndex: 0 };" }];
      },
      async checkRuns() {
        return [run("contract"), run(acceptanceCheckName("C1", hash))];
      },
      async workflowRun(_o, _r, id) {
        return { id, path: ".github/workflows/milestone.yml", event: "pull_request", headSha: SHA };
      },
      async comment(_o, _r, _n, body) {
        comments.push(body);
      },
    };
    const grounded = { at: "src/theme.ts:1", quote: "export const toggle = { tabIndex: 0 };" };
    const aiCall = async () => JSON.stringify({ criteria: [{ id: "C2", verdict: c2, confidence: 0.7, evidence: c2 === "pass" ? [grounded] : [] }, { id: "C3", verdict: "unclear", confidence: 0, evidence: [] }], summary: "", feedback_for_worker: "", injection_attempt: false });
    return { github, aiCall, money: depsWith(stubFetch(() => jsonResponse(500, {}))), comments };
  }

  it("a pass with one nice-to-have missing stores 95%, audits it and says so on the PR", async () => {
    const { id, hash } = await seeded(policy2(terms(SCHEDULE)));
    const d = deps(hash, "pass");
    const m = await reviewMilestone(id, d);
    assert.equal(m.state, "PASSED");
    assert.equal(m.share_bps, 9500);
    assert.match(d.comments[0]!, /earns 95% \(\$285\.00\)/);
    const { rows } = await db().query<{ detail: { shareBps: number } }>("select detail from audit_log where milestone_id = $1 and event = 'review:passed'", [id]);
    assert.equal(rows[0]!.detail.shareBps, 9500);
  });

  it("the client approving a HUMAN_CHECK pays the base plus the nice-to-haves the review met", async () => {
    const t = policy2(terms(SCHEDULE));
    t.criteria[0] = { ...t.criteria[0]!, evidenceFloor: "E3" }; // CI alone (E2) can't settle C1: a person decides
    const { id, hash } = await seeded(t);
    assert.equal((await reviewMilestone(id, deps(hash, "pass"))).state, "HUMAN_CHECK");
    assert.equal((await humanDecision(id, true)).share_bps, 9500);
  });

  it("terms without a schedule settle on the full amount, as before", async () => {
    const { id, hash } = await seeded(policy2(terms()));
    const m = await reviewMilestone(id, deps(hash, "unclear"));
    assert.equal(m.state, "PASSED");
    assert.equal(m.share_bps, 10_000);
    assert.equal(captureFor(m), 30_000);
  });
});
