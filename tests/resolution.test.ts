import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { depsWith, jsonResponse, resetDb, sampleTerms, seedMilestone, stubFetch, type Call } from "./helpers";
import { db } from "@/lib/db";
import type { ModelCall } from "@/lib/ai/client";
import { currentPolicy, hashTerms, type Terms } from "@/lib/contract/terms";
import { getMilestone } from "@/lib/milestones/repo";
import { toB64url } from "@/lib/proof/verify";
import { arbitrator, keyIdOf } from "@/lib/resolution/config";
import { awardStatement, courtView, feeApproved, lockOf, matchLock, openLock, payingSide, signAward, tickDesk, type DeskDeps } from "@/lib/resolution/desk";
import { feeHolds } from "@/lib/resolution/fees";
import { tick, type ReviewDeps } from "@/lib/review/run";

const DAY = 86_400_000;
const HOUR = 3_600_000;
let privateKey: CryptoKey;
let wrongKey: CryptoKey;

before(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  wrongKey = ((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  process.env.ARBITRATOR_PUBLIC_JWK = JSON.stringify({ kty, crv, x, y });
  process.env.ARBITRATOR_PAYPAL_EMAIL = "arbitrator@example.com";
});
beforeEach(resetDb);
after(async () => {
  delete process.env.ARBITRATOR_PUBLIC_JWK;
  delete process.env.ARBITRATOR_PAYPAL_EMAIL;
  await db().end();
});

const sign = async (text: string, key = privateKey) => toB64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(text))));

/** A fake PayPal: fee holds by test card or wallet, captures, voids and payouts, all recorded. */
function paypal() {
  const seen: { path: string; body: Record<string, unknown> | undefined }[] = [];
  const stub = stubFetch(({ url, body }: Call) => {
    const json = body ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    seen.push({ path: url.pathname, body: json });
    const p = url.pathname;
    if (p === "/v2/checkout/orders") {
      const unit = (json!.purchase_units as { custom_id: string; amount: { value: string } }[])[0]!;
      const role = unit.custom_id.split(":")[1]!;
      if (json!.payment_source) return jsonResponse(201, { id: `ORD-${role}`, status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: `FEE-${role}`, status: "CREATED", amount: { currency_code: "USD", value: unit.amount.value } }] } }] });
      return jsonResponse(201, { id: `ORD-${role}`, status: "CREATED", links: [{ rel: "approve", href: `https://paypal.test/approve/${role}` }] });
    }
    const auth = /^\/v2\/checkout\/orders\/ORD-(\w+)\/authorize$/.exec(p);
    if (auth) return jsonResponse(201, { id: `ORD-${auth[1]}`, status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: `FEE-${auth[1]}`, status: "CREATED", amount: { currency_code: "USD", value: "5.00" } }] } }] });
    const cap = /^\/v2\/payments\/authorizations\/([\w-]+)\/capture$/.exec(p);
    if (cap) {
      const value = (json!.amount as { value: string }).value;
      return jsonResponse(201, { id: `CAP-${cap[1]}`, status: "COMPLETED", amount: { currency_code: "USD", value } });
    }
    if (/^\/v2\/payments\/authorizations\/[\w-]+\/void$/.test(p)) return jsonResponse(200, { status: "VOIDED" });
    if (p.startsWith("/v1/payments/payouts/")) return jsonResponse(200, { batch_header: { payout_batch_id: p.split("/").pop(), batch_status: "PENDING" }, items: [] });
    if (p === "/v1/payments/payouts") return jsonResponse(201, { batch_header: { payout_batch_id: `BATCH-${seen.length}`, batch_status: "PENDING" } });
    throw new Error(`unexpected ${p}`);
  });
  return { deps: depsWith(stub), seen };
}

