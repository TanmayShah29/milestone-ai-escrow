import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { authorizedOrder, depsWith, jsonResponse, resetDb, seedMilestone, stubFetch } from "./helpers";
import { db } from "@/lib/db";
import { handleWebhookEvent } from "@/lib/money/webhooks";
import { getMilestone } from "@/lib/milestones/repo";
import { verifyWebhookSignature, type WebhookEvent } from "@/lib/paypal/webhooks";
import { POST } from "@/app/api/paypal/webhook/route";

beforeEach(resetDb);
after(() => db().end());

const signedHeaders = new Headers({
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-10-20T17:00:00Z",
});

const payoutSucceeded = (milestoneId: string, id = "WH-EVT-1"): WebhookEvent => ({
  id,
  event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  resource: { payout_item_id: "ITEM1", payout_batch_id: "BATCH1", transaction_status: "SUCCESS", payout_item: { sender_item_id: milestoneId } },
});

describe("verifyWebhookSignature", () => {
  it("sends the transmission headers, our webhook id and the event, and trusts only SUCCESS", async () => {
    for (const [status, expected] of [["SUCCESS", true], ["FAILURE", false]] as const) {
      const stub = stubFetch(() => jsonResponse(200, { verification_status: status }));
      const ok = await verifyWebhookSignature(signedHeaders, payoutSucceeded("x"), stub.fetch);
      assert.equal(ok, expected);
      const sent = JSON.parse(stub.calls[0]!.body!);
      assert.equal(stub.calls[0]!.url.pathname, "/v1/notifications/verify-webhook-signature");
      assert.equal(sent.webhook_id, "WH-TEST");
      assert.equal(sent.transmission_id, "tx-1");
      assert.equal(sent.webhook_event.id, "WH-EVT-1");
    }
  });

  it("rejects a request missing transmission headers without calling PayPal", async () => {
    const stub = stubFetch(() => jsonResponse(200, { verification_status: "SUCCESS" }));
    assert.equal(await verifyWebhookSignature(new Headers(), payoutSucceeded("x"), stub.fetch), false);
    assert.equal(stub.calls.length, 0);
  });

  it("the route answers 400 to an unsigned event and records nothing", async () => {
    const id = await seedMilestone({ state: "RELEASED" });
    const res = await POST(new Request("http://localhost/api/paypal/webhook", { method: "POST", body: JSON.stringify(payoutSucceeded(id)) }));
    assert.equal(res.status, 400);
    assert.equal((await db().query("select 1 from webhook_events")).rowCount, 0);
  });
});

describe("handleWebhookEvent", () => {
  const released = {
    state: "RELEASED",
    paypal_order_id: "ORDER1",
    paypal_authorization_id: "AUTH1",
    authorized_cents: 30_000,
    paypal_capture_id: "CAP1",
    capture_status: "COMPLETED",
    captured_cents: 30_000,
    fee_cents: 1_500,
    payout_cents: 28_500,
    paypal_payout_batch_id: "BATCH1",
    payout_status: "PENDING",
  };

  it("a payout-succeeded event re-reads PayPal and marks the milestone PAID_OUT", async () => {
    const id = await seedMilestone(released);
    const stub = stubFetch(({ url }) => {
      assert.equal(url.pathname, "/v1/payments/payouts/BATCH1");
      return jsonResponse(200, { batch_header: { batch_status: "SUCCESS" }, items: [{ payout_item_id: "ITEM1", transaction_status: "SUCCESS" }] });
    });
    const out = await handleWebhookEvent(payoutSucceeded(id), depsWith(stub));
    assert.deepEqual(out, { status: "processed", milestoneId: id });
    const m = await getMilestone(id);
    assert.equal(m.state, "PAID_OUT");
    assert.equal(m.paypal_payout_item_id, "ITEM1");
  });

  it("a redelivered event is a no-op", async () => {
    const id = await seedMilestone(released);
    const stub = stubFetch(() => jsonResponse(200, { batch_header: { batch_status: "SUCCESS" }, items: [{ payout_item_id: "ITEM1", transaction_status: "SUCCESS" }] }));
    await handleWebhookEvent(payoutSucceeded(id), depsWith(stub));
    const again = await handleWebhookEvent(payoutSucceeded(id), depsWith(stub));
    assert.equal(again.status, "duplicate");
    assert.equal(stub.calls.length, 1);
  });

  it("an event for no known milestone is stored and ignored", async () => {
    const stub = stubFetch(() => jsonResponse(500, {}));
    const out = await handleWebhookEvent({ id: "WH-X", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "SOMEONE_ELSES" } }, depsWith(stub));
    assert.equal(out.status, "ignored");
    assert.equal(stub.calls.length, 0);
    const { rows } = await db().query<{ status: string }>("select status from webhook_events where id = 'WH-X'");
    assert.equal(rows[0]!.status, "ignored");
  });

  it("CHECKOUT.ORDER.APPROVED authorizes the hold if the client never came back", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const stub = stubFetch(() => jsonResponse(201, authorizedOrder("ORDER1", "AUTH1")));
    await handleWebhookEvent({ id: "WH-A", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER1", status: "APPROVED" } }, depsWith(stub));
    const m = await getMilestone(id);
    assert.equal(m.state, "FUNDED");
    assert.equal(m.paypal_authorization_id, "AUTH1");
  });

  it("a processing failure marks the event failed so a redelivery is processed again", async () => {
    const id = await seedMilestone(released);
    let n = 0;
    const stub = stubFetch(() =>
      n++ === 0 ? jsonResponse(500, { name: "INTERNAL_SERVER_ERROR" }) : jsonResponse(200, { batch_header: { batch_status: "SUCCESS" }, items: [{ payout_item_id: "ITEM1", transaction_status: "SUCCESS" }] }),
    );
    await assert.rejects(handleWebhookEvent(payoutSucceeded(id), depsWith(stub)));
    const retry = await handleWebhookEvent(payoutSucceeded(id), depsWith(stub));
    assert.equal(retry.status, "processed");
    assert.equal((await getMilestone(id)).state, "PAID_OUT");
  });
});
