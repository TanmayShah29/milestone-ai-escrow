import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey, isoBase64URL } from "@simplewebauthn/server/helpers";
import { db, type Queryable } from "@/lib/db";
import { InvariantViolation } from "@/lib/errors";
import type { Milestone } from "@/lib/milestones/repo";
import { canonical, importVerifyKey, termsStatement, toB64url, verifySig, type Role, type TermSignature } from "@/lib/proof/verify";

// Signing the terms with a key. A person signs with a passkey (WebAuthn: the challenge is the SHA-256 of a
// statement naming the milestone, the side, the fingerprint and the worker's GitHub account); an AI agent
// signs the same statement with its own ES256 key. Optional: a link alone can still sign, as before. Each
// signature is stored with what it signed, so anyone can check it (src/lib/proof/verify.ts).

export type Site = { rpId: string; origin: string };

const CHALLENGE_TTL_MS = 5 * 60_000;
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** The site a passkey is bound to: this app's own host (APP_URL), or localhost for development. */
export function siteFor(req: Request): Site {
  const origin = req.headers.get("origin") ?? "";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new InvariantViolation("Passkeys need the request's origin. Sign from the Milestone page.");
  }
  const appHost = process.env.APP_URL ? new URL(process.env.APP_URL).hostname : undefined;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.hostname !== appHost && !local) throw new InvariantViolation(`Passkeys only work on ${appHost ?? "this app's own address"}.`);
  return { rpId: url.hostname, origin: url.origin };
}

function assertSignable(m: Milestone, hash?: string) {
  if (m.state !== "DRAFT") throw new InvariantViolation("terms are already agreed");
  if (!m.criteria_hash) throw new InvariantViolation("there are no terms to sign yet");
  if (hash !== undefined && hash !== m.criteria_hash) throw new InvariantViolation("the terms changed since you loaded them; review and sign again");
}

async function saveChallenge(m: Milestone, role: Role, purpose: "register" | "sign", challenge: string, statement: string | null) {
  await db().query(
    `insert into signing_challenges (milestone_id, role, purpose, challenge, statement, expires_at) values ($1, $2, $3, $4, $5, $6)
     on conflict (milestone_id, role, purpose) do update set challenge = excluded.challenge, statement = excluded.statement, expires_at = excluded.expires_at`,
    [m.id, role, purpose, challenge, statement, new Date(Date.now() + CHALLENGE_TTL_MS)],
  );
}

async function takeChallenge(m: Milestone, role: Role, purpose: "register" | "sign"): Promise<{ challenge: string; statement: string | null }> {
  const { rows } = await db().query<{ challenge: string; statement: string | null; expires_at: Date }>(
    "delete from signing_challenges where milestone_id = $1 and role = $2 and purpose = $3 returning challenge, statement, expires_at",
    [m.id, role, purpose],
  );
  const c = rows[0];
  if (!c || c.expires_at.getTime() < Date.now()) throw new InvariantViolation("That passkey request expired. Try signing again.");
  return c;
}

type KeyRow = { credential_id: string; public_jwk: JsonWebKey; cose_key: string | null; counter: string; transports: string[] | null };

async function passkeysOf(m: Milestone, role: Role): Promise<KeyRow[]> {
  const { rows } = await db().query<KeyRow>("select credential_id, public_jwk, cose_key, counter, transports from party_keys where milestone_id = $1 and role = $2 and kind = 'passkey' order by id", [m.id, role]);
  return rows;
}

export function validLogin(login: string | undefined): string | null {
  const l = login?.trim().replace(/^@/, "");
  if (!l) return null;
  if (!GITHUB_LOGIN.test(l)) throw new InvariantViolation("That doesn't look like a GitHub username.");
  return l;
}

/**
 * The next passkey step for this side: register a passkey (first time on this milestone), or sign the
 * current terms with one. The sign challenge is the SHA-256 of the terms statement.
 */
