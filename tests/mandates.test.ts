import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { connectionDrop, depsWith, jsonResponse, resetDb, seedMilestone, stubFetch, type Call } from "./helpers";
import { softAuthenticator } from "./webauthn";
import { db } from "@/lib/db";
import { hashToken } from "@/lib/auth";
import { claimBounty, listBounties, postBounty, tickBounty, UNCLAIMED_EMAIL } from "@/lib/bounties/bounty";
import type { Site } from "@/lib/contract/signatures";
import { termsAgreed } from "@/lib/contract/terms";
import { checkLimits, createMandate, getMandate, mandatePasskeyOptions, mandatePasskeyRegister, revokeMandate, signMandate, spent, type Mandate } from "@/lib/mandates/mandate";
import { vaultCard } from "@/lib/mandates/vault";
import { getMilestone } from "@/lib/milestones/repo";
import { publishedKeys } from "@/lib/proof/keys";
import { canonical, importVerifyKey, termsStatement, toB64url, verifySig } from "@/lib/proof/verify";
import { badgeSvg, clientPassport, workerPassport } from "@/lib/passport";

beforeEach(async () => {
  await resetDb();
  await db().query("truncate mandates cascade");
});
after(() => db().end());

const SITE: Site = { rpId: "localhost", origin: "http://localhost:3000" };

/** A fake PayPal for the vault and vault-funded orders, recording every call. */
function paypal(o: { dropVault?: boolean; refuseVault?: boolean } = {}) {
  const seen: { path: string; method: string; body: Record<string, unknown> | undefined; requestId: string | null }[] = [];
  let order = 0;
  const stub = stubFetch(({ url, request, body }: Call) => {
    const json = body ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    seen.push({ path: url.pathname, method: request.method, body: json, requestId: request.headers.get("paypal-request-id") });
    if (url.pathname === "/v3/vault/setup-tokens") {
      if (o.dropVault) return connectionDrop();
      if (o.refuseVault) return jsonResponse(422, { name: "UNPROCESSABLE_ENTITY", message: "card refused", details: [{ issue: "CARD_REFUSED", description: "The card was refused." }] });
      return jsonResponse(201, { id: "ST-1", status: "APPROVED" });
    }
    if (url.pathname === "/v3/vault/payment-tokens") return jsonResponse(201, { id: "VAULT-1", payment_source: { card: { last_digits: "1881", brand: "VISA" } } });
    if (url.pathname === "/v2/checkout/orders") {
      order++;
      const value = (json!.purchase_units as { amount: { value: string } }[])[0]!.amount.value;
      return jsonResponse(201, { id: `ORD-${order}`, status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: `AUTH-${order}`, status: "CREATED", amount: { currency_code: "USD", value }, expiration_time: new Date(Date.now() + 29 * 86_400_000).toISOString() }] } }] });
    }
    if (/\/v2\/payments\/authorizations\/[\w-]+\/void$/.test(url.pathname)) return jsonResponse(200, { status: "VOIDED" });
    throw new Error(`unexpected ${url.pathname}`);
  });
  return { deps: depsWith(stub), seen };
}

const limits = { name: "Procurement agent", maxPerBounty: "100.00", total: "250.00", maxOpenBounties: 2, allowedRepos: ["acme/web"], days: 14 };

/** A mandate taken all the way to active: card saved, passkey registered, limits signed. */
async function activeMandate(pp = paypal()) {
  const { mandate } = await createMandate(limits);
  await vaultCard(mandate.id, pp.deps);
  const device = softAuthenticator();
  const reg = await mandatePasskeyOptions(await getMandate(mandate.id), SITE);
  await mandatePasskeyRegister(await getMandate(mandate.id), SITE, device.register(reg.options.challenge));
  const o = await mandatePasskeyOptions(await getMandate(mandate.id), SITE);
  assert.equal(o.mode, "sign");
  const { mandate: active, agentToken } = await signMandate(await getMandate(mandate.id), SITE, device.assert(o.options.challenge));
  return { mandate: active, agentToken, device, pp };
}

