import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { resetDb, seedMilestone } from "./helpers";
import { db } from "@/lib/db";
import { InvariantViolation } from "@/lib/errors";
import { getMilestone } from "@/lib/milestones/repo";
import { setDueDate } from "@/lib/schedule";
import { buildTimeline, holdWarning } from "@/lib/timeline";

beforeEach(resetDb);
after(() => db().end());

const DAY = 86_400_000;
const phases = (tl: ReturnType<typeof buildTimeline>) => Object.fromEntries(tl.tasks[0]!.children!.map((c) => [c.phase, c]));

describe("timeline builder", () => {
  it("an unfunded milestone: terms active, everything after the hold locked behind money gates", async () => {
    const m = await getMilestone(await seedMilestone({ state: "AGREED" }));
    const p = phases(buildTimeline(m, [{ event: "terms:agreed", to_state: "AGREED", created_at: new Date() }]));
    assert.equal(p.terms!.status, "done");
    assert.equal(p.hold!.status, "active");
    assert.equal(p.work!.status, "blocked");
    assert.equal(p.payout!.status, "blocked");
    assert.equal(p.work!.iconCls, "fa fa-lock");
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
    assert.ok(holdWarning(m));
    const tl = buildTimeline(m, [{ event: "hold:authorized", to_state: "FUNDED", created_at: new Date() }]);
    assert.equal(tl.warnings.length, 1);
    assert.equal(phases(tl).hold!.eventColor, "orange");
    assert.equal(phases(tl).hold!.holdWarn, true);
  });
});

describe("rescheduling", () => {
  it("the client moves the due date; past the hold's expiry it is kept and flagged", async () => {
    const id = await seedMilestone({ state: "FUNDED", authorization_expires_at: new Date(Date.now() + 10 * DAY) });
    const ok = await setDueDate(id, new Date(Date.now() + 5 * DAY).toISOString());
    assert.deepEqual(ok.warnings, []);
    const late = await setDueDate(id, new Date(Date.now() + 15 * DAY).toISOString());
    assert.equal(late.warnings.length, 1);
    const { rowCount } = await db().query("select 1 from audit_log where milestone_id = $1 and event = 'schedule:due_changed'", [id]);
    assert.equal(rowCount, 2);
  });

  it("can't move the date into the past or after the work is submitted", async () => {
    const id = await seedMilestone({ state: "FUNDED" });
    await assert.rejects(setDueDate(id, new Date(Date.now() - DAY).toISOString()), InvariantViolation);
    const done = await seedMilestone({ state: "SUBMITTED" });
    await assert.rejects(setDueDate(done, new Date(Date.now() + DAY).toISOString()), InvariantViolation);
  });
});
