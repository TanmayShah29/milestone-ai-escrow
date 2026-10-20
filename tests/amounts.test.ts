import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { centsToValue, splitCapture, valueToCents } from "@/lib/money/amounts";

describe("amounts", () => {
  it("round-trips cents and PayPal decimal strings", () => {
    assert.equal(centsToValue(30_000), "300.00");
    assert.equal(centsToValue(5), "0.05");
    assert.equal(valueToCents("300.00"), 30_000);
    assert.equal(valueToCents("12.5"), 1_250);
    assert.equal(valueToCents("7"), 700);
    assert.throws(() => valueToCents("1.234"));
    assert.throws(() => valueToCents("-1.00"));
  });

  it("payout is captured minus the platform fee, never more", () => {
    assert.deepEqual(splitCapture(30_000, 500), { feeCents: 1_500, payoutCents: 28_500 });
    assert.deepEqual(splitCapture(101, 500), { feeCents: 5, payoutCents: 96 });
    assert.deepEqual(splitCapture(30_000, 0), { feeCents: 0, payoutCents: 30_000 });
  });
});