export async function passkeyOptions(m: Milestone, role: Role, site: Site, githubLogin?: string) {
  assertSignable(m);
  const keys = await passkeysOf(m, role);
  if (!keys.length) {
    const options = await generateRegistrationOptions({
      rpName: "Milestone",
      rpID: site.rpId,
      userName: `${role === "client" ? "Client" : "Worker"} · ${m.title}`.slice(0, 64),
      userID: createHash("sha256").update(`${m.id}:${role}`).digest(),
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      supportedAlgorithmIDs: [-7], // ES256 only: the published record is checked with WebCrypto P-256
    });
    await saveChallenge(m, role, "register", options.challenge, null);
    return { mode: "register" as const, options };
  }
  const login = role === "worker" ? validLogin(githubLogin) : null;
  const statement = termsStatement(m.id, role, m.criteria_hash!, login, randomBytes(16).toString("hex"));
  const challenge = createHash("sha256").update(statement).digest();
  const options = await generateAuthenticationOptions({
    rpID: site.rpId,
    challenge,
    userVerification: "preferred",
    allowCredentials: keys.map((k) => ({ id: k.credential_id, ...(k.transports ? { transports: k.transports as AuthenticatorTransport[] } : {}) })),
  });
  await saveChallenge(m, role, "sign", options.challenge, statement);
  return { mode: "sign" as const, options, statement };
}

export function coseToJwk(coseKey: Uint8Array): JsonWebKey {
  const k = decodeCredentialPublicKey(coseKey as Uint8Array<ArrayBuffer>) as unknown as Map<number, unknown>;
  if (k.get(cose.COSEKEYS.kty) !== cose.COSEKTY.EC2 || k.get(cose.COSEKEYS.alg) !== cose.COSEALG.ES256 || k.get(cose.COSEKEYS.crv) !== cose.COSECRV.P256) {
    throw new InvariantViolation("This passkey doesn't use ES256 (P-256). Try a different device or browser.");
  }
  return { kty: "EC", crv: "P-256", x: toB64url(k.get(cose.COSEKEYS.x) as Uint8Array), y: toB64url(k.get(cose.COSEKEYS.y) as Uint8Array) };
}

export async function passkeyRegister(m: Milestone, role: Role, site: Site, response: RegistrationResponseJSON): Promise<void> {
  assertSignable(m);
  const { challenge } = await takeChallenge(m, role, "register");
  const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: site.origin, expectedRPID: site.rpId, requireUserVerification: false }).catch((err: Error) => {
    throw new InvariantViolation(`The passkey couldn't be registered: ${err.message}`);
  });
  if (!v.verified || !v.registrationInfo) throw new InvariantViolation("The passkey couldn't be registered.");
  const c = v.registrationInfo.credential;
  await db().query(
    `insert into party_keys (milestone_id, role, kind, credential_id, public_jwk, cose_key, counter, transports) values ($1, $2, 'passkey', $3, $4, $5, $6, $7)
     on conflict (milestone_id, role, credential_id) do nothing`,
    [m.id, role, c.id, JSON.stringify(coseToJwk(c.publicKey)), isoBase64URL.fromBuffer(c.publicKey), c.counter, c.transports ?? null],
  );
}

/** A signature that has been checked and is ready to store with the terms it signed. */
export type CheckedSignature = Omit<TermSignature, "createdAt" | "role" | "termsHash"> & { githubLogin: string | null };