const terms = (pinArbitrator = true): Terms => {
  const desk = arbitrator()!;
  return {
    ...sampleTerms,
    emailSalt: "0".repeat(32), // a version 2 contract: the public document commits to the email without showing it
    policy: { platformFeeBps: 500, objectionWindowSeconds: 3600, policyVersion: "policy-2", ...(pinArbitrator ? { arbitrator: { name: desk.name, keyId: desk.keyId, feeCents: desk.feeCents } } : {}) },
  };
};

async function passed(o: { pin?: boolean; state?: string; expiresInMs?: number } = {}) {
  const id = await seedMilestone({
    state: o.state ?? "PASSED",
    repo: "acme/web",
    pr_url: "https://github.com/acme/web/pull/7",
    paypal_order_id: "O1",
    paypal_authorization_id: "A1",
    authorized_cents: 30_000,
    authorization_expires_at: new Date(Date.now() + (o.expiresInMs ?? 20 * DAY)),
    release_after: new Date(Date.now() + HOUR),
  });
  const t = terms(o.pin ?? true);
  const hash = hashTerms(await getMilestone(id), t);
  await db().query("update milestones set criteria = $2, criteria_hash = $3, client_signed_hash = $3, worker_signed_hash = $3 where id = $1", [id, JSON.stringify(t), hash]);
  await db().query("insert into reviews (milestone_id, head_sha, status, verdict, decision, reasons) values ($1, 'abc1234', 'done', $2, 'PASSED', $3)", [id, JSON.stringify({ criteria: [{ id: "C1", kind: "must", source: "test", verdict: "pass", confidence: 1, evidence: ["CI success"], level: "E2" }] }), JSON.stringify(["every must-have criterion passed"])]);
  return { id, hash };
}

async function toArbitration(o: Parameters<typeof passed>[0] = {}) {
  const { id, hash } = await passed(o);
  const pp = paypal();
  const d: DeskDeps = { money: pp.deps };
  await openLock(id, "client", { statement: "The toggle doesn't persist on Safari.", card: true }, d);
  await matchLock(id, "worker", { statement: "It persists; Safari private mode blocks storage by design.", card: true }, d);
  return { id, hash, pp, d };
}

async function award(id: string, share: number, reasons = "C1 holds on every browser except private mode.", d?: DeskDeps, key = privateKey) {
  const l = (await lockOf(id))!;
  const m = await getMilestone(id);
  return signAward(id, { shareBps: share, reasons, signature: await sign(awardStatement(id, m.criteria_hash!, l.pack_hash!, share, reasons), key) }, d);
}

describe("the arbitrator is pinned in the signed terms", () => {
  it("currentPolicy names the configured arbitrator and their fee", () => {
    const a = currentPolicy().arbitrator!;
    assert.equal(a.name, "Milestone Resolution Desk");
    assert.equal(a.keyId, keyIdOf(JSON.parse(process.env.ARBITRATOR_PUBLIC_JWK!)));
    assert.equal(a.feeCents, 500);
  });

  it("terms that name no arbitrator can't be locked, nor a hold about to expire", async () => {
    const a = await passed({ pin: false });
    await assert.rejects(openLock(a.id, "client", { card: true }, { money: paypal().deps }), /name no arbitrator/);
    await resetDb();
    const b = await passed({ expiresInMs: DAY });
    await assert.rejects(openLock(b.id, "client", { card: true }, { money: paypal().deps }), /expires too soon/);
  });
});

