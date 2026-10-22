import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { depsWith, jsonResponse, resetDb, seedMilestone, stubFetch } from "./helpers";
import { db } from "@/lib/db";
import { cancelHold, InvariantViolation, releaseFunds, syncMilestone } from "@/lib/money/flow";
import { handleWebhookEvent } from "@/lib/money/webhooks";
import { getMilestone } from "@/lib/milestones/repo";
import { POST as create } from "@/app/api/milestones/route";

// H2: a hold that ends at PayPal cancels the milestone, the client's cancel exits, fees net of PayPal's
// real fee, and the $10 minimum.

beforeEach(async () => {
  await resetDb();
  await db().query("truncate rate_events");
});
after(() => db().end());

const held = { paypal_order_id: "ORDER1", paypal_authorization_id: "AUTH1", authorized_cents: 30_000 };

async function auditEvents(id: string, event: string) {
  const { rows } = await db().query<{ detail: Record<string, unknown> }>("select detail from audit_log where milestone_id = $1 and event = $2", [id, event]);
  return rows;
}

describe("hold ended at PayPal", () => {
  for (const state of ["FUNDED", "SUBMITTED", "IN_REVIEW", "CHANGES_REQUESTED", "HUMAN_CHECK", "PASSED", "CONTESTED"]) {
    it(`a voided authorization moves ${state} to CANCELLED on sync`, async () => {
      const id = await seedMilestone({ ...held, state });
      const stub = stubFetch(({ url }) => {
        assert.equal(url.pathname, "/v2/payments/authorizations/AUTH1");
        return jsonResponse(200, { id: "AUTH1", status: "VOIDED" });
      });
      const m = await syncMilestone(id, depsWith(stub));
      assert.equal(m.state, "CANCELLED");
      assert.ok(m.hold_ended_at);
      const rows = await auditEvents(id, "hold:ended");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.detail.status, "VOIDED");
    });
  }

  it("is idempotent: a second sync makes no PayPal call and writes no second audit row", async () => {
    const id = await seedMilestone({ ...held, state: "FUNDED" });
    const stub = stubFetch(() => jsonResponse(200, { id: "AUTH1", status: "EXPIRED" }));
    await syncMilestone(id, depsWith(stub));
    await syncMilestone(id, depsWith(stub));
    assert.equal(stub.calls.length, 1);
    assert.equal((await auditEvents(id, "hold:ended")).length, 1);
    assert.equal((await getMilestone(id)).state, "CANCELLED");
  });

  it("a live hold (CREATED) changes nothing", async () => {
    const id = await seedMilestone({ ...held, state: "FUNDED" });
    const stub = stubFetch(() => jsonResponse(200, { id: "AUTH1", status: "CREATED" }));
    const m = await syncMilestone(id, depsWith(stub));
    assert.equal(m.state, "FUNDED");
    assert.equal(m.hold_ended_at, null);
  });

  it("never cancels once a capture is claimed", async () => {
    const id = await seedMilestone({ ...held, state: "PASSED" });
    await db().query(`insert into money_actions (milestone_id, action, attempt, request_id, status) values ($1, 'capture', 1, $2, 'succeeded')`, [id, `ms_${id}_capture_1`]);
    const stub = stubFetch(() => jsonResponse(200, { id: "AUTH1", status: "VOIDED" }));
    const m = await syncMilestone(id, depsWith(stub));
    assert.equal(m.state, "PASSED");
    assert.equal(stub.calls.length, 0);
  });

  it("PAYMENT.AUTHORIZATION.VOIDED cancels a pre-capture milestone, once", async () => {
    const id = await seedMilestone({ ...held, state: "HUMAN_CHECK" });
    const stub = stubFetch(() => jsonResponse(200, { id: "AUTH1", status: "VOIDED" }));
    const event = { id: "WH-VOID-1", event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: "AUTH1", status: "VOIDED", custom_id: id } };
    assert.deepEqual(await handleWebhookEvent(event, depsWith(stub)), { status: "processed", milestoneId: id });
    assert.equal((await getMilestone(id)).state, "CANCELLED");
    assert.equal((await handleWebhookEvent(event, depsWith(stub))).status, "duplicate");
    assert.equal((await auditEvents(id, "hold:ended")).length, 1);
  });
});

