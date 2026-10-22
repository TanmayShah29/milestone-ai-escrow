import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { authorizedOrder, claimsFor, depsWith, jsonResponse, resetDb, sampleTerms, seedMilestone, stubFetch } from "./helpers";
import { db } from "@/lib/db";
import { authorizeHold, createHold, releaseFunds, syncMilestone, OutcomeUnknown } from "@/lib/money/flow";
import { createMilestone, getMilestone } from "@/lib/milestones/repo";
import { PaypalFailure } from "@/lib/paypal/errors";
import { POST as action } from "@/app/api/milestones/[id]/[action]/route";
import { GET as read } from "@/app/api/milestones/[id]/route";

beforeEach(resetDb);
after(() => db().end());

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
};

describe("money hardening (audit fixes)", () => {
  it("a 5xx on a payout is unknown, so the retry reuses the same request id (no double payout)", async () => {
    const id = await seedMilestone(released);
    let n = 0;
    const stub = stubFetch(() => (n++ === 0 ? jsonResponse(503, { name: "SERVICE_UNAVAILABLE" }) : jsonResponse(201, { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } })));
    const m = await releaseFunds(id, depsWith(stub));
    assert.equal(m.paypal_payout_batch_id, "BATCH1");
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0]!.request.headers.get("paypal-request-id"), `ms_${id}_payout_1`);
    assert.equal(stub.calls[1]!.request.headers.get("paypal-request-id"), `ms_${id}_payout_1`);
  });

  it("a 500 on authorize whose re-read shows PayPal didn't act releases the claim for a clean retry", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const stub = stubFetch(({ request }) => (request.method === "POST" ? jsonResponse(500, {}) : jsonResponse(200, { id: "ORDER1", status: "APPROVED" })));
    await assert.rejects(authorizeHold(id, "ORDER1", depsWith(stub)), (e: unknown) => e instanceof PaypalFailure && e.kind === "refused");
    assert.equal((await claimsFor(id))[0]!.status, "failed");

    const ok = stubFetch(() => jsonResponse(201, authorizedOrder("ORDER1", "AUTH1")));
    const m = await authorizeHold(id, "ORDER1", depsWith(ok));
    assert.equal(m.state, "FUNDED");
    assert.equal(ok.calls[0]!.request.headers.get("paypal-request-id"), `ms_${id}_authorize_2`);
  });

  it("if storing the result fails after PayPal acted, the claim becomes unknown (with the PayPal id), never pending", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const stub = stubFetch(async () => {
      await db().query("update milestones set state = 'CANCELLED' where id = $1", [id]); // the row moves under us
      return jsonResponse(201, authorizedOrder("ORDER1", "AUTH1"));
    });
    await assert.rejects(authorizeHold(id, "ORDER1", depsWith(stub)));
    const { rows } = await db().query<{ status: string; paypal_id: string }>("select status, paypal_id from money_actions where milestone_id = $1", [id]);
    assert.deepEqual(rows[0], { status: "unknown", paypal_id: "AUTH1" });
    const { rowCount } = await db().query("select 1 from audit_log where milestone_id = $1 and event = 'authorize:record_failed'", [id]);
    assert.equal(rowCount, 1);
  });

  it("a pending claim left by a crashed process is settled by re-read on the next call", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    await db().query(
      `insert into money_actions (milestone_id, action, attempt, request_id, status, created_at)
       values ($1, 'authorize', 1, $2, 'pending', now() - interval '5 minutes')`,
      [id, `ms_${id}_authorize_1`],
    );
    const stub = stubFetch(({ request }) => {
      assert.equal(request.method, "GET"); // re-read, not a second authorize
      return jsonResponse(200, authorizedOrder("ORDER1", "AUTH1"));
    });
    const m = await syncMilestone(id, depsWith(stub));
    assert.equal(m.state, "FUNDED");
  });

  it("an expired order is replaced instead of handing out a dead approve link", async () => {
    const id = await seedMilestone({ paypal_order_id: "OLD", approve_url: "https://old" });
    await db().query(`insert into money_actions (milestone_id, action, attempt, request_id, status) values ($1, 'create_order', 1, $2, 'succeeded')`, [id, `ms_${id}_create_order_1`]);
    const stub = stubFetch(({ request }) =>
      request.method === "GET"
        ? jsonResponse(404, { name: "RESOURCE_NOT_FOUND", message: "not found", debug_id: "d" })
        : jsonResponse(201, { id: "NEW", status: "CREATED", links: [{ href: "https://new", rel: "approve" }] }),
    );
    const m = await createHold(id, depsWith(stub));
    assert.equal(m.paypal_order_id, "NEW");
    assert.equal(m.approve_url, "https://new");
    assert.equal(stub.calls[1]!.request.headers.get("paypal-request-id"), `ms_${id}_create_order_2`);
  });

  it("a live order is reused, not recreated", async () => {
    const id = await seedMilestone({ paypal_order_id: "LIVE", approve_url: "https://live" });
    const stub = stubFetch(() => jsonResponse(200, { id: "LIVE", status: "CREATED" }));
    const m = await createHold(id, depsWith(stub));
    assert.equal(m.approve_url, "https://live");
    assert.equal(stub.calls.length, 1);
  });

  it("a returned payout moves the milestone to PAYOUT_FAILED", async () => {
    const id = await seedMilestone({ ...released, paypal_payout_batch_id: "BATCH1", payout_status: "PENDING" });
    const stub = stubFetch(() => jsonResponse(200, { batch_header: { batch_status: "SUCCESS" }, items: [{ payout_item_id: "ITEM1", transaction_status: "RETURNED" }] }));
    const m = await syncMilestone(id, depsWith(stub));
    assert.equal(m.state, "PAYOUT_FAILED");
    assert.equal(m.payout_status, "RETURNED");
  });

  it("two simultaneous fund clicks create one PayPal order", async () => {
    const id = await seedMilestone();
    const stub = stubFetch(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return jsonResponse(201, { id: "ORDER1", status: "CREATED", links: [{ href: "https://a", rel: "approve" }] });
    });
    const [a, b] = await Promise.all([createHold(id, depsWith(stub)), createHold(id, depsWith(stub))]);
    assert.equal(a.paypal_order_id, "ORDER1");
    assert.equal(b.paypal_order_id, "ORDER1");
    assert.equal(stub.calls.filter((c) => c.request.method === "POST").length, 1);
  });

  it("an unknown re-read keeps the claim unknown", async () => {
    const id = await seedMilestone({ paypal_order_id: "ORDER1" });
    const stub = stubFetch(({ request }) => (request.method === "POST" ? jsonResponse(502, {}) : jsonResponse(200, { id: "ORDER1", status: "COMPLETED" })));
    await assert.rejects(authorizeHold(id, "ORDER1", depsWith(stub)), OutcomeUnknown);
    assert.equal((await claimsFor(id))[0]!.status, "unknown");
  });
});