describe("locking a decision", () => {
  it("takes effect once the locker's fee hold is authorized, and stops the release", async () => {
    const { id } = await passed();
    const pp = paypal();
    const { milestone } = await openLock(id, "client", { statement: "Not what we agreed.", card: true }, { money: pp.deps });
    assert.equal(milestone.state, "LOCKED");
    const lock = (await lockOf(id))!;
    assert.equal(lock.status, "locked");
    assert.ok(lock.match_by!.getTime() <= Date.now() + 72 * HOUR + 1000);
    assert.deepEqual((await feeHolds(id)).map((f) => [f.role, f.status, f.authorized_cents]), [["client", "authorized", 500]]);
    await db().query("update milestones set release_after = now() - interval '1 minute' where id = $1", [id]);
    assert.equal((await tick(id, { github: {} as ReviewDeps["github"], money: pp.deps })).state, "LOCKED"); // no capture while locked
    assert.ok(!pp.seen.some((s) => s.path === "/v2/payments/authorizations/A1/capture"));
    await assert.rejects(openLock(id, "worker", { card: true }, { money: pp.deps }), /one lock per milestone/);
  });

  it("with PayPal checkout: an approve link first, LOCKED after the return", async () => {
    const { id } = await passed();
    const pp = paypal();
    const { milestone, fee } = await openLock(id, "worker", {}, { money: pp.deps });
    assert.equal(milestone.state, "PASSED");
    assert.equal(fee.approve_url, "https://paypal.test/approve/worker");
    assert.equal((await feeApproved(id, "worker", "ORD-worker", { money: pp.deps })).state, "LOCKED");
    await assert.rejects(feeApproved(id, "worker", "ORD-other", { money: pp.deps }), /isn't this side's/);
  });

  it("unmatched in 72 hours: the earlier decision stands, the locker's fee is voided, and the release goes ahead", async () => {
    const { id } = await passed();
    const pp = paypal();
    await openLock(id, "client", { card: true }, { money: pp.deps });
    await db().query("update locks set match_by = now() - interval '1 minute' where milestone_id = $1", [id]);
    const m = await tick(id, { github: {} as ReviewDeps["github"], money: pp.deps });
    assert.equal((await lockOf(id))!.status, "stood");
    assert.ok(pp.seen.some((s) => s.path === "/v2/payments/authorizations/FEE-client/void"));
    assert.equal(m.state, "RELEASED"); // PASSED with release_after = now, released in the same tick
    assert.deepEqual(pp.seen.find((s) => s.path === "/v2/payments/authorizations/A1/capture")!.body!.amount, { currency_code: "USD", value: "300.00" });
  });
});

