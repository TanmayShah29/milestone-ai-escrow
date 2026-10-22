import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Milestone } from "@/lib/milestones/repo";
import { buildTimeline, dueCapMessage, holdWarning, latestDueAt } from "@/lib/timeline";

// Pure (no DB): the 29-day hold rules behind the due-date cap and the hold-expiry warning, and how the
// timeline hands them to Bryntum's scheduling engine.

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-22T12:00:00Z");

describe("latestDueAt", () => {
  it("funded: the hold's expiry minus 3 days", () => {
    const expiry = new Date(NOW + 29 * DAY);
    assert.equal(latestDueAt({ created_at: new Date(NOW - 5 * DAY), authorization_expires_at: expiry }, NOW).getTime(), expiry.getTime() - 3 * DAY);
  });

  it("not funded: 26 days from creation", () => {
    assert.equal(latestDueAt({ created_at: new Date(NOW), authorization_expires_at: null }, NOW).getTime(), NOW + 26 * DAY);
  });

  it("not funded and created long ago: 26 days from now (a hold placed later expires later)", () => {
    assert.equal(latestDueAt({ created_at: new Date(NOW - 40 * DAY), authorization_expires_at: null }, NOW).getTime(), NOW + 26 * DAY);
  });

  it("the refusal names the date and the 29-day limit", () => {
    assert.equal(dueCapMessage(new Date("2026-11-17T12:00:00Z")), "PayPal holds last 29 days, so the work must be due by Nov 17, 2026. Split longer work into milestones.");
  });
});

describe("holdWarning", () => {
  const base = { title: "Login page", state: "FUNDED" as const, authorization_expires_at: new Date("2026-11-20T00:00:00Z") };

  it("work due after the hold expires: move the date, no advice to reauthorize", () => {
    const w = holdWarning({ ...base, due_at: new Date("2026-11-25T00:00:00Z") });
    assert.equal(w, "“Login page”: the work is due after the PayPal hold expires on Nov 20, 2026. Move the date earlier; holds can't be extended past 29 days.");
    assert.doesNotMatch(w!, /reauthori/i);
  });

  it("nothing to say when the work is due in time, or once the money is captured", () => {
    assert.equal(holdWarning({ ...base, due_at: new Date("2026-11-10T00:00:00Z") }), undefined);
    assert.equal(holdWarning({ ...base, state: "PAID_OUT", due_at: new Date("2026-11-25T00:00:00Z") }), undefined);
  });
});

// A milestone row as buildTimeline reads it (only the fields it uses; the rest default to null).
const row = (fields: Partial<Milestone>): Milestone =>
  ({ id: "m1", title: "Login page", amount_cents: 30_000, state: "FUNDED", created_at: new Date(NOW - 3 * DAY), due_at: new Date(NOW + 7 * DAY), authorization_expires_at: null, after_milestone_id: null, ...fields }) as Milestone;
const heldAt = (t: number) => [
  { event: "terms:agreed", to_state: "AGREED", created_at: new Date(t - DAY) },
  { event: "hold:authorized", to_state: "FUNDED", created_at: new Date(t) },
];
const phasesOf = (tl: ReturnType<typeof buildTimeline>) => Object.fromEntries(tl.tasks[0]!.children!.map((c) => [c.phase, c]));

