import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { resetDb, seedMilestone } from "./helpers";
import { db } from "@/lib/db";
import { InvariantViolation } from "@/lib/errors";
import { getMilestone } from "@/lib/milestones/repo";
import { setDueDate } from "@/lib/schedule";
import type { Milestone } from "@/lib/milestones/repo";
import { buildTimeline, failedCriteria, holdWarning, reviewFailedLabel, type AuditRow } from "@/lib/timeline";

beforeEach(resetDb);
after(() => db().end());

const DAY = 86_400_000;
const phases = (tl: ReturnType<typeof buildTimeline>) => Object.fromEntries(tl.tasks[0]!.children!.map((c) => [c.phase, c]));

describe("timeline builder", () => {
  it("an unfunded milestone: the hold is shown as not funded and everything after it is locked behind money gates", async () => {
    const m = await getMilestone(await seedMilestone({ state: "AGREED" }));
    const p = phases(buildTimeline(m, [{ event: "terms:agreed", to_state: "AGREED", created_at: new Date() }]));
    assert.equal(p.terms!.status, "done");
    assert.equal(p.hold!.status, "unfunded");
    assert.match(p.hold!.name, /not funded/);
    assert.equal(p.hold!.eventColor, "gray");
    assert.equal(p.work!.status, "blocked");
    assert.equal(p.payout!.status, "blocked");
    assert.equal(p.work!.iconCls, "fa fa-lock");
    assert.equal(p.work!.canReschedule, true);
  });

  it("the due date can be dragged only while the API would accept it", async () => {
    const funded = phases(buildTimeline(await getMilestone(await seedMilestone({ state: "FUNDED" })), []));
    assert.equal(funded.work!.canReschedule, true);
    assert.equal(funded.work!.resizable, "end");
    const submitted = await getMilestone(await seedMilestone({ state: "SUBMITTED" }));
    const p = phases(buildTimeline(submitted, [{ event: "deliverable:submitted", to_state: "SUBMITTED", created_at: new Date() }]));
    assert.equal(p.work!.canReschedule, false);
    assert.equal(p.work!.resizable, false);
    assert.ok(phases(buildTimeline(await getMilestone(await seedMilestone({ state: "FUNDED" })), [{ event: "hold:authorized", to_state: "FUNDED", created_at: new Date() }])).hold!.name.startsWith("PayPal hold $"));
  });

  it("phases are chained by finish-to-start dependencies, plus the tranche link to a predecessor", async () => {
    const first = await seedMilestone({ state: "PAID_OUT" });
    const m = await getMilestone(await seedMilestone({ state: "FUNDED", after_milestone_id: first }));
    const tl = buildTimeline(m, []);
    assert.deepEqual(
      tl.dependencies.map((d) => [d.fromTask.split(":")[1], d.toTask.split(":")[1]]),
      [["terms", "hold"], ["hold", "work"], ["work", "review"], ["review", "window"], ["window", "payout"], ["payout", "work"]],
    );
    assert.equal(tl.dependencies.at(-1)!.fromTask, `${first}:payout`);
  });

  it("a live hold carries its day-3 honor and day-29 expiry markers; a captured one doesn't", async () => {
    const held = new Date(Date.now() - DAY);
    const live = await getMilestone(await seedMilestone({ state: "FUNDED", authorization_expires_at: new Date(held.getTime() + 29 * DAY) }));
    const p = phases(buildTimeline(live, [{ event: "hold:authorized", to_state: "FUNDED", created_at: held }]));
    assert.equal(p.hold!.honorEnd, new Date(held.getTime() + 3 * DAY).toISOString());
    assert.ok(p.hold!.holdExpiry);
    const done = await getMilestone(await seedMilestone({ state: "PAID_OUT", authorization_expires_at: new Date(held.getTime() + 29 * DAY) }));
    const q = phases(buildTimeline(done, [{ event: "hold:authorized", to_state: "FUNDED", created_at: held }, { event: "hold:captured", to_state: "RELEASED", created_at: new Date() }]));
    assert.equal(q.hold!.holdExpiry, undefined);
    assert.equal(q.payout!.status, "done");
  });

  it("work due after the hold expires is flagged and the hold turns orange", async () => {
    const m = await getMilestone(await seedMilestone({ state: "FUNDED", authorization_expires_at: new Date(Date.now() + 10 * DAY), due_at: new Date(Date.now() + 20 * DAY) }));
    assert.match(holdWarning(m) ?? "", /Test milestone.+Move the date earlier; holds can't be extended past 29 days/);
    const tl = buildTimeline(m, [{ event: "hold:authorized", to_state: "FUNDED", created_at: new Date() }]);
    assert.equal(tl.warnings.length, 1);
    assert.equal(phases(tl).hold!.eventColor, "orange");
    assert.equal(phases(tl).hold!.holdWarn, true);
  });
});

describe("rescheduling", () => {
  it("funded: the client moves the due date up to the hold's expiry minus 3 days; later is refused", async () => {
    const id = await seedMilestone({ state: "FUNDED", authorization_expires_at: new Date(Date.now() + 10 * DAY) });
    const ok = await setDueDate(id, new Date(Date.now() + 5 * DAY).toISOString());
    assert.deepEqual(ok.warnings, []);
    await assert.rejects(setDueDate(id, new Date(Date.now() + 8 * DAY).toISOString()), (e: Error) => e instanceof InvariantViolation && /PayPal holds last 29 days, so the work must be due by .+\. Split longer work into milestones\./.test(e.message));
    const { rowCount } = await db().query("select 1 from audit_log where milestone_id = $1 and event = 'schedule:due_changed'", [id]);
    assert.equal(rowCount, 1);
    assert.equal(new Date((await getMilestone(id)).due_at).getTime() < Date.now() + 6 * DAY, true);
  });

  it("not funded: the due date can be at most 26 days after creation", async () => {
    const id = await seedMilestone({ state: "AGREED" });
    await setDueDate(id, new Date(Date.now() + 25 * DAY).toISOString());
    await assert.rejects(setDueDate(id, new Date(Date.now() + 27 * DAY).toISOString()), /PayPal holds last 29 days/);
  });

  it("the Work bar carries the cap so the Gantt can refuse a drag past it", async () => {
    const expiry = new Date(Date.now() + 20 * DAY);
    const m = await getMilestone(await seedMilestone({ state: "FUNDED", authorization_expires_at: expiry }));
    assert.equal(phases(buildTimeline(m, [])).work!.dueLimit, new Date(expiry.getTime() - 3 * DAY).toISOString());
  });

  it("a saved due date redraws the later phases where the Gantt's engine pushed them (review starts at the new due date)", async () => {
    const held = new Date(Date.now() - DAY);
    const id = await seedMilestone({ state: "FUNDED", authorization_expires_at: new Date(held.getTime() + 29 * DAY) });
    const due = new Date(Date.now() + 12 * DAY);
    const { milestone } = await setDueDate(id, due.toISOString());
    const p = phases(buildTimeline(milestone, [{ event: "hold:authorized", to_state: "FUNDED", created_at: held }]));
    assert.equal(p.work!.endDate, due.toISOString());
    assert.equal(p.review!.startDate, due.toISOString());
    assert.equal(p.payout!.startDate, p.window!.endDate);
    assert.equal(p.work!.manuallyScheduled, false);
    assert.equal(p.work!.constraintType, "finishnolaterthan");
  });

  it("can't move the date into the past or after the work is submitted", async () => {
    const id = await seedMilestone({ state: "FUNDED" });
    await assert.rejects(setDueDate(id, new Date(Date.now() - DAY).toISOString()), InvariantViolation);
    const done = await seedMilestone({ state: "SUBMITTED" });
    await assert.rejects(setDueDate(done, new Date(Date.now() + DAY).toISOString()), InvariantViolation);
  });
});

// Pure: a milestone row and its audit trail, no database.
const T0 = Date.parse("2026-11-01T00:00:00Z");
const H = 3_600_000;
function fake(over: Partial<Milestone> = {}): Milestone {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Initials helper",
    amount_cents: 1200,
    state: "FUNDED",
    created_at: new Date(T0),
    due_at: new Date(T0 + 3 * DAY),
    authorization_expires_at: new Date(T0 + 29 * DAY),
    authorized_cents: 1200,
    paypal_authorization_id: "AUTH-1",
    criteria: { policy: { objectionWindowSeconds: 30 } },
    criteria_hash: "abc123",
    after_milestone_id: null,
    release_after: null,
    payout_cents: null,
    pr_url: null,
    paypal_payout_item_id: null,
    ...over,
  } as Milestone;
}
const ev = (event: string, to_state: string | null, at: number, detail?: unknown): AuditRow => ({ event, to_state, created_at: new Date(at), ...(detail ? { detail } : {}) });
const funded = [ev("created", "DRAFT", T0), ev("terms:agreed", "AGREED", T0 + H), ev("hold:authorized", "FUNDED", T0 + 2 * H)];
const failC2 = (at: number) => ev("review:changes_requested", "CHANGES_REQUESTED", at, { reasons: ["C2 failed"], injection: false });
const ids = (tl: ReturnType<typeof buildTimeline>) => tl.tasks[0]!.children!.map((c) => c.phase);

