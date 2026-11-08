import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, beforeEach, describe, it } from "node:test";
import { depsWith, jsonResponse, resetDb, seedMilestone, stubFetch } from "./helpers";
import { db } from "@/lib/db";
import { hashToken, newToken } from "@/lib/auth";
import { audit, getMilestone } from "@/lib/milestones/repo";
import { fundWithTestCard, releaseFunds } from "@/lib/money/flow";
import { ACTION_ROLES } from "@/lib/platform/actions";
import { hookProblem } from "@/lib/platform/hooks";
import { openapi } from "@/lib/platform/openapi";
import { backoffMinutes, deliverDue, MAX_ATTEMPTS, signPayload, webhookUrlProblem } from "@/lib/platform/outbound";
import { POST as create } from "@/app/api/milestones/route";
import { GET as platformGet, POST as platformPost } from "@/app/api/platform/route";

beforeEach(async () => {
  await resetDb();
  await db().query("truncate platforms, outbound_events, idempotency_keys cascade");
});
after(() => db().end());

async function platform(o: { webhook?: string; hooks?: unknown } = {}) {
  const key = newToken("msk");
  const { rows } = await db().query<{ id: string }>("insert into platforms (name, api_key_hash, webhook_url, webhook_secret, hooks) values ('Acme Market', $1, $2, $3, $4) returning id", [
    hashToken(key),
    o.webhook ?? null,
    o.webhook ? "mwhsec_test" : null,
    JSON.stringify(o.hooks ?? {}),
  ]);
  return { id: rows[0]!.id, key };
}