describe("access control", () => {
  const call = (id: string, act: string, token?: string) =>
    action(new Request(`http://localhost/api/milestones/${id}/${act}`, { method: "POST", headers: token ? { "x-milestone-token": token } : {} }), {
      params: Promise.resolve({ id, action: act }),
    });

  it("actions need a link token, and each side can only do its own actions", async () => {
    const { milestone, clientToken, workerToken } = await createMilestone({ title: "t", brief: "", amountCents: 100, freelancerEmail: "w@example.com" });
    const callWith = (act: string, token: string | undefined, body: unknown) =>
      action(new Request(`http://localhost/api/milestones/${milestone.id}/${act}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-milestone-token": token } : {}) }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ id: milestone.id, action: act }),
      });
    assert.equal((await call(milestone.id, "edit-terms")).status, 401);
    assert.equal((await callWith("edit-terms", workerToken, { terms: sampleTerms })).status, 403); // only the client writes terms
    assert.equal((await callWith("edit-terms", "mct_forged", { terms: sampleTerms })).status, 403);
    const edited = await callWith("edit-terms", clientToken, { terms: sampleTerms });
    assert.equal(edited.status, 200);
    const hash = (await edited.json()).milestone.criteria_hash;
    assert.equal((await call(milestone.id, "cancel", workerToken)).status, 403); // only the client cancels
    assert.equal((await callWith("sign-terms", workerToken, { hash })).status, 200);
    assert.equal((await callWith("sign-terms", clientToken, { hash })).status, 200);
    assert.equal((await getMilestone(milestone.id)).state, "AGREED");
  });

  it("reading a milestone needs a token, and never returns token hashes", async () => {
    const { milestone, workerToken } = await createMilestone({ title: "t", brief: "", amountCents: 100, freelancerEmail: "w@example.com" });
    const get = (token?: string) => read(new Request(`http://localhost/api/milestones/${milestone.id}`, { headers: token ? { "x-milestone-token": token } : {} }), { params: Promise.resolve({ id: milestone.id }) });
    assert.equal((await get()).status, 401);
    const res = await get(workerToken);
    const body = await res.json();
    assert.equal(body.role, "worker");
    assert.equal("client_token_hash" in body.milestone, false);
    assert.equal(JSON.stringify(body).includes(workerToken), false);
  });
});

describe("sandbox test-card funding", () => {
  it("one createOrder with payment_source.card funds the milestone, sharing the create_order claim", async () => {
    const { fundWithTestCard } = await import("@/lib/money/flow");
    const id = await seedMilestone();
    const stub = stubFetch(() => jsonResponse(201, authorizedOrder("ORDER9", "AUTH9")));
    const m = await fundWithTestCard(id, depsWith(stub));
    assert.equal(m.state, "FUNDED");
    assert.equal(m.paypal_authorization_id, "AUTH9");
    const sent = JSON.parse(stub.calls[0]!.body!);
    assert.equal(sent.payment_source.card.number, "4012888888881881");
    assert.equal(sent.intent, "AUTHORIZE");
    assert.equal(stub.calls[0]!.request.headers.get("paypal-request-id"), `ms_${id}_create_order_1`);
    const again = await fundWithTestCard(id, depsWith(stub)).catch((e: Error) => e);
    assert.ok(again instanceof Error); // already FUNDED: no second hold
    assert.equal(stub.calls.length, 1);
  });

  it("a refused card is not retried: the next attempt (new request id) uses the next test card", async () => {
    const { fundWithTestCard } = await import("@/lib/money/flow");
    const id = await seedMilestone();
    let n = 0;
    const stub = stubFetch(() =>
      ++n === 1
        ? jsonResponse(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYER_CANNOT_PAY", description: "Payer cannot pay for this transaction." }] })
        : jsonResponse(201, authorizedOrder("ORDER10", "AUTH10")),
    );
    const first = await fundWithTestCard(id, depsWith(stub)).catch((e: Error) => e);
    assert.ok(first instanceof Error);
    const m = await fundWithTestCard(id, depsWith(stub));
    assert.equal(m.state, "FUNDED");
    const cards = stub.calls.map((c) => JSON.parse(c.body!).payment_source.card.number);
    assert.deepEqual(cards, ["4012888888881881", "4111111111111111"]);
    assert.equal(stub.calls[1]!.request.headers.get("paypal-request-id"), `ms_${id}_create_order_2`);
  });
});
