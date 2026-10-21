import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { authorizedOrder, claimsFor, connectionDrop, depsWith, jsonResponse, resetDb, seedMilestone, stubFetch } from "./helpers";
import { db } from "@/lib/db";
import { authorizeHold, cancelHold, createHold, InvariantViolation, releaseFunds } from "@/lib/money/flow";
import { claimAction } from "@/lib/money/claims";
import { getMilestone } from "@/lib/milestones/repo";
import { PaypalFailure } from "@/lib/paypal/errors";
import { toHttp } from "@/lib/http";
import { PaypalClient } from "paypal";

beforeEach(resetDb);
after(() => db().end());

const createdOrder = { id: "ORDER1", status: "CREATED", links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1", rel: "approve", method: "GET" }] };

describe("createHold", () => {
  it("sends the claim's PayPal-Request-Id, return=representation, and only headers we own", async () => {
    const id = await seedMilestone();
    let claimSeenAtSend: string | undefined;
    const stub = stubFetch(async () => {
      claimSeenAtSend = (await claimsFor(id))[0]?.status; // the claim exists before the request leaves
      return jsonResponse(201, createdOrder);
    });
    const m = await createHold(id, depsWith(stub));

    assert.equal(m.paypal_order_id, "ORDER1");
    assert.equal(m.approve_url, createdOrder.links[0]!.href);
    assert.equal(claimSeenAtSend, "pending");
    const { request, body, url } = stub.calls[0]!;
    assert.equal(request.method, "POST");
    assert.equal(url.pathname, "/v2/checkout/orders");
    assert.equal(request.headers.get("paypal-request-id"), `ms_${id}_create_order_1`);
    assert.equal(request.headers.get("prefer"), "return=representation");
    for (const h of ["paypal-auth-assertion", "paypal-partner-attribution-id", "paypal-client-metadata-id", "paypal-mock-response"]) {
      assert.equal(request.headers.get(h), null, h);
    }
    const sent = JSON.parse(body!);
    assert.equal(sent.intent, "AUTHORIZE");
    assert.deepEqual(sent.purchase_units[0].amount, { currency_code: "USD", value: "300.00" });
    assert.equal(sent.purchase_units[0].custom_id, id);
    assert.equal(sent.application_context.shipping_preference, "NO_SHIPPING");
  });

  it("connection drop replays with the same PayPal-Request-Id", async () => {
    const id = await seedMilestone();
    let n = 0;
    const stub = stubFetch(() => (n++ === 0 ? connectionDrop() : jsonResponse(201, createdOrder)));
    const m = await createHold(id, depsWith(stub));

    assert.equal(m.paypal_order_id, "ORDER1");
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0]!.request.headers.get("paypal-request-id"), stub.calls[1]!.request.headers.get("paypal-request-id"));
    assert.equal((await claimsFor(id))[0]!.status, "succeeded");
  });

  it("a second claim for the same action is rejected by the store", async () => {
    const id = await seedMilestone();
    const first = await claimAction(db(), id, "create_order");
    const second = await claimAction(db(), id, "create_order");
    assert.equal(first.won, true);
    assert.equal(second.won, false);
    assert.equal(second.claim.request_id, first.claim.request_id);
  });
});