describe("timeline scheduling (Bryntum engine)", () => {
  const expiry = new Date(NOW - 2 * DAY + 29 * DAY);
  const funded = row({ authorization_expires_at: expiry });

  it("phases that happened are pinned; future ones are auto-scheduled so moving Work pushes the rest", () => {
    const tl = buildTimeline(funded, heldAt(NOW - 2 * DAY), NOW);
    assert.deepEqual(
      Object.fromEntries(tl.tasks[0]!.children!.map((t) => [t.phase, t.manuallyScheduled])),
      { terms: true, hold: true, work: false, review: false, window: false, payout: false },
    );
    assert.equal(tl.tasks[0]!.manuallyScheduled, false, "the parent rolls up its moving children");
  });

  it("submitted work is pinned at its real dates; the later phases still follow it", () => {
    const m = row({ state: "SUBMITTED", authorization_expires_at: expiry });
    const p = phasesOf(buildTimeline(m, [...heldAt(NOW - 2 * DAY), { event: "deliverable:submitted", to_state: "SUBMITTED", created_at: new Date(NOW - DAY) }], NOW));
    assert.equal(p.work!.manuallyScheduled, true);
    assert.equal(p.work!.endDate, new Date(NOW - DAY).toISOString());
    assert.equal(p.review!.manuallyScheduled, false);
    assert.equal(p.work!.constraintType, undefined);
  });

  it("a finished or cancelled milestone never moves", () => {
    for (const state of ["PAID_OUT", "CANCELLED"] as const) {
      const tl = buildTimeline(row({ state }), [{ event: "x", to_state: state, created_at: new Date(NOW - DAY) }], NOW);
      assert.ok(tl.tasks[0]!.children!.every((c) => c.manuallyScheduled), state);
      assert.equal(tl.tasks[0]!.manuallyScheduled, true, state);
    }
  });

  it("Work must finish on or before the hold's cap (Bryntum's finishnolaterthan), the same date the API enforces", () => {
    const w = phasesOf(buildTimeline(funded, heldAt(NOW - 2 * DAY), NOW)).work!;
    assert.equal(w.constraintType, "finishnolaterthan");
    assert.equal(w.constraintDate, new Date(expiry.getTime() - 3 * DAY).toISOString());
    assert.equal(w.constraintDate, w.dueLimit);
    const unfunded = phasesOf(buildTimeline(row({ state: "AGREED", created_at: new Date(NOW) }), [], NOW)).work!;
    assert.equal(unfunded.constraintDate, new Date(NOW + 26 * DAY).toISOString());
  });

  it("no constraint on a row whose date is already past the cap (it would conflict on load; the warning covers it)", () => {
    const late = row({ authorization_expires_at: new Date(NOW + 10 * DAY), due_at: new Date(NOW + 20 * DAY) });
    const w = phasesOf(buildTimeline(late, heldAt(NOW - 19 * DAY), NOW)).work!;
    assert.equal(w.constraintType, undefined);
    assert.ok(w.dueLimit, "the drag cap still applies");
  });

  it("the hold gates the work's start (start-to-start); the other gates are finish-to-start; a tranche link is drawn but inactive", () => {
    const tl = buildTimeline(row({ authorization_expires_at: expiry, after_milestone_id: "m0" }), heldAt(NOW - 2 * DAY), NOW);
    assert.deepEqual(
      tl.dependencies.map((d) => [d.toTask.split(":")[1], d.type, d.active ?? true]),
      [["hold", 2, true], ["work", 0, true], ["review", 2, true], ["window", 2, true], ["payout", 2, true], ["work", 2, false]],
    );
  });

  it("dates line up the way the engine schedules them, so nothing jumps on load", () => {
    const p = phasesOf(buildTimeline(funded, heldAt(NOW - 2 * DAY), NOW));
    assert.equal(p.work!.startDate, p.hold!.startDate);
    assert.equal(p.review!.startDate, p.work!.endDate);
    assert.equal(p.window!.startDate, p.review!.endDate);
    assert.equal(p.payout!.startDate, p.window!.endDate);
  });
});

describe("hold bands", () => {
  it("a live hold carries its honor end and expiry; within 3 days of expiry it is drawn red", () => {
    const held = NOW - 27 * DAY;
    const m = row({ authorization_expires_at: new Date(held + 29 * DAY), due_at: new Date(NOW - DAY) });
    const h = phasesOf(buildTimeline(m, heldAt(held), NOW)).hold!;
    assert.equal(h.honorEnd, new Date(held + 3 * DAY).toISOString());
    assert.equal(h.holdExpiry, new Date(held + 29 * DAY).toISOString());
    assert.equal(h.holdExpiring, true);
    assert.equal(h.eventColor, "red");
    assert.match(h.cls, /ms-expiring/);
  });

  it("a fresh hold is not expiring; an unfunded or captured one has no bands", () => {
    const fresh = phasesOf(buildTimeline(row({ authorization_expires_at: new Date(NOW + 27 * DAY) }), heldAt(NOW - 2 * DAY), NOW)).hold!;
    assert.equal(fresh.holdExpiring, false);
    const unfunded = phasesOf(buildTimeline(row({ state: "AGREED" }), [], NOW)).hold!;
    assert.equal(unfunded.holdExpiry, undefined);
    assert.equal(unfunded.holdExpiring, undefined);
    const captured = phasesOf(buildTimeline(row({ state: "PAID_OUT", authorization_expires_at: new Date(NOW + 2 * DAY) }), [...heldAt(NOW - 27 * DAY), { event: "hold:captured", to_state: "RELEASED", created_at: new Date(NOW - DAY) }], NOW)).hold!;
    assert.equal(captured.holdExpiry, undefined);
    assert.notEqual(captured.eventColor, "red");
  });
});
