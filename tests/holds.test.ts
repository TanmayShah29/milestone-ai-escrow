import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dueCapMessage, holdWarning, latestDueAt } from "@/lib/timeline";

// Pure (no DB): the 29-day hold rules behind the due-date cap and the hold-expiry warning.

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