export async function checkPasskeySignature(m: Milestone, role: Role, site: Site, hash: string, response: AuthenticationResponseJSON): Promise<CheckedSignature> {
  assertSignable(m, hash);
  const { challenge, statement } = await takeChallenge(m, role, "sign");
  if (!statement || !statement.includes(`|${hash}|`)) throw new InvariantViolation("That passkey request was for other terms. Try signing again.");
  const key = (await passkeysOf(m, role)).find((k) => k.credential_id === response.id);
  if (!key?.cose_key) throw new InvariantViolation("That passkey isn't registered for this side of the milestone.");
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: site.origin,
    expectedRPID: site.rpId,
    credential: { id: key.credential_id, publicKey: isoBase64URL.toBuffer(key.cose_key), counter: Number(key.counter) },
    requireUserVerification: false,
  }).catch((err: Error) => {
    throw new InvariantViolation(`The passkey signature didn't check out: ${err.message}`);
  });
  if (!v.verified) throw new InvariantViolation("The passkey signature didn't check out.");
  await db().query("update party_keys set counter = $4 where milestone_id = $1 and role = $2 and credential_id = $3", [m.id, role, key.credential_id, v.authenticationInfo.newCounter]);
  const login = statement.split("|")[4]!;
  return {
    kind: "passkey",
    credentialId: key.credential_id,
    statement,
    rpId: site.rpId,
    authenticatorData: response.response.authenticatorData,
    clientDataJSON: response.response.clientDataJSON,
    signature: response.response.signature,
    publicJwk: key.public_jwk,
    githubLogin: login === "-" ? null : login,
  };
}

/** RFC 7638 thumbprint: an agent key's stable id. */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  return toB64url(createHash("sha256").update(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}

export async function checkAgentSignature(m: Milestone, role: Role, hash: string, input: { jwk?: unknown; signature?: unknown; githubLogin?: string }): Promise<CheckedSignature> {
  assertSignable(m, hash);
  const jwk = input.jwk as JsonWebKey | undefined;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || typeof input.signature !== "string") {
    throw new InvariantViolation("An agent signature needs an ES256 public key (JWK, P-256) and a signature.");
  }
  const publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const login = role === "worker" ? validLogin(input.githubLogin) : null;
  const statement = termsStatement(m.id, role, hash, login, "-");
  const key = await importVerifyKey(publicJwk).catch(() => {
    throw new InvariantViolation("That public key can't be loaded.");
  });
  if (!(await verifySig(key, statement, input.signature))) throw new InvariantViolation(`The agent signature doesn't match. Sign exactly: ${statement}`);
  const credentialId = await jwkThumbprint(publicJwk);
  await db().query(
    `insert into party_keys (milestone_id, role, kind, credential_id, public_jwk) values ($1, $2, 'agent', $3, $4) on conflict (milestone_id, role, credential_id) do nothing`,
    [m.id, role, credentialId, JSON.stringify(publicJwk)],
  );
  return { kind: "agent", credentialId, statement, rpId: null, authenticatorData: null, clientDataJSON: null, signature: input.signature, publicJwk, githubLogin: login };
}

export async function storeSignature(q: Queryable, m: Milestone, role: Role, hash: string, s: CheckedSignature): Promise<void> {
  await q.query(
    `insert into term_signatures (milestone_id, role, terms_hash, kind, credential_id, statement, rp_id, authenticator_data, client_data_json, signature)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [m.id, role, hash, s.kind, s.credentialId, s.statement, s.rpId, s.authenticatorData, s.clientDataJSON, s.signature],
  );
}

/** Every key signature on this milestone's terms, as published with its proof chain. */
export async function signaturesOf(milestoneId: string): Promise<TermSignature[]> {
  const { rows } = await db().query<{
    role: Role;
    terms_hash: string;
    kind: "passkey" | "agent";
    credential_id: string;
    statement: string;
    rp_id: string | null;
    authenticator_data: string | null;
    client_data_json: string | null;
    signature: string;
    public_jwk: JsonWebKey;
    created_at: Date;
  }>(
    `select s.*, k.public_jwk from term_signatures s join party_keys k on k.milestone_id = s.milestone_id and k.role = s.role and k.credential_id = s.credential_id
      where s.milestone_id = $1 order by s.id`,
    [milestoneId],
  );
  return rows.map((r) => ({
    role: r.role,
    termsHash: r.terms_hash,
    kind: r.kind,
    credentialId: r.credential_id,
    statement: r.statement,
    rpId: r.rp_id,
    authenticatorData: r.authenticator_data,
    clientDataJSON: r.client_data_json,
    signature: r.signature,
    publicJwk: r.public_jwk,
    createdAt: r.created_at.toISOString(),
  }));
}