describe("authorizeHold", () => {
  it("connection drop re-reads the order and records the authorization", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const stub = stubFetch(({ request, url }) => {
      if (request.method === "POST") return connectionDrop();
      assert.equal(url.pathname, "/v2/checkout/orders/ORDER1");
      return jsonResponse(200, authorizedOrder("ORDER1", "AUTH1"));
    });
    const m = await authorizeHold(id, "ORDER1", depsWith(stub));

    assert.equal(m.state, "FUNDED");
    assert.equal(m.paypal_authorization_id, "AUTH1");
    assert.equal(m.authorized_cents, 30_000);
    assert.deepEqual(stub.calls.map((c) => c.request.method), ["POST", "GET"]);
  });

  it("sends an empty JSON body so PayPal gets a Content-Type (415 otherwise)", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const stub = stubFetch(() => jsonResponse(201, authorizedOrder("ORDER1", "AUTH1")));
    await authorizeHold(id, "ORDER1", depsWith(stub));
    const { request, body } = stub.calls[0]!;
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.equal(body, "{}");
    assert.equal(request.headers.get("paypal-request-id"), `ms_${id}_authorize_1`);
  });

  it("an error from another copy of the SDK (no instanceof) is still classified, not left pending", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const foreign = Object.assign(new Error("POST … failed with 415"), {
      kind: "api", method: "POST", uri: "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1/authorize", status: 415, headers: new Headers(),
      payload: { kind: "error7", body: { name: "UNSUPPORTED_MEDIA_TYPE", message: "The request payload is not supported", debugId: "d415" } },
    });
    const deps = depsWith(stubFetch(() => jsonResponse(500, {})));
    deps.paypal = { orders: { authorizeOrder: () => Promise.reject(foreign) } } as unknown as typeof deps.paypal;
    await assert.rejects(authorizeHold(id, "ORDER1", deps), (e: unknown) => e instanceof PaypalFailure && e.kind === "refused" && e.detail.status === 415);
    assert.equal((await claimsFor(id))[0]!.status, "failed");
  });

  it("a non-PayPal error after the call marks the claim unknown, never pending", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const deps = depsWith(stubFetch(() => jsonResponse(500, {})));
    deps.paypal = { orders: { authorizeOrder: () => Promise.reject(new TypeError("boom")) } } as unknown as typeof deps.paypal;
    await assert.rejects(authorizeHold(id, "ORDER1", deps), TypeError);
    assert.equal((await claimsFor(id))[0]!.status, "unknown");
  });

  it("a connection drop whose re-read shows the order still APPROVED (no authorization) releases the claim", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const stub = stubFetch(({ request }) => (request.method === "POST" ? connectionDrop() : jsonResponse(200, { id: "ORDER1", status: "APPROVED" })));
    await assert.rejects(authorizeHold(id, "ORDER1", depsWith(stub)), (e: unknown) => e instanceof PaypalFailure && e.kind === "refused");
    assert.equal((await claimsFor(id))[0]!.status, "failed");
    assert.equal((await getMilestone(id)).state, "AGREED");
  });

  it("AuthError releases the claim and makes no re-read", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const calls: string[] = [];
    const failingToken: typeof fetch = async (input, init) => {
      const r = new Request(input, init);
      calls.push(new URL(r.url).pathname);
      return jsonResponse(401, { error: "invalid_client" });
    };
    const client = new PaypalClient({ serverOptions: { baseUrl: "https://api-m.sandbox.paypal.com" }, oauth2: { clientId: "x", clientSecret: "y" }, retry: { maxRetries: 0 }, logging: { level: "off" }, fetch: failingToken });
    await assert.rejects(authorizeHold(id, "ORDER1", { paypal: client, fetch: failingToken, appUrl: "" }), (e: unknown) => e instanceof PaypalFailure && e.kind === "never_sent");
    assert.deepEqual(calls, ["/v1/oauth2/token"]); // no authorize sent, no getOrder re-read
    assert.equal((await claimsFor(id))[0]!.status, "failed");
  });

  it("a return token that isn't this milestone's order is rejected with no PayPal call", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const stub = stubFetch(() => jsonResponse(500, {}));
    await assert.rejects(authorizeHold(id, "SOMEONE_ELSES_ORDER", depsWith(stub)), InvariantViolation);
    assert.equal(stub.calls.length, 0);
    assert.equal((await claimsFor(id)).length, 0);
  });

  it("a 422 refusal releases the claim and its reason reaches the caller", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const stub = stubFetch(() =>
      jsonResponse(422, { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed", debug_id: "dbg1", details: [{ issue: "ORDER_NOT_APPROVED", description: "Payer has not yet approved the Order for payment." }] }),
    );
    let caught: unknown;
    await authorizeHold(id, "ORDER1", depsWith(stub)).catch((e) => (caught = e));
    const res = toHttp(caught);
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, "Payer has not yet approved the Order for payment.");
    assert.equal(body.debugId, "dbg1");
    assert.equal((await claimsFor(id))[0]!.status, "failed");
  });

  it("a 401 from PayPal maps to 502 with a fixed message", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const stub = stubFetch(() => jsonResponse(401, { name: "AUTHENTICATION_FAILURE", message: "Authentication failed", debug_id: "d" }));
    let caught: unknown;
    await authorizeHold(id, "ORDER1", depsWith(stub)).catch((e) => (caught = e));
    const res = toHttp(caught);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "PayPal rejected our credentials");
  });
});