describe("signed webhooks to platforms", () => {
  it("every audit event of a platform's milestone goes to the outbox, without personal data", async () => {
    const p = await platform({ webhook: "https://hooks.acme.test/milestone" });
    const id = await seedMilestone({ state: "FUNDED", platform_id: p.id });
    await audit(db(), { milestoneId: id, actor: "system", event: "review:passed", fromState: "IN_REVIEW", toState: "PASSED", detail: { shareBps: 9500, headSha: "abc1234", reasons: ["private words"], email: "freelancer@example.com" } });
    const { rows } = await db().query<{ event: string; payload: { type: string; to: string; facts: Record<string, unknown> } }>("select event, payload from outbound_events where milestone_id = $1 and event = 'review:passed'", [id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.payload.to, "PASSED");
    assert.deepEqual(rows[0]!.payload.facts, { shareBps: 9500, headSha: "abc1234" });
    assert.ok(!JSON.stringify(rows[0]!.payload).includes("example.com"));
  });

  it("nothing is queued for milestones without a listening platform", async () => {
    const quiet = await platform();
    const a = await seedMilestone({ state: "FUNDED", platform_id: quiet.id });
    const b = await seedMilestone({ state: "FUNDED" });
    await audit(db(), { milestoneId: a, actor: "system", event: "x" });
    await audit(db(), { milestoneId: b, actor: "system", event: "x" });
    assert.equal(Number((await db().query("select count(*) as n from outbound_events")).rows[0].n), 0);
  });

  it("delivers with an HMAC signature the platform can check, once", async () => {
    const p = await platform({ webhook: "https://hooks.acme.test/milestone" });
    const id = await seedMilestone({ state: "FUNDED", platform_id: p.id });
    await db().query("delete from outbound_events");
    await audit(db(), { milestoneId: id, actor: "paypal", event: "hold:captured", paypalId: "CAP1" });
    const got: { headers: Headers; body: string }[] = [];
    const ok: typeof fetch = async (_u, init) => {
      got.push({ headers: new Headers(init!.headers), body: String(init!.body) });
      return new Response("ok", { status: 200 });
    };
    assert.deepEqual(await deliverDue(ok), { delivered: 1, failed: 0 });
    assert.deepEqual(await deliverDue(ok), { delivered: 0, failed: 0 });
    const sig = got[0]!.headers.get("milestone-signature")!;
    const t = Number(/t=(\d+)/.exec(sig)![1]);
    assert.equal(/v1=([0-9a-f]+)/.exec(sig)![1], createHmac("sha256", "mwhsec_test").update(`${t}.${got[0]!.body}`).digest("hex"));
    assert.equal(sig, signPayload("mwhsec_test", got[0]!.body, t));
    assert.equal(got[0]!.headers.get("milestone-event"), "hold:captured");
    assert.equal(JSON.parse(got[0]!.body).paypalId, "CAP1");
  });

  it("retries a failing endpoint with backoff, and gives up after the last try", async () => {
    const p = await platform({ webhook: "https://hooks.acme.test/milestone" });
    const id = await seedMilestone({ state: "FUNDED", platform_id: p.id });
    await db().query("delete from outbound_events");
    await audit(db(), { milestoneId: id, actor: "system", event: "x" });
    const down: typeof fetch = async () => new Response("no", { status: 503 });
    assert.deepEqual(await deliverDue(down), { delivered: 0, failed: 1 });
    const r1 = (await db().query("select attempts, next_at > now() as later, last_status from outbound_events")).rows[0];
    assert.deepEqual(r1, { attempts: 1, later: true, last_status: 503 });
    assert.deepEqual(await deliverDue(down), { delivered: 0, failed: 0 }); // not due yet
    await db().query("update outbound_events set attempts = $1, next_at = now()", [MAX_ATTEMPTS - 1]);
    await deliverDue(down);
    assert.equal((await db().query("select given_up_at is not null as gave_up from outbound_events")).rows[0].gave_up, true);
    assert.deepEqual([1, 2, 3, 10, 20].map(backoffMinutes), [1, 2, 4, 360, 360]);
  });

  it("only accepts https URLs that don't point at this server's network", () => {
    assert.equal(webhookUrlProblem("https://hooks.acme.test/x"), undefined);
    assert.match(webhookUrlProblem("http://hooks.acme.test/x")!, /https/);
    for (const u of ["https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://db.internal/x"]) assert.ok(webhookUrlProblem(u), u);
  });

  it("the platform sets its URL (secret shown once) and hooks with its API key", async () => {
    const p = await platform();
    const req = (body?: unknown) => new Request("http://localhost/api/platform", { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${p.key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const set = await (await platformPost(req({ webhookUrl: "https://hooks.acme.test/m", hooks: { maxAmountCents: 50_000 } }))).json();
    assert.match(set.webhookSecret, /^mwhsec_/);
    const read = await (await platformGet(req())).json();
    assert.equal(read.webhookUrl, "https://hooks.acme.test/m");
    assert.deepEqual(read.hooks, { maxAmountCents: 50_000 });
    assert.equal(read.webhookSecret, undefined);
    assert.equal((await platformPost(req({ webhookUrl: "https://10.1.2.3/m" }))).status, 400);
    assert.equal((await platformPost(req({ hooks: { fundOnMyBehalf: true } }))).status, 400);
    assert.equal((await platformGet(new Request("http://localhost/api/platform"))).status, 401);
  });
});

describe("policy hooks (they can only block)", () => {
  const m = { amount_cents: 30_000, repo: "acme/web", freelancer_email: "dev@contractors.example" };

  it("check the amount and repository before funding, and the worker's email domain before funding and settling", () => {
    assert.equal(hookProblem(m, {}, "beforeFund"), undefined);
    assert.match(hookProblem(m, { maxAmountCents: 20_000 }, "beforeFund")!, /over its limit of \$200\.00/);
    assert.match(hookProblem(m, { allowedRepos: ["acme/api"] }, "beforeFund")!, /acme\/web isn't on its list/);
    assert.equal(hookProblem(m, { allowedRepos: ["ACME/web"] }, "beforeFund"), undefined);
    assert.match(hookProblem(m, { workerEmailDomains: ["acme.example"] }, "beforeSettle")!, /allowlist/);
    assert.equal(hookProblem(m, { maxAmountCents: 20_000 }, "beforeSettle"), undefined);
  });

  it("block funding before any PayPal call, and a release before the capture", async () => {
    const p = await platform({ hooks: { maxAmountCents: 20_000, workerEmailDomains: ["acme.example"] } });
    const stub = stubFetch(() => jsonResponse(500, {}));
    const a = await seedMilestone({ state: "AGREED", platform_id: p.id });
    await assert.rejects(fundWithTestCard(a, depsWith(stub)), /Acme Market's policy blocks this: the amount is over its limit/);
    const b = await seedMilestone({ state: "PASSED", platform_id: p.id, paypal_order_id: "O1", paypal_authorization_id: "A1", authorized_cents: 30_000 });
    await assert.rejects(releaseFunds(b, depsWith(stub)), /allowlist/);
    assert.equal(stub.calls.length, 0);
    assert.equal((await getMilestone(b)).state, "PASSED");
  });
});

describe("Idempotency-Key on our POSTs", () => {
  const post = (body: unknown, key?: string) =>
    create(new Request("http://localhost/api/milestones", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) }));
  const body = { title: "Logo", amount: "50.00", freelancerEmail: "w@example.com" };

  it("a retry with the same key returns the first response and opens nothing new", async () => {
    const first = await post(body, "k-1");
    const again = await post(body, "k-1");
    assert.equal(first.status, 201);
    assert.equal(again.status, 201);
    assert.equal(again.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(await again.json(), await first.json());
    assert.equal(Number((await db().query("select count(*) as n from milestones")).rows[0].n), 1);
  });

  it("the same key with another body is refused; no key acts every time", async () => {
    await post(body, "k-2");
    assert.equal((await post({ ...body, amount: "60.00" }, "k-2")).status, 422);
    await post(body);
    await post(body);
    assert.equal(Number((await db().query("select count(*) as n from milestones")).rows[0].n), 3);
  });

  it("a key left in progress by a request the server never finished is retried after 5 minutes, not refused", async () => {
    await post(body, "k-4");
    // Simulate a restart mid-request: the key is still "in progress" and the first try left no answer.
    await db().query("update idempotency_keys set status = null, response = null where key = 'k-4'");
    assert.equal((await post(body, "k-4")).status, 409);
    await db().query("update idempotency_keys set created_at = now() - interval '6 minutes' where key = 'k-4'");
    assert.equal((await post(body, "k-4")).status, 201);
  });

  it("a refused request (400) is the answer for its key too", async () => {
    assert.equal((await post({ title: "" }, "k-3")).status, 400);
    const again = await post({ title: "" }, "k-3");
    assert.equal(again.status, 400);
    assert.equal(again.headers.get("idempotent-replayed"), "true");
  });
});

describe("OpenAPI", () => {
  it("is 3.1, lists every action the route has, and describes the signed webhook", () => {
    assert.equal(openapi.openapi, "3.1.0");
    const actionParam = openapi.paths["/api/milestones/{id}/{action}"].post.parameters.find((x) => x.name === "action") as { schema: { enum: string[] } };
    assert.deepEqual([...actionParam.schema.enum].sort(), Object.keys(ACTION_ROLES).sort());
    assert.ok(openapi.webhooks.milestoneEvent.post.parameters.some((x) => x.name === "Milestone-Signature"));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(openapi)));
  });
});
