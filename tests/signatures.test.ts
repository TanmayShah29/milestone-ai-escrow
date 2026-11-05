import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign, type KeyObject } from "node:crypto";
import { after, beforeEach, describe, it } from "node:test";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { resetDb, seedMilestone, stubFetch, depsWith } from "./helpers";
import { db } from "@/lib/db";
import { hashTerms, signTerms, type Terms } from "@/lib/contract/terms";
import { passkeyOptions, passkeyRegister, signaturesOf, type Site } from "@/lib/contract/signatures";
import { InvariantViolation } from "@/lib/errors";
import { getMilestone } from "@/lib/milestones/repo";
import { chainOf } from "@/lib/proof/chain";
import { termsStatement, toB64url, verifyTermSignature, type ProofBody } from "@/lib/proof/verify";
import { submitDeliverable, type ReviewDeps } from "@/lib/review/run";
import type { GitHub, PullRequest } from "@/lib/review/github";

beforeEach(resetDb);
after(() => db().end());

const SITE: Site = { rpId: "localhost", origin: "http://localhost:3000" };
const TERMS: Terms = {
  criteria: [
    { id: "C1", text: "slugify lowercases and joins words with hyphens", kind: "must", check: "review" },
    { id: "C2", text: "README documents slugify with one example", kind: "nice", check: "review" },
  ],
};

async function draftWithTerms(fields: Record<string, unknown> = {}) {
  const id = await seedMilestone({ state: "DRAFT", repo: "acme/web", ...fields });
  const m = await getMilestone(id);
  const hash = hashTerms(m, TERMS);
  await db().query("update milestones set criteria = $2, criteria_hash = $3 where id = $1", [id, JSON.stringify(TERMS), hash]);
  return { id, hash };
}

/** A software authenticator: what a phone or laptop does when it makes and uses a passkey (none attestation). */
function softAuthenticator(rpId = SITE.rpId, origin = SITE.origin) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = randomBytes(16);
  const rpHash = createHash("sha256").update(rpId).digest();
  let counter = 0;
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: isoBase64URL.fromBuffer(credId),
    register(challenge: string) {
      const coseKey = new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, Buffer.from(isoCBOR.encode(coseKey))]);
      const attestation = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
      return {
        id: isoBase64URL.fromBuffer(credId),
        rawId: isoBase64URL.fromBuffer(credId),
        type: "public-key" as const,
        response: { clientDataJSON: isoBase64URL.fromBuffer(clientData("webauthn.create", challenge)), attestationObject: isoBase64URL.fromBuffer(attestation), transports: ["internal" as const] },
        clientExtensionResults: {},
      };
    },
    assert(challenge: string, key: KeyObject = privateKey) {
      counter += 1;
      const counterBytes = Buffer.alloc(4);
      counterBytes.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), counterBytes]);
      const cd = clientData("webauthn.get", challenge);
      const sig = nodeSign("sha256", Buffer.concat([authData, createHash("sha256").update(cd).digest()]), { key, dsaEncoding: "der" });
      return {
        id: isoBase64URL.fromBuffer(credId),
        rawId: isoBase64URL.fromBuffer(credId),
        type: "public-key" as const,
        response: { clientDataJSON: isoBase64URL.fromBuffer(cd), authenticatorData: isoBase64URL.fromBuffer(authData), signature: isoBase64URL.fromBuffer(sig) },
        clientExtensionResults: {},
      };
    },
  };
}

async function agentKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const full = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = { kty: full.kty, crv: full.crv, x: full.x, y: full.y };
  const signFor = async (statement: string) => toB64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(statement)));
  return { jwk, signFor };
}

const signedEvent = async (id: string, role: string) =>
  (await chainOf(id)).map((e) => JSON.parse(e.body) as ProofBody).find((b) => b.event === `terms:signed:${role}`)!;