describe("client cancel exits", () => {
  for (const state of ["CHANGES_REQUESTED", "HUMAN_CHECK"]) {
    it(`voids the hold from ${state}`, async () => {
      const id = await seedMilestone({ ...held, state });
      const stub = stubFetch(({ url, request }) => {
        assert.equal(request.method, "POST");
        assert.equal(url.pathname, "/v2/payments/authorizations/AUTH1/void");
        assert.equal(request.headers.get("paypal-request-id"), `ms_${id}_void_1`);
        return jsonResponse(200, { id: "AUTH1", status: "VOIDED" });
      });
      const m = await cancelHold(id, depsWith(stub));
      assert.equal(m.state, "CANCELLED");
      assert.ok(m.hold_ended_at);
    });
  }

  it("is refused from a HUMAN_CHECK that follows an objection, with no PayPal call", async () => {
    const id = await seedMilestone({ ...held, state: "HUMAN_CHECK", contested_at: new Date() });
    const stub = stubFetch(() => jsonResponse(500, {}));
    await assert.rejects(cancelHold(id, depsWith(stub)), InvariantViolation);
    assert.equal(stub.calls.length, 0);
  });

  it("the system (decision policy) may void a post-objection HUMAN_CHECK, and the audit row says system", async () => {
    const id = await seedMilestone({ ...held, state: "HUMAN_CHECK", contested_at: new Date() });
    const stub = stubFetch(() => jsonResponse(200, { id: "AUTH1", status: "VOIDED" }));
    const m = await cancelHold(id, depsWith(stub), { actor: "system" });
    assert.equal(m.state, "CANCELLED");
    assert.equal(stub.calls[0]!.request.headers.get("paypal-request-id"), `ms_${id}_void_1`);
    const { rows } = await db().query<{ actor: string }>("select actor from audit_log where milestone_id = $1 and event = 'hold:voided'", [id]);
    assert.deepEqual(rows, [{ actor: "system" }]);
  });

  it("the system may not void after a capture", async () => {
    const id = await seedMilestone({ ...held, state: "RELEASED", paypal_capture_id: "CAP1", capture_status: "COMPLETED", captured_cents: 30_000 });
    const stub = stubFetch(() => jsonResponse(500, {}));
    await assert.rejects(cancelHold(id, depsWith(stub), { actor: "system" }), InvariantViolation);
    assert.equal(stub.calls.length, 0);
  });

  it("is refused from PASSED, with no PayPal call", async () => {
    const id = await seedMilestone({ ...held, state: "PASSED" });
    const stub = stubFetch(() => jsonResponse(500, {}));
    await assert.rejects(cancelHold(id, depsWith(stub)), InvariantViolation);
    assert.equal(stub.calls.length, 0);
  });
});

describe("fees from the capture", () => {
  it("uses the capture's seller_receivable_breakdown.paypal_fee and pays out net of every fee", async () => {
    const id = await seedMilestone({ ...held, state: "PASSED" });
    const stub = stubFetch(({ url }) => {
      if (url.pathname === "/v2/payments/authorizations/AUTH1/capture") {
        return jsonResponse(201, {
          id: "CAP1",
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "300.00" },
          seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: "300.00" }, paypal_fee: { currency_code: "USD", value: "10.77" }, net_amount: { currency_code: "USD", value: "289.23" } },
        });
      }
      if (url.pathname === "/v1/payments/payouts") return jsonResponse(201, { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const m = await releaseFunds(id, depsWith(stub));
    assert.equal(m.paypal_fee_cents, 1_077);
    assert.equal(m.fee_cents, 1_500);
    assert.equal(m.payout_fee_cents, 100);
    assert.equal(m.payout_cents, 27_323);
    assert.equal(JSON.parse(stub.calls[1]!.body!).items[0].amount.value, "273.23");
    const rows = await auditEvents(id, "hold:captured");
    assert.equal(rows[0]!.detail.paypalFeeSource, "paypal");
  });

  it("charges the platform fee both sides signed (terms policy), not the env's", async () => {
    const id = await seedMilestone({ ...held, state: "PASSED" });
    await db().query("update milestones set criteria = criteria || $2::jsonb where id = $1", [id, JSON.stringify({ policy: { platformFeeBps: 300, objectionWindowSeconds: 259_200 } })]);
    const stub = stubFetch(({ url }) =>
      url.pathname.endsWith("/capture")
        ? jsonResponse(201, { id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "300.00" }, seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: "300.00" }, paypal_fee: { currency_code: "USD", value: "10.77" } } })
        : jsonResponse(201, { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } }),
    );
    const m = await releaseFunds(id, depsWith(stub));
    assert.equal(m.fee_cents, 900); // 3% of $300, as signed (env says 5%)
    assert.equal(m.payout_cents, 30_000 - 1_077 - 900 - 100);
  });

  it("a pending capture's fee, reported later, re-splits the payout before it is sent", async () => {
    const id = await seedMilestone({ ...held, state: "RELEASED", paypal_capture_id: "CAP1", capture_status: "PENDING", captured_cents: 30_000, paypal_fee_cents: 1_096, fee_cents: 1_500, payout_fee_cents: 100, payout_cents: 27_304 });
    const stub = stubFetch(({ url }) => {
      if (url.pathname === "/v2/payments/captures/CAP1") {
        return jsonResponse(200, { id: "CAP1", status: "COMPLETED", seller_receivable_breakdown: { gross_amount: { currency_code: "USD", value: "300.00" }, paypal_fee: { currency_code: "USD", value: "10.77" } } });
      }
      if (url.pathname === "/v1/payments/payouts") return jsonResponse(201, { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } });
      if (url.pathname === "/v1/payments/payouts/BATCH1") return jsonResponse(200, { batch_header: { batch_status: "PENDING" }, items: [] });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const m = await syncMilestone(id, depsWith(stub));
    assert.equal(m.paypal_fee_cents, 1_077);
    assert.equal(m.payout_cents, 27_323);
    assert.equal(JSON.parse(stub.calls.find((c) => c.url.pathname === "/v1/payments/payouts")!.body!).items[0].amount.value, "273.23");
  });
});

describe("minimum amount", () => {
  const req = (amount: string) =>
    new Request("http://localhost/api/milestones", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ title: "Small job", amount, freelancerEmail: "worker@example.com" }),
    });

  it("refuses less than $10.00 with human copy, and accepts exactly $10.00", async () => {
    const res = await create(req("9.99"));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /smallest milestone is \$10\.00/);
    assert.equal((await create(req("10.00"))).status, 201);
  });
});