const terms = {
  criteria: [{ id: "C1", text: "src/greet.ts exports greet(name) returning 'Hello, <name>!'", kind: "must", check: "test", test: { path: "acceptance/c1.test.ts", code: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.ts';\n\ntest('greets', () => {\n  assert.equal(greet('Ada'), 'Hello, Ada!');\n});" } }],
  testCommand: "node --test 'acceptance/*.test.ts'",
};
const bounty = (over: Record<string, unknown> = {}) => ({ title: "Add greet()", amount: "40.00", repo: "acme/web", ...terms, ...over });

describe("spending mandates", () => {
  it("refuse limits that make no sense", async () => {
    await assert.rejects(createMandate({ ...limits, total: "50.00" }), /cover at least one bounty/);
    await assert.rejects(createMandate({ ...limits, maxPerBounty: "5.00" }), /at least that/);
    await assert.rejects(createMandate({ ...limits, allowedRepos: ["not a repo"] }), /owner\/name/);
    await assert.rejects(createMandate({ ...limits, days: 60 }), /between 1 and 28 days/);
  });

  it("save the sandbox card once, with derived request ids, and keep a dropped call's claim for a replay", async () => {
    const dropped = paypal({ dropVault: true });
    const { mandate } = await createMandate(limits);
    await assert.rejects(vaultCard(mandate.id, dropped.deps), /didn't confirm/);
    assert.equal((await getMandate(mandate.id)).vault_status, "pending");
    const ok = paypal();
    const v = await vaultCard(mandate.id, ok.deps);
    assert.deepEqual(v, { vaultId: "VAULT-1", last4: "1881" });
    // The replay reused the dropped call's request id, so PayPal can't vault the card twice.
    assert.equal(ok.seen[0]!.requestId, dropped.seen[0]!.requestId);
    assert.equal(ok.seen[0]!.requestId, `md_${mandate.id}_setup_1`);
    assert.equal(ok.seen[1]!.requestId, `md_${mandate.id}_ptoken_1`);
    assert.deepEqual(ok.seen[1]!.body, { payment_source: { token: { id: "ST-1", type: "SETUP_TOKEN" } } });
    assert.ok(!("customer" in ok.seen[0]!.body!));
    await vaultCard(mandate.id, ok.deps); // done: no more calls
    assert.equal(ok.seen.length, 2);
  });

  it("a refused card releases the claim, and the next try gets fresh request ids", async () => {
    const { mandate } = await createMandate(limits);
    await assert.rejects(vaultCard(mandate.id, paypal({ refuseVault: true }).deps));
    const m = await getMandate(mandate.id);
    assert.deepEqual([m.vault_status, m.vault_attempt], ["none", 2]);
    const ok = paypal();
    await vaultCard(mandate.id, ok.deps);
    assert.equal(ok.seen[0]!.requestId, `md_${mandate.id}_setup_2`);
  });

  it("are signed with a passkey over the exact limits, then issue the agent's key once", async () => {
    const { mandate, agentToken } = await activeMandate();
    assert.equal(mandate.status, "active");
    assert.match(agentToken, /^mmd_/);
    assert.equal((mandate as unknown as { agent_token_hash: string }).agent_token_hash, hashToken(agentToken));
    assert.deepEqual([mandate.document!.maxPerBountyCents, mandate.document!.totalCents, mandate.document!.allowedRepos], [10_000, 25_000, ["acme/web"]]);
    assert.ok(mandate.signature!.statement.includes(`|${mandate.document_hash}|`));
    await assert.rejects(mandatePasskeyOptions(mandate, SITE), /already signed/);
  });

  it("a signature from another passkey doesn't activate it", async () => {
    const { mandate } = await createMandate(limits);
    await vaultCard(mandate.id, paypal().deps);
    const device = softAuthenticator();
    const reg = await mandatePasskeyOptions(await getMandate(mandate.id), SITE);
    await mandatePasskeyRegister(await getMandate(mandate.id), SITE, device.register(reg.options.challenge));
    const o = await mandatePasskeyOptions(await getMandate(mandate.id), SITE);
    const thief = softAuthenticator();
    const forged = { ...thief.assert(o.options.challenge), id: device.id, rawId: device.id };
    await assert.rejects(signMandate(await getMandate(mandate.id), SITE, forged), /didn't check out/);
    assert.equal((await getMandate(mandate.id)).status, "draft");
  });
});

describe("posting a bounty under a mandate", () => {
  it("funds the hold from the saved card as a merchant-initiated charge, and opens it", async () => {
    const { mandate, pp } = await activeMandate();
    const m = await postBounty(mandate, bounty(), pp.deps);
    assert.equal(m.state, "OFFERED");
    assert.equal(m.open_bounty, true);
    assert.equal(m.client_signed_hash, m.criteria_hash);
    const order = pp.seen.find((s) => s.path === "/v2/checkout/orders")!;
    assert.deepEqual((order.body!.payment_source as Record<string, unknown>).card, { vault_id: "VAULT-1", stored_credential: { payment_initiator: "MERCHANT", payment_type: "UNSCHEDULED", usage: "SUBSEQUENT" } });
    assert.ok(!("application_context" in order.body!), "no buyer redirect");
    assert.equal(order.requestId, `ms_${m.id}_create_order_1`);
    // The open bounty's contract commits to no worker yet, so it carries no email at all.
    const listed = (await listBounties())[0]!;
    assert.equal(listed.termsHash, m.criteria_hash);
    assert.ok(JSON.parse(listed.document).openBounty);
    assert.ok(!listed.document.includes(UNCLAIMED_EMAIL));
  });

  it("refuses a bounty outside the signed limits, before any PayPal call", async () => {
    const { mandate, pp } = await activeMandate();
    const before = pp.seen.length;
    await assert.rejects(postBounty(mandate, bounty({ amount: "150.00" }), pp.deps), /at most \$100\.00 per bounty/);
    await assert.rejects(postBounty(mandate, bounty({ repo: "acme/api" }), pp.deps), /doesn't allow bounties in acme\/api/);
    assert.equal(pp.seen.length, before);
    await postBounty(mandate, bounty({ amount: "100.00" }), pp.deps);
    await postBounty(mandate, bounty({ amount: "100.00" }), pp.deps);
    await assert.rejects(postBounty(mandate, bounty({ amount: "10.00" }), pp.deps), /at most 2 open bounties/);
    await db().query("update milestones set state = 'FUNDED' where mandate_id = $1", [mandate.id]); // both claimed
    await assert.rejects(postBounty(mandate, bounty({ amount: "60.00" }), pp.deps), /over the mandate's budget: \$50\.00 is left/);
    assert.deepEqual(await spent(mandate.id), { committedCents: 20_000, openBounties: 0 });
  });

  it("enforces the signed limits, not the columns: a raised limit in the row changes nothing", async () => {
    const { mandate, pp } = await activeMandate();
    await db().query("update mandates set max_per_bounty_cents = 900000, total_cents = 9000000 where id = $1", [mandate.id]);
    await assert.rejects(postBounty(await getMandate(mandate.id), bounty({ amount: "150.00" }), pp.deps), /at most \$100\.00/);
    await db().query("update mandates set document = jsonb_set(document, '{maxPerBountyCents}', '900000') where id = $1", [mandate.id]);
    await assert.rejects(checkLimits(await getMandate(mandate.id), { amountCents: 15_000, repo: "acme/web", verifier: "code_pr" }), /doesn't check out/);
  });

  it("a revoked or expired mandate funds nothing", async () => {
    const { mandate, pp } = await activeMandate();
    await assert.rejects(postBounty(await revokeMandate(mandate), bounty(), pp.deps), /revoked/);
    const b = await activeMandate();
    const expired: Mandate = { ...b.mandate, document: { ...b.mandate.document!, expiresAt: new Date(Date.now() - 1000).toISOString() } };
    await assert.rejects(checkLimits(expired, { amountCents: 4000, repo: "acme/web", verifier: "code_pr" }));
  });
});

describe("claiming a bounty", () => {
  it("the first valid claim signs the terms, names the payout email and takes the hold into the normal flow", async () => {
    const { mandate, pp } = await activeMandate();
    const b = await postBounty(mandate, bounty(), pp.deps);
    await assert.rejects(claimBounty(b.id, { githubLogin: "ada", paypalEmail: "ada@example.com", hash: "f".repeat(64) }), /terms changed/);
    const { milestone, workerToken } = await claimBounty(b.id, { githubLogin: "ada", paypalEmail: "ada@example.com", hash: b.criteria_hash });
    assert.equal(milestone.state, "FUNDED");
    assert.equal(milestone.freelancer_email, "ada@example.com");
    assert.equal(milestone.worker_github_login, "ada");
    assert.equal(milestone.worker_token_hash, hashToken(workerToken));
    assert.ok(termsAgreed(milestone), "both sides now signed the same fingerprint");
    await assert.rejects(claimBounty(b.id, { githubLogin: "grace", paypalEmail: "g@example.com", hash: b.criteria_hash }), /isn't open/);
    const { rows } = await db().query<{ detail: Record<string, unknown> }>("select detail from audit_log where milestone_id = $1 and event = 'bounty:claimed'", [b.id]);
    assert.equal(rows[0]!.detail.githubLogin, "ada");
    assert.ok(!JSON.stringify(rows[0]!.detail).includes("ada@example.com"));
  });

  it("an agent can claim with its own key", async () => {
    const { mandate, pp } = await activeMandate();
    const b = await postBounty(mandate, bounty(), pp.deps);
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const statement = termsStatement(b.id, "worker", b.criteria_hash!, "agent-bot", "-");
    const signature = toB64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(statement))));
    await assert.rejects(claimBounty(b.id, { githubLogin: "other-bot", paypalEmail: "bot@example.com", hash: b.criteria_hash, agent: { jwk: { kty, crv, x, y }, signature } }), /doesn't match/);
    assert.equal((await claimBounty(b.id, { githubLogin: "agent-bot", paypalEmail: "bot@example.com", hash: b.criteria_hash, agent: { jwk: { kty, crv, x, y }, signature } })).milestone.state, "FUNDED");
  });

  it("a claim with no pull request in time lapses back to open, and the worker's link stops working", async () => {
    const { mandate, pp } = await activeMandate();
    const b = await postBounty(mandate, bounty(), pp.deps);
    await claimBounty(b.id, { githubLogin: "ada", paypalEmail: "ada@example.com", hash: b.criteria_hash });
    await db().query("update milestones set claim_expires_at = now() - interval '1 minute' where id = $1", [b.id]);
    const m = await tickBounty(b.id, pp.deps);
    assert.equal(m.state, "OFFERED");
    assert.deepEqual([m.worker_token_hash, m.worker_github_login, m.worker_signed_hash, m.freelancer_email], [null, null, null, UNCLAIMED_EMAIL]);
    assert.equal((await workerPassport("ada")).passport.lapsedClaims, 1);
  });

  it("a bounty nobody claimed by its due date is voided, and the budget comes back", async () => {
    const { mandate, pp } = await activeMandate();
    const b = await postBounty(mandate, bounty(), pp.deps);
    assert.equal((await spent(mandate.id)).committedCents, 4000);
    await db().query("update milestones set due_at = now() - interval '1 minute' where id = $1", [b.id]);
    assert.equal((await tickBounty(b.id, pp.deps)).state, "CANCELLED");
    assert.ok(pp.seen.some((s) => s.path === `/v2/payments/authorizations/${b.paypal_authorization_id}/void`));
    assert.deepEqual(await spent(mandate.id), { committedCents: 0, openBounties: 0 });
  });
});

describe("passports", () => {
  it("a worker's record is signed with the proof key and counts paid work, on time, and the evidence behind it", async () => {
    const id = await seedMilestone({ state: "PAID_OUT", worker_github_login: "ada", due_at: new Date(Date.now() + 86_400_000) });
    await db().query("insert into reviews (milestone_id, head_sha, status, verdict, decision) values ($1, 'abc', 'done', $2, 'PASSED')", [id, JSON.stringify({ criteria: [{ id: "C1", verdict: "pass", level: "E3" }, { id: "C2", verdict: "pass", level: "E1" }] })]);
    const { passport, keyId, signature } = await workerPassport("ADA");
    assert.equal(passport.paid, 1);
    assert.equal(passport.onTimeRate, 1);
    assert.deepEqual(passport.passedEvidence, { E3: 1, E2: 0, E1: 1, none: 0 });
    const key = (await publishedKeys()).find((k) => k.id === keyId)!;
    assert.ok(await verifySig(await importVerifyKey(key.jwk), canonical(passport), signature));
    assert.match(badgeSvg(passport), /1 paid · 100% on time/);
    assert.ok(!JSON.stringify(passport).includes("@"), "no emails in a passport");
  });

  it("a client's record shows what it posted and how often it objected", async () => {
    const { mandate, pp } = await activeMandate();
    const b = await postBounty(mandate, bounty(), pp.deps);
    await db().query("update milestones set contested_at = now() where id = $1", [b.id]);
    await db().query("insert into audit_log (milestone_id, actor, event) values ($1, 'system', 'review:passed')", [b.id]);
    const p = (await clientPassport(mandate.id))!.passport;
    assert.deepEqual([p.bounties, p.objections, p.objectionRate, p.name], [1, 1, 1, "Procurement agent"]);
    assert.equal(await clientPassport("00000000-0000-0000-0000-000000000000"), undefined);
    void getMilestone;
  });
});
