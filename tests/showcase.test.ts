import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { resetDb, seedMilestone } from "./helpers";
import { db } from "@/lib/db";
import { clearShowcaseCache, getShowcase, pickShowcase } from "@/lib/showcase";

beforeEach(async () => {
  await resetDb();
  clearShowcaseCache();
});
after(() => db().end());

describe("showcase of judge runs", () => {
  it("leads with the latest paid run and the latest caught cheat, then the newest others, up to six", () => {
    const run = (runId: string, outcome: "paid" | "caught" | "person", createdAt: number) => ({ runId, kind: outcome === "paid" ? ("honest" as const) : ("cheat" as const), outcome, createdAt });
    const runs = [run("p1", "paid", 1), run("c1", "caught", 2), run("p2", "paid", 3), run("x", "person", 9), run("p3", "paid", 4), run("c2", "caught", 5), run("p4", "paid", 6), run("p5", "paid", 7)];
    assert.deepEqual(pickShowcase(runs).map((r) => r.runId), ["p5", "c2", "x", "p4", "p3", "p2"]);
    assert.deepEqual(pickShowcase([run("c1", "caught", 1)]).map((r) => r.runId), ["c1"]);
    assert.deepEqual(pickShowcase([]), []);
  });

  it("returns finished runs with real PayPal ids and never an email, link token hash or audit detail", async () => {
    const id = await seedMilestone({
      state: "PAID_OUT",
      client_email: "client@example.com",
      client_token_hash: "c".repeat(64),
      worker_token_hash: "w".repeat(64),
      paypal_authorization_id: "5AB12345CD678901E",
      paypal_capture_id: "9XY98765ZW432109V",
      paypal_payout_item_id: "PAYOUTITEM123",
      payout_cents: 1080,
      pr_url: "https://github.com/TanmayShah29/milestone-demo/pull/9",
    });
    const t0 = Date.now() - 10 * 60_000;
    const events: [string, string | null, number][] = [
      ["terms:agreed", "AGREED", t0],
      ["hold:authorized", "FUNDED", t0 + 60_000],
      ["deliverable:submitted", "SUBMITTED", t0 + 120_000],
      ["review:passed", "PASSED", t0 + 180_000],
      ["hold:captured", "RELEASED", t0 + 240_000],
      ["payout:succeeded", "PAID_OUT", t0 + 300_000],
    ];
    for (const [event, to, at] of events) {
      await db().query("insert into audit_log (milestone_id, actor, event, to_state, created_at, detail) values ($1, 'system', $2, $3, $4, $5)", [id, event, to, new Date(at), JSON.stringify({ secret: "internal head sha" })]);
    }
    await db().query("insert into live_runs (kind, milestone_id, status, outcome, pr_url) values ('honest', $1, 'done', 'paid', 'https://github.com/TanmayShah29/milestone-demo/pull/9')", [id]);
    // A running run is not shown.
    const running = await seedMilestone({ state: "FUNDED" });
    await db().query("insert into live_runs (kind, milestone_id) values ('cheat', $1)", [running]);

    const { runs } = await getShowcase();
    assert.equal(runs.length, 1);
    const r = runs[0]!;
    assert.equal(r.outcome, "paid");
    assert.equal(r.worker, "Demo worker (honest)");
    assert.equal(r.milestone.paypal_capture_id, "9XY98765ZW432109V");
    const body = JSON.stringify(runs);
    for (const leak of ["example.com", "c".repeat(64), "w".repeat(64), "token_hash", "internal head sha", "emailSalt", "freelancer_email"]) assert.ok(!body.includes(leak), `leaks ${leak}`);
    // The Gantt data is read only: nothing can be dragged or rescheduled.
    const tasks = r.timeline.tasks.flatMap((t) => [t, ...(t.children ?? [])]);
    assert.ok(tasks.every((t) => t.manuallyScheduled && t.resizable === false && !t.canReschedule && !t.constraintType));
    assert.ok(tasks.some((t) => t.phase === "paid" && t.name === "Paid $10.80"));
    assert.equal(r.audit.length, 6);
    assert.ok(r.audit.every((a) => !("detail" in a)));
  });
});
