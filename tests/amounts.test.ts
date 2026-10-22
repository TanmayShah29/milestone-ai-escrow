import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { centsToValue, estimatePaypalFee, estimateSplit, payoutFeeCapCents, scheduleFor, signedPlatformBps, splitCapture, valueToCents, type FeeSchedule } from "@/lib/money/amounts";

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

  const usual: FeeSchedule = { platformBps: 500, payoutBps: 200, payoutCapCents: 100 };

  it("estimates PayPal's checkout fee at 3.49% + 49 cents", () => {
    assert.equal(estimatePaypalFee(30_000), 1_096); // 1047 + 49
    assert.equal(estimatePaypalFee(1_000), 84); // 34.9 → 35, + 49
  });

  it("worker receives captured minus PayPal fee, payout fee and platform fee, exact to the cent", () => {
    assert.deepEqual(splitCapture(30_000, 1_096, usual), { paypalFeeCents: 1_096, feeCents: 1_500, payoutFeeCents: 100, payoutCents: 27_304 });
    // The capture's real fee replaces the estimate.
    assert.deepEqual(splitCapture(30_000, 1_077, usual), { paypalFeeCents: 1_077, feeCents: 1_500, payoutFeeCents: 100, payoutCents: 27_323 });
    // Under the cap: 2% of $8.66 = 17 cents.
    assert.deepEqual(splitCapture(1_000, 84, usual), { paypalFeeCents: 84, feeCents: 50, payoutFeeCents: 17, payoutCents: 849 });
    // No cap.
    assert.deepEqual(splitCapture(30_000, 1_096, { ...usual, payoutCapCents: null }), { paypalFeeCents: 1_096, feeCents: 1_500, payoutFeeCents: 548, payoutCents: 26_856 });
    // No fees at all.
    assert.deepEqual(splitCapture(30_000, 0, { platformBps: 0, payoutBps: 0, payoutCapCents: null }), { paypalFeeCents: 0, feeCents: 0, payoutFeeCents: 0, payoutCents: 30_000 });
  });

  it("the payout is never negative and the parts always add up to the captured amount", () => {
    assert.deepEqual(splitCapture(50, 84, usual), { paypalFeeCents: 50, feeCents: 0, payoutFeeCents: 0, payoutCents: 0 });
    for (let c = 0; c <= 5_000; c += 7) {
      for (const s of [usual, { platformBps: 10_000, payoutBps: 10_000, payoutCapCents: null }, { platformBps: 0, payoutBps: 0, payoutCapCents: 0 }]) {
        const x = splitCapture(c, estimatePaypalFee(c), s);
        for (const v of Object.values(x)) assert.ok(Number.isInteger(v) && v >= 0);
        assert.equal(x.paypalFeeCents + x.feeCents + x.payoutFeeCents + x.payoutCents, c);
        assert.ok(x.payoutCents <= c);
      }
    }
    assert.throws(() => splitCapture(-1, 0, usual));
    assert.throws(() => splitCapture(100, 1.5, usual));
  });

  it("estimateSplit uses the estimated PayPal fee (the $10 minimum leaves the worker $8.49)", () => {
    assert.deepEqual(estimateSplit(1_000, usual), { paypalFeeCents: 84, feeCents: 50, payoutFeeCents: 17, payoutCents: 849 });
    assert.deepEqual(estimateSplit(30_000), splitCapture(30_000, 1_096, usual)); // defaults match the env defaults
  });

  it("the platform fee both sides signed (terms policy) wins over the env; older contracts use the env", () => {
    assert.equal(signedPlatformBps({ criteria: [], policy: { platformFeeBps: 300, objectionWindowSeconds: 259200 } }), 300);
    assert.equal(signedPlatformBps({ criteria: [] }), undefined);
    assert.equal(signedPlatformBps(null), undefined);
    assert.equal(signedPlatformBps({ policy: { platformFeeBps: 1.5 } }), undefined);
    assert.deepEqual(scheduleFor({ policy: { platformFeeBps: 300 } }, usual), { ...usual, platformBps: 300 });
    assert.deepEqual(scheduleFor({ criteria: [] }, usual), usual);
  });

  it("PAYOUT_FEE_CAP_CENTS: default $1.00, empty means no cap, garbage is refused", () => {
    const saved = process.env.PAYOUT_FEE_CAP_CENTS;
    try {
      delete process.env.PAYOUT_FEE_CAP_CENTS;
      assert.equal(payoutFeeCapCents(), 100);
      process.env.PAYOUT_FEE_CAP_CENTS = "";
      assert.equal(payoutFeeCapCents(), null);
      process.env.PAYOUT_FEE_CAP_CENTS = "-5";
      assert.throws(() => payoutFeeCapCents());
    } finally {
      if (saved === undefined) delete process.env.PAYOUT_FEE_CAP_CENTS;
      else process.env.PAYOUT_FEE_CAP_CENTS = saved;
    }
  });
});
