import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { jsonResponse, resetDb, seedMilestone, stubFetch } from "./helpers";
import { hashToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { clientIp, hit, HOUR, ipKey, waitText } from "@/lib/ratelimit";
import { getMilestone } from "@/lib/milestones/repo";
import { POST as create } from "@/app/api/milestones/route";
import { POST as action } from "@/app/api/milestones/[id]/[action]/route";
import { GET as status } from "@/app/api/status/route";

// Production hardening: per-IP and per-milestone limits, a public status that leaks nothing, dev actions off.

const realFetch = globalThis.fetch;
const paypalStub = stubFetch(() => jsonResponse(201, { id: "ORDER1", status: "CREATED", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] }));

before(() => {
  globalThis.fetch = paypalStub.fetch; // the routes use the default PayPal client
});
beforeEach(async () => {
  await resetDb();
  await db().query("truncate rate_events, platforms cascade");
  paypalStub.calls.length = 0;
  delete process.env.ALLOW_DEV_ACTIONS;
});
after(async () => {
  globalThis.fetch = realFetch;
  await db().end();
});

const createReq = (ip: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/milestones", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
    body: JSON.stringify({ title: "Dark mode", amount: "300.00", freelancerEmail: "worker@example.com" }),
  });

const actionReq = (id: string, name: string, token: string, ip: string, body: unknown = {}) =>
  action(
    new Request(`http://localhost/api/milestones/${id}/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-forwarded-for": `${ip}, 10.0.0.1` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, action: name }) },
  );

/** A milestone the given client token opens. */
async function milestoneFor(token: string, fields: Record<string, unknown> = {}) {
  const id = await seedMilestone(fields);
  await db().query("update milestones set client_token_hash = $2 where id = $1", [id, hashToken(token)]);
  return id;
}

async function platformKey(): Promise<{ id: string; key: string }> {
  const key = "msk_test_platform_key";
  const { rows } = await db().query<{ id: string }>("insert into platforms (name, api_key_hash) values ('Test platform', $1) returning id", [hashToken(key)]);
  return { id: rows[0]!.id, key };
}

describe("rate limit helpers", () => {
  it("reads the client IP from Cloudflare first, then the first x-forwarded-for hop", () => {
    const req = (h: Record<string, string>) => new Request("http://localhost/", { headers: h });
    assert.equal(clientIp(req({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" })), "1.1.1.1");
    assert.equal(clientIp(req({ "x-forwarded-for": "2.2.2.2, 3.3.3.3" })), "2.2.2.2");
    assert.equal(clientIp(req({})), "unknown");
  });

  it("stores a hash, never the raw IP", async () => {
    const req = new Request("http://localhost/", { headers: { "cf-connecting-ip": "203.0.113.9" } });
    assert.ok(!ipKey(req, "create").includes("203.0.113.9"));
    await hit([{ key: ipKey(req, "create"), limit: 1, windowMs: HOUR }]);
    const { rows } = await db().query<{ key: string }>("select key from rate_events");
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.key, /^create:ip:[0-9a-f]{64}$/);
  });

  it("records nothing when any rule is over its limit", async () => {
    await hit([{ key: "a", limit: 1, windowMs: HOUR }]);
    const v = await hit([{ key: "b", limit: 5, windowMs: HOUR }, { key: "a", limit: 1, windowMs: HOUR }]);
    assert.equal(v.ok, false);
    const { rows } = await db().query("select 1 from rate_events where key = 'b'");
    assert.equal(rows.length, 0);
  });

  it("phrases the wait in minutes or hours", () => {
    assert.equal(waitText(30_000), "about 1 minute");
    assert.equal(waitText(12 * 60_000), "about 12 minutes");
    assert.equal(waitText(5 * HOUR), "about 5 hours");
  });
});

describe("POST /api/milestones", () => {
  it("allows 10 creates per IP per hour; the 11th gets a 429 with human copy", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await create(createReq("198.51.100.1"))).status, 201);
    const res = await create(createReq("198.51.100.1"));
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    assert.match(((await res.json()) as { error: string }).error, /^You've opened 10 milestones this hour\. Try again in about \d+ minutes?\.$/);
    // Another visitor is unaffected.
    assert.equal((await create(createReq("198.51.100.2"))).status, 201);
  });

  it("platform API-key callers are not limited per IP", async () => {
    const { key } = await platformKey();
    for (let i = 0; i < 12; i++) assert.equal((await create(createReq("198.51.100.3", { authorization: `Bearer ${key}` }))).status, 201);
  });
});

describe("draft-terms limits", () => {
  // Milestones past DRAFT make draftTerms refuse (409) before any AI call, so no model is called here.
  it("caps one milestone at 3 drafts a day, whoever asks", async () => {
    const id = await milestoneFor("ct_one");
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) assert.equal((await actionReq(id, "draft-terms", "ct_one", ip)).status, 409);
    const res = await actionReq(id, "draft-terms", "ct_one", "192.0.2.4");
    assert.equal(res.status, 429);
    assert.match(((await res.json()) as { error: string }).error, /^These terms have been drafted 3 times today\./);
  });

  it("caps one IP at 5 drafts an hour across milestones", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await milestoneFor(`ct_ip_${i}`);
      assert.equal((await actionReq(id, "draft-terms", `ct_ip_${i}`, "192.0.2.10")).status, 409);
    }
    const id = await milestoneFor("ct_ip_5");
    const res = await actionReq(id, "draft-terms", "ct_ip_5", "192.0.2.10");
    assert.equal(res.status, 429);
    assert.match(((await res.json()) as { error: string }).error, /^You've drafted terms 5 times this hour\. Try again in about \d+ minutes?\.$/);
  });

  it("a platform key skips the per-IP limit but not the per-milestone one", async () => {
    const { id: platformId, key } = await platformKey();
    for (let i = 0; i < 6; i++) {
      const id = await seedMilestone({ platform_id: platformId });
      assert.equal((await actionReq(id, "draft-terms", key, "192.0.2.20")).status, 409);
    }
    const id = await seedMilestone({ platform_id: platformId });
    for (let i = 0; i < 3; i++) assert.equal((await actionReq(id, "draft-terms", key, "192.0.2.20")).status, 409);
    assert.equal((await actionReq(id, "draft-terms", key, "192.0.2.20")).status, 429);
  });

  it("a caller without the milestone's link can't spend its draft budget", async () => {
    const id = await milestoneFor("ct_owner");
    for (let i = 0; i < 4; i++) assert.equal((await actionReq(id, "draft-terms", "ct_stranger", "192.0.2.30")).status, 403);
    const { rows } = await db().query("select 1 from rate_events");
    assert.equal(rows.length, 0);
  });
});

describe("GET /api/status", () => {
  it("returns only models, last model, busy and the budget; no error text or failure times", async () => {
    await db().query("insert into ai_calls (purpose, model, ok) values ('draft_terms', 'test/primary:free', true)");
    for (let i = 0; i < 3; i++) {
      await db().query("insert into ai_calls (purpose, model, ok, status, error) values ('draft_terms', 'test/primary:free', false, 429, 'upstream secret detail sk-or-xyz')");
    }
    const res = await status();
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["aiCallsToday", "aiDailyCap", "busy", "lastModel", "models"]);
    assert.equal(body.lastModel, "test/primary:free");
    assert.equal(body.busy, true);
    assert.equal(body.aiCallsToday, 4);
    assert.equal(body.aiDailyCap, 40);
    assert.ok(!JSON.stringify(body).includes("secret"));
  });

  it("is not busy when the latest call succeeded", async () => {
    await db().query("insert into ai_calls (purpose, model, ok, error) values ('x', 'm', false, 'e'), ('x', 'm', false, 'e'), ('x', 'm', true, null)");
    assert.equal(((await (await status()).json()) as { busy: boolean }).busy, false);
  });
});

describe("dev actions are off unless ALLOW_DEV_ACTIONS=1", () => {
  it("dev-pass returns 404 and leaves the milestone alone", async () => {
    process.env.ALLOW_DEV_ACTIONS = "0";
    const id = await milestoneFor("ct_dev", { state: "IN_REVIEW" });
    const res = await actionReq(id, "dev-pass", "ct_dev", "192.0.2.40");
    assert.equal(res.status, 404);
    assert.equal((await getMilestone(id)).state, "IN_REVIEW");
  });

  it("ignores the PayPal mock body param when the flag is off", async () => {
    const id = await milestoneFor("ct_mock");
    const res = await actionReq(id, "fund", "ct_mock", "192.0.2.41", { mock: "INSTRUMENT_DECLINED" });
    assert.equal(res.status, 200);
    const createOrder = paypalStub.calls.find((c) => c.url.pathname === "/v2/checkout/orders" && c.request.method === "POST");
    assert.ok(createOrder, "createOrder was sent");
    assert.equal(createOrder.request.headers.get("paypal-mock-response"), null);
  });

  it("passes the mock through when the flag is on (so the test above can see it)", async () => {
    process.env.ALLOW_DEV_ACTIONS = "1";
    const id = await milestoneFor("ct_mock_on");
    await actionReq(id, "fund", "ct_mock_on", "192.0.2.42", { mock: "INSTRUMENT_DECLINED" });
    const createOrder = paypalStub.calls.find((c) => c.url.pathname === "/v2/checkout/orders" && c.request.method === "POST");
    assert.match(createOrder?.request.headers.get("paypal-mock-response") ?? "", /INSTRUMENT_DECLINED/);
  });
});