describe("arbitration", () => {
  it("matching freezes the evidence pack into the proof chain", async () => {
    const { id } = await toArbitration();
    const m = await getMilestone(id);
    assert.equal(m.state, "ARBITRATION");
    const lock = (await lockOf(id))!;
    assert.match(lock.pack_hash!, /^[0-9a-f]{64}$/);
    assert.equal(lock.pack!.statements.client, "The toggle doesn't persist on Safari.");
    assert.equal(lock.pack!.reviews[0]!.id, "review:1");
    assert.ok((lock.pack!.contract as { criteria: unknown[] }).criteria.length > 0);
    const { rows } = await db().query<{ body: unknown }>("select body from proof_events where milestone_id = $1 order by seq", [id]);
    const matched = rows.map((r) => (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as { event: string; facts: Record<string, unknown> }).find((b) => b.event === "lock:matched")!;
    assert.equal(matched.facts.hash, lock.pack_hash);
  });

  it("the AI drafts an award once, as a draft, keeping only evidence ids that exist", async () => {
    const { id, d } = await toArbitration();
    let calls = 0;
    const aiCall: ModelCall = async () => {
      calls++;
      return JSON.stringify({ share_bps: 7000, reasons: [{ text: "C1 passed CI; the Safari point is private mode only.", evidence: ["C1", "statement:worker", "made-up:9"] }], summary: "Mostly delivered." });
    };
    await tickDesk(id, { ...d, aiCall });
    await tickDesk(id, { ...d, aiCall });
    const lock = (await lockOf(id))!;
    assert.equal(calls, 1);
    assert.equal(lock.draft!.shareBps, 7000);
    assert.deepEqual(lock.draft!.reasons[0]!.evidence, ["C1", "statement:worker"]);
    assert.equal((await getMilestone(id)).state, "ARBITRATION"); // a draft settles nothing
  });

  it("a signed award settles: the hold is captured at its share, the paying side's fee goes to the arbitrator, the other is voided", async () => {
    const { id, pp, d } = await toArbitration();
    const m = await award(id, 6000, undefined, d);
    assert.equal(m.state, "PASSED");
    assert.equal(m.share_bps, 6000);
    const lock = (await lockOf(id))!;
    assert.equal(lock.status, "closed");
    assert.equal(payingSide(6000), "client");
    assert.ok(pp.seen.some((s) => s.path === "/v2/payments/authorizations/FEE-client/capture"));
    assert.ok(pp.seen.some((s) => s.path === "/v2/payments/authorizations/FEE-worker/void"));
    const payout = pp.seen.find((s) => s.path === "/v1/payments/payouts")!.body as { items: { receiver: string; amount: { value: string } }[] };
    assert.equal(payout.items[0]!.receiver, "arbitrator@example.com");
    assert.equal(payout.items[0]!.amount.value, "4.25"); // $5 − PayPal's 3.49% + 49¢ ($0.66) − the 2% payout fee ($0.09)
    const released = await tick(id, { github: {} as ReviewDeps["github"], money: pp.deps });
    assert.equal(released.state, "RELEASED");
    assert.deepEqual(pp.seen.find((s) => s.path === "/v2/payments/authorizations/A1/capture")!.body!.amount, { currency_code: "USD", value: "180.00" });
  });

  it("an award of 0% voids the work's hold, and the worker pays the arbitrator", async () => {
    const { id, pp, d } = await toArbitration();
    const m = await award(id, 0, "Nothing in the PR does what C1 says.", d);
    assert.equal(m.state, "CANCELLED");
    assert.ok(pp.seen.some((s) => s.path === "/v2/payments/authorizations/A1/void"));
    assert.ok(pp.seen.some((s) => s.path === "/v2/payments/authorizations/FEE-worker/capture"));
    assert.ok(pp.seen.some((s) => s.path === "/v2/payments/authorizations/FEE-client/void"));
  });

  it("refuses an award signed with another key, or with a share other than the one signed", async () => {
    const { id, d } = await toArbitration();
    await assert.rejects(award(id, 6000, undefined, d, wrongKey), /doesn't match the arbitrator's key/);
    const l = (await lockOf(id))!;
    const m = await getMilestone(id);
    const sig = await sign(awardStatement(id, m.criteria_hash!, l.pack_hash!, 6000, "fair"));
    await assert.rejects(signAward(id, { shareBps: 9000, reasons: "fair", signature: sig }, d), /doesn't match/);
    await assert.rejects(signAward(id, { shareBps: 6000, reasons: "fair, edited", signature: sig }, d), /doesn't match/);
    assert.equal((await getMilestone(id)).state, "ARBITRATION");
  });

  it("an arbitrator silent past the deadline: the earlier decision stands and both fees are voided", async () => {
    const { id, pp, d } = await toArbitration({ state: "HUMAN_CHECK" });
    await db().query("update locks set rule_by = now() - interval '1 minute', draft = '{}' where milestone_id = $1", [id]);
    const m = await tickDesk(id, d);
    assert.equal(m.state, "HUMAN_CHECK");
    assert.equal((await lockOf(id))!.status, "stood");
    assert.ok(pp.seen.some((s) => s.path === "/v2/payments/authorizations/FEE-client/void"));
    assert.ok(pp.seen.some((s) => s.path === "/v2/payments/authorizations/FEE-worker/void"));
    await assert.rejects(award(id, 6000, undefined, d), /isn't waiting for an award/);
  });

  it("the court view shows the case without anything only the server needs", async () => {
    const { id } = await toArbitration();
    const v = await courtView(id);
    assert.equal(v.lock!.status, "arbitration");
    assert.equal(v.lock!.arbitrator!.name, "Milestone Resolution Desk");
    assert.deepEqual(v.fees.map((f) => f.status), ["authorized", "authorized"]);
    assert.ok(!JSON.stringify(v).includes("freelancer@example.com"));
  });
});