describe("releaseFunds", () => {
  const funded = { state: "PASSED", paypal_order_id: "ORDER1", paypal_authorization_id: "AUTH1", authorized_cents: 30_000 };

  it("captures the agreed amount, then pays out captured minus fee", async () => {
    const id = await seedMilestone(funded);
    const stub = stubFetch(({ url }) => {
      if (url.pathname === "/v2/payments/authorizations/AUTH1/capture") return jsonResponse(201, { id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "300.00" } });
      if (url.pathname === "/v1/payments/payouts") return jsonResponse(201, { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } });
      throw new Error(`unexpected ${url.pathname}`);
    });
    const m = await releaseFunds(id, depsWith(stub));

    assert.equal(m.state, "RELEASED");
    assert.equal(m.paypal_capture_id, "CAP1");
    assert.equal(m.fee_cents, 1_500);
    assert.equal(m.payout_cents, 28_500);
    assert.equal(m.paypal_payout_batch_id, "BATCH1");
    const capture = JSON.parse(stub.calls[0]!.body!);
    assert.deepEqual(capture, { amount: { currency_code: "USD", value: "300.00" }, final_capture: true });
    const payout = JSON.parse(stub.calls[1]!.body!);
    assert.equal(payout.items[0].amount.value, "285.00");
    assert.equal(payout.sender_batch_header.sender_batch_id, `ms_${id}_payout_1`);
    assert.equal(stub.calls[1]!.request.headers.get("paypal-request-id"), `ms_${id}_payout_1`);
  });

  it("a capture timeout re-reads the order to find the capture", async () => {
    const id = await seedMilestone(funded);
    const stub = stubFetch(({ url, request }) => {
      if (url.pathname.endsWith("/capture")) return connectionDrop();
      if (request.method === "GET" && url.pathname === "/v2/checkout/orders/ORDER1") {
        return jsonResponse(200, { id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "PENDING", amount: { currency_code: "USD", value: "300.00" } }] } }] });
      }
      throw new Error(`unexpected ${url.pathname}`);
    });
    const m = await releaseFunds(id, depsWith(stub));
    assert.equal(m.state, "RELEASED");
    assert.equal(m.paypal_capture_id, "CAP1");
    assert.equal(m.paypal_payout_batch_id, null); // capture still PENDING: no payout yet
  });

  it("refuses to capture above the authorized amount, before any call", async () => {
    const id = await seedMilestone({ ...funded, authorized_cents: 10_000 });
    const stub = stubFetch(() => jsonResponse(500, {}));
    await assert.rejects(releaseFunds(id, depsWith(stub)), InvariantViolation);
    assert.equal(stub.calls.length, 0);
    assert.equal((await claimsFor(id)).length, 0);
  });

  it("a payout connection drop replays the batch with the same request id", async () => {
    const id = await seedMilestone({ ...funded, state: "RELEASED", paypal_capture_id: "CAP1", capture_status: "COMPLETED", captured_cents: 30_000, fee_cents: 1_500, payout_cents: 28_500 });
    let n = 0;
    const stub = stubFetch(() => (n++ === 0 ? connectionDrop() : jsonResponse(201, { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } })));
    const m = await releaseFunds(id, depsWith(stub));
    assert.equal(m.paypal_payout_batch_id, "BATCH1");
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0]!.request.headers.get("paypal-request-id"), stub.calls[1]!.request.headers.get("paypal-request-id"));
  });
});

describe("cancelHold", () => {
  it("a void connection drop re-reads the authorization", async () => {
    const id = await seedMilestone({ state: "FUNDED", paypal_order_id: "ORDER1", paypal_authorization_id: "AUTH1", authorized_cents: 30_000 });
    const stub = stubFetch(({ request, url }) => {
      if (request.method === "POST") return connectionDrop();
      assert.equal(url.pathname, "/v2/payments/authorizations/AUTH1");
      return jsonResponse(200, { id: "AUTH1", status: "VOIDED" });
    });
    const m = await cancelHold(id, depsWith(stub));
    assert.equal(m.state, "CANCELLED");
  });

  it("is refused once work is submitted, with no PayPal call", async () => {
    const id = await seedMilestone({ state: "SUBMITTED", paypal_order_id: "ORDER1", paypal_authorization_id: "AUTH1", authorized_cents: 30_000 });
    const stub = stubFetch(() => jsonResponse(500, {}));
    await assert.rejects(cancelHold(id, depsWith(stub)), InvariantViolation);
    assert.equal(stub.calls.length, 0);
  });
});