describe("signing the terms with a passkey", () => {
  it("registers, signs the terms statement, and leaves a record anyone can check", async () => {
    const { id, hash } = await draftWithTerms();
    const device = softAuthenticator();
    const reg = await passkeyOptions(await getMilestone(id), "client", SITE);
    assert.equal(reg.mode, "register");
    await passkeyRegister(await getMilestone(id), "client", SITE, device.register(reg.options.challenge));

    const o = await passkeyOptions(await getMilestone(id), "client", SITE);
    assert.equal(o.mode, "sign");
    // The challenge is the SHA-256 of the statement, so the signature commits to the fingerprint itself.
    assert.equal(o.options.challenge, toB64url(createHash("sha256").update(o.statement!).digest()));
    assert.ok(o.statement!.includes(`|client|${hash}|`));
    const m = await signTerms(id, "client", hash, { passkey: { site: SITE, response: device.assert(o.options.challenge) } });
    assert.equal(m.client_signed_hash, hash);

    const [sig] = await signaturesOf(id);
    assert.equal(sig!.kind, "passkey");
    assert.deepEqual(await verifyTermSignature(sig!, id), { ok: true, problems: [] });
    assert.deepEqual((await signedEvent(id, "client")).facts, { hash, method: "passkey", credentialId: device.id });

    // The published record can't be moved to other terms, another milestone, or another key.
    assert.equal((await verifyTermSignature({ ...sig!, termsHash: "0".repeat(64) }, id)).ok, false);
    assert.equal((await verifyTermSignature(sig!, "00000000-0000-0000-0000-000000000000")).ok, false);
    const other = await agentKey();
    assert.equal((await verifyTermSignature({ ...sig!, publicJwk: other.jwk }, id)).ok, false);
  });

  it("refuses an assertion from another key, a replayed challenge, or other terms", async () => {
    const { id, hash } = await draftWithTerms();
    const device = softAuthenticator();
    const reg = await passkeyOptions(await getMilestone(id), "client", SITE);
    await passkeyRegister(await getMilestone(id), "client", SITE, device.register(reg.options.challenge));

    let o = await passkeyOptions(await getMilestone(id), "client", SITE);
    const thief = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    await assert.rejects(signTerms(id, "client", hash, { passkey: { site: SITE, response: device.assert(o.options.challenge, thief) } }), InvariantViolation);
    // The challenge was used up by that attempt.
    await assert.rejects(signTerms(id, "client", hash, { passkey: { site: SITE, response: device.assert(o.options.challenge) } }), /expired/);

    o = await passkeyOptions(await getMilestone(id), "client", SITE);
    await assert.rejects(signTerms(id, "client", "f".repeat(64), { passkey: { site: SITE, response: device.assert(o.options.challenge) } }), /terms changed/);
    assert.equal((await getMilestone(id)).client_signed_hash, null);
    assert.equal((await signaturesOf(id)).length, 0);
  });
});

describe("signing the terms with an agent key", () => {
  it("checks the signature, records the GitHub account, and binds later pull requests to it", async () => {
    const { id, hash } = await draftWithTerms();
    const agent = await agentKey();
    const statement = termsStatement(id, "worker", hash, "octo-agent", "-");
    await assert.rejects(
      signTerms(id, "worker", hash, { agent: { jwk: agent.jwk, signature: await agent.signFor(statement) }, githubLogin: "someone-else" }),
      /doesn't match/,
    );
    const m = await signTerms(id, "worker", hash, { agent: { jwk: agent.jwk, signature: await agent.signFor(statement) }, githubLogin: "octo-agent" });
    assert.equal(m.worker_github_login, "octo-agent");
    const [sig] = await signaturesOf(id);
    assert.equal(sig!.kind, "agent");
    assert.ok((await verifyTermSignature(sig!, id)).ok);
    assert.equal((await signedEvent(id, "worker")).facts.githubLogin, "octo-agent");

    // Fund it (skip the money flow) and submit pull requests from two accounts.
    await db().query("update milestones set state = 'FUNDED', client_signed_hash = $2 where id = $1", [id, hash]);
    const pr = (author: string): PullRequest => ({ number: 7, title: "Add slugify", body: `Milestone-Terms: ${hash}`, state: "open", merged: false, headSha: "abc1234", baseRepo: "acme/web", htmlUrl: "https://github.com/acme/web/pull/7", author });
    const deps = (author: string): ReviewDeps => ({ github: { pr: async () => pr(author) } as unknown as GitHub, money: depsWith(stubFetch(() => new Response("{}"))) });
    await assert.rejects(submitDeliverable(id, { prUrl: "https://github.com/acme/web/pull/7" }, deps("mallory")), /opened by @mallory/);
    const submitted = await submitDeliverable(id, { prUrl: "https://github.com/acme/web/pull/7" }, deps("Octo-Agent"));
    assert.equal(submitted.state, "SUBMITTED");
  });

  it("a link-only signature still works, and records no key", async () => {
    const { id, hash } = await draftWithTerms();
    await signTerms(id, "client", hash);
    await signTerms(id, "worker", hash, { githubLogin: "@octocat" });
    const m = await getMilestone(id);
    assert.equal(m.state, "AGREED");
    assert.equal(m.worker_github_login, "octocat");
    assert.equal((await signaturesOf(id)).length, 0);
    assert.deepEqual((await signedEvent(id, "client")).facts, { hash, method: "link" });
    const other = await draftWithTerms();
    await assert.rejects(signTerms(other.id, "worker", other.hash, { githubLogin: "not a login!" }), /GitHub username/);
  });
});