describe("timeline reacts to review and PayPal events", () => {
  const sub1 = T0 + DAY;
  const sub2 = T0 + 2 * DAY;
  const paidAt = sub2 + 3 * H;
  const reworked = [
    ...funded,
    ev("deliverable:submitted", "SUBMITTED", sub1),
    failC2(sub1 + H),
    ev("deliverable:submitted", "SUBMITTED", sub2),
    ev("review:passed", "PASSED", sub2 + H),
    ev("hold:captured", "RELEASED", sub2 + 2 * H),
    ev("payout:succeeded", "PAID_OUT", paidAt),
  ];

  it("a failed review adds a sent-back review and a Rework bar, and the later phases move right with a baseline saying why", () => {
    const tl = buildTimeline(fake({ state: "PAID_OUT", payout_cents: 1080, release_after: new Date(sub2 + 2 * H) }), reworked, sub2 + 4 * H);
    assert.deepEqual(ids(tl), ["terms", "hold", "work", "review-1", "rework-1", "review", "window", "payout", "paid"]);
    const p = phases(tl);
    assert.equal(p.work!.endDate, new Date(sub1).toISOString());
    assert.equal(p["review-1"]!.status, "failed");
    assert.equal(p["rework-1"]!.status, "done");
    assert.match(p["rework-1"]!.cls, /ms-rework/);
    assert.equal(p["rework-1"]!.startDate, new Date(sub1 + H).toISOString());
    assert.equal(p["rework-1"]!.endDate, new Date(sub2).toISOString());
    assert.deepEqual(p["rework-1"]!.markers, [{ date: new Date(sub1 + H).toISOString(), label: "Review failed: C2 — rescheduled", kind: "review_failed" }]);
    // The deciding review is the second submission's; it moved by the whole first cycle (review + rework).
    assert.equal(p.review!.startDate, new Date(sub2).toISOString());
    assert.equal(p.review!.status, "done");
    assert.deepEqual(p.review!.baselines, [{ startDate: new Date(sub1).toISOString(), endDate: new Date(sub1 + H).toISOString() }]);
    assert.match(p.payout!.movedBy ?? "", /^Moved 1d later: Review failed: C2, then rework$/);
    assert.equal(p.work!.baselines, undefined);
    // Paid: a zero-length milestone at the real time, with the amount.
    assert.equal(p.paid!.name, "Paid $10.80");
    assert.equal(p.paid!.startDate, new Date(paidAt).toISOString());
    assert.equal(p.paid!.endDate, p.paid!.startDate);
    assert.deepEqual(
      tl.dependencies.map((d) => [d.fromTask.split(":")[1], d.toTask.split(":")[1], d.cls]),
      [
        ["terms", "hold", "ms-dep-open"],
        ["hold", "work", "ms-dep-open"],
        ["work", "review-1", "ms-dep-open"],
        ["review-1", "rework-1", "ms-dep-rework"],
        ["rework-1", "review", "ms-dep-open"],
        ["review", "window", "ms-dep-open"],
        ["window", "payout", "ms-dep-open"],
        ["payout", "paid", "ms-dep-open"],
      ],
    );
  });

  it("every submission and review cycle is shown, not only the first", () => {
    const sub3 = T0 + 3 * DAY;
    const audit = [
      ...funded,
      ev("deliverable:submitted", "SUBMITTED", sub1),
      failC2(sub1 + H),
      ev("deliverable:submitted", "SUBMITTED", sub2),
      ev("review:changes_requested", "CHANGES_REQUESTED", sub2 + H, { reasons: ["C1, C3 failed", "PR contains text aimed at the AI reviewer"], injection: true }),
      ev("deliverable:submitted", "SUBMITTED", sub3),
      ev("review:passed", "PASSED", sub3 + H),
    ];
    const tl = buildTimeline(fake({ state: "PASSED", release_after: new Date(sub3 + 2 * H) }), audit, sub3 + 90 * 60_000);
    assert.deepEqual(ids(tl), ["terms", "hold", "work", "review-1", "rework-1", "review-2", "rework-2", "review", "window", "payout"]);
    const p = phases(tl);
    assert.equal(p["rework-2"]!.markers![0]!.label, "Review failed: C1, C3 (and text aimed at the reviewer) — rescheduled");
    assert.equal(p.window!.status, "active");
    assert.match(p.window!.movedBy ?? "", /^Moved 2d later: /);
  });

  it("while the worker is fixing it, the Rework bar is active and the review, window and payout wait after it", () => {
    const now = sub1 + 5 * H;
    const tl = buildTimeline(fake({ state: "CHANGES_REQUESTED" }), [...funded, ev("deliverable:submitted", "SUBMITTED", sub1), failC2(sub1 + H)], now);
    const p = phases(tl);
    assert.equal(p["rework-1"]!.status, "active");
    assert.equal(p["rework-1"]!.endDate, new Date(sub1 + H + DAY).toISOString());
    assert.equal(p.review!.status, "blocked");
    assert.equal(p.review!.startDate, p["rework-1"]!.endDate);
    assert.equal(p.review!.manuallyScheduled, false);
    assert.equal(p.payout!.manuallyScheduled, false);
  });

  it("a voided hold marks every unfinished phase cancelled, with the reason, and ends the chart where the deal ended", () => {
    const voided = sub1 + 2 * H;
    const audit = [...funded, ev("deliverable:submitted", "SUBMITTED", sub1), failC2(sub1 + H), ev("hold:voided", "CANCELLED", voided)];
    const tl = buildTimeline(fake({ state: "CANCELLED" }), audit, voided + DAY);
    const p = phases(tl);
    assert.equal(p.hold!.status, "cancelled");
    assert.deepEqual(p.hold!.markers, [{ date: new Date(voided).toISOString(), label: "PayPal voided the hold: nothing was charged", kind: "voided" }]);
    assert.equal(p.hold!.endDate, new Date(voided).toISOString());
    for (const k of ["rework-1", "review", "window", "payout"]) {
      assert.equal(p[k]!.status, "cancelled", k);
      assert.match(p[k]!.note, /^Cancelled: PayPal voided the hold\./);
      assert.equal(p[k]!.eventColor, "gray");
      assert.ok(Date.parse(p[k]!.startDate) <= voided + 20 * 60_000, `${k} is drawn at the cancellation, not its old plan`);
    }
    assert.equal(p.work!.status, "done");
    assert.equal(p["review-1"]!.status, "failed");
    assert.equal(p.review!.baselines, undefined);
    assert.equal(tl.tasks[0]!.status, "cancelled");
    assert.equal(tl.tasks[0]!.manuallyScheduled, true);
  });

  it("an expired hold says PayPal ended it", () => {
    const tl = buildTimeline(fake({ state: "CANCELLED" }), [...funded, ev("hold:ended", "CANCELLED", T0 + 29 * DAY)], T0 + 30 * DAY);
    assert.equal(phases(tl).hold!.markers![0]!.kind, "expired");
    assert.match(phases(tl).review!.note, /^Cancelled: PayPal ended the hold \(it expired\)/);
  });

  it("a reauthorized hold shows its new honor period from the reauthorization", () => {
    const reauth = T0 + 5 * DAY;
    const tl = buildTimeline(fake(), [...funded, ev("hold:reauthorized", null, reauth)], reauth + H);
    const p = phases(tl);
    assert.equal(p.hold!.honorStart, new Date(reauth).toISOString());
    assert.equal(p.hold!.honorEnd, new Date(reauth + 3 * DAY).toISOString());
    assert.equal(p.hold!.markers![0]!.kind, "reauthorized");
    assert.equal(p.hold!.holdExpiry, new Date(T0 + 29 * DAY).toISOString(), "reauthorizing never extends the 29 days");
  });

  it("a PayPal dispute gets a marker on the payout and turns the milestone orange", () => {
    const opened = paidAt + DAY;
    const tl = buildTimeline(fake({ state: "DISPUTE", payout_cents: 1080 }), [...reworked, ev("dispute:opened", "DISPUTE", opened)], opened + H);
    const p = phases(tl);
    assert.deepEqual(p.payout!.markers, [{ date: new Date(opened).toISOString(), label: "PayPal dispute opened: PayPal decides it, not Milestone", kind: "dispute" }]);
    assert.equal(p.payout!.status, "done");
    assert.equal(p.window!.status, "done");
    assert.equal(tl.tasks[0]!.eventColor, "orange");
  });

  it("reads the failed criteria from the review's reasons", () => {
    assert.deepEqual(failedCriteria({ reasons: ["C2, C3, C4 failed", "PR contains text aimed at the AI reviewer"] }), ["C2", "C3", "C4"]);
    assert.equal(failedCriteria({ reasons: ["every must-have criterion passed"] }), undefined);
    assert.equal(failedCriteria(null), undefined);
    assert.equal(reviewFailedLabel({ event: "review:changes_by_client", detail: { reason: "x" } }), "The client asked for changes — rescheduled");
    assert.equal(reviewFailedLabel({ event: "review:changes_requested", detail: null }), "Review failed — rescheduled");
  });
});
