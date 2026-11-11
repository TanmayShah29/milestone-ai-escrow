import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { hashToken, sameHash, newToken, Unauthorized } from "@/lib/auth";
import { coseToJwk, type Site } from "@/lib/contract/signatures";
import { db } from "@/lib/db";
import { InvariantViolation } from "@/lib/errors";
import { MIN_AMOUNT_CENTS } from "@/lib/money/amounts";
import { canonical } from "@/lib/proof/verify";

// Spending mandates (V2_PLAN §3.H; money rule 1 as amended Nov 6: "the AI never moves money; code may fund
// only within a mandate a human signed"). A person sets the limits, vaults a card, and signs the exact
// limits with a passkey. The agent then holds the mandate's token: it may choose what bounties to post,
// and checkLimits (fixed code) decides whether the signed mandate allows each one. Capture, void, payout and
// refund are on no agent's tool list, mandate or not.

export type Mandate = {
  id: string;
  name: string;
  max_per_bounty_cents: number;
  total_cents: number;
  max_open_bounties: number;
  allowed_repos: string[];
  allowed_verifiers: string[];
  expires_at: Date;
  status: "draft" | "active" | "revoked";
  vault_status: "none" | "pending" | "done";
  vault_attempt: number;
  vault_id: string | null;
  card_last4: string | null;
  document: MandateDocument | null;
  document_hash: string | null;
  credential_id: string | null;
  public_jwk: JsonWebKey | null;
  cose_key: string | null;
  counter: string;
  transports: string[] | null;
  signature: { statement: string; authenticatorData: string; clientDataJSON: string; signature: string } | null;
  challenge: string | null;
  challenge_purpose: string | null;
  challenge_statement: string | null;
  challenge_expires_at: Date | null;
  signed_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

/** What the person signs: the limits, and which card (its last digits and a digest of the vault id). */
export type MandateDocument = {
  v: 1;
  type: "milestone.intent-mandate";
  mandateId: string;
  name: string;
  maxPerBountyCents: number;
  totalCents: number;
  maxOpenBounties: number;
  allowedRepos: string[];
  allowedVerifiers: string[];
  expiresAt: string;
  card: { last4: string | null; vaultIdDigest: string };
};

const MAX_DAYS = 28; // a mandate outlives no hold it funds by much; PayPal holds last 29 days
const CHALLENGE_TTL_MS = 5 * 60_000;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export async function getMandate(id: string): Promise<Mandate> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new InvariantViolation("No such mandate.");
  const { rows } = await db().query<Mandate>("select * from mandates where id = $1", [id]);
  if (!rows[0]) throw new InvariantViolation("No such mandate.");
  return rows[0];
}

export type MandateInput = { name?: unknown; maxPerBounty?: unknown; total?: unknown; maxOpenBounties?: unknown; allowedRepos?: unknown; days?: unknown };

const dollars = (v: unknown, what: string) => {
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n) || n <= 0) throw new InvariantViolation(`Enter ${what} in dollars, like 50.00.`);
  return n;
};

/** A draft mandate and its owner's link token, returned once. Nothing can be funded until it is signed. */
export async function createMandate(input: MandateInput): Promise<{ mandate: Mandate; ownerToken: string }> {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) : "";
  if (!name) throw new InvariantViolation("Name the agent this mandate is for.");
  const perBounty = dollars(input.maxPerBounty, "the most per bounty");
  const total = dollars(input.total, "the total budget");
  if (perBounty < MIN_AMOUNT_CENTS) throw new InvariantViolation("A bounty can't be smaller than $10.00, so the most per bounty must be at least that.");
  if (perBounty > 1_000_000 || total > 5_000_000) throw new InvariantViolation("Keep it to $10,000 per bounty and $50,000 in total.");
  if (total < perBounty) throw new InvariantViolation("The total budget must cover at least one bounty at the most per bounty.");
  const open = Number(input.maxOpenBounties ?? 3);
  if (!Number.isInteger(open) || open < 1 || open > 50) throw new InvariantViolation("Allow between 1 and 50 open bounties.");
  const repos = (Array.isArray(input.allowedRepos) ? input.allowedRepos : String(input.allowedRepos ?? "").split(/[\s,]+/)).map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  if (!repos.length || repos.length > 20 || !repos.every((r) => REPO.test(r))) throw new InvariantViolation("List the repositories bounties may be posted in, as owner/name (1 to 20).");
  const days = Number(input.days ?? 14);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new InvariantViolation(`A mandate lasts between 1 and ${MAX_DAYS} days.`);
  const ownerToken = newToken("mmo");
  const { rows } = await db().query<Mandate>(
    `insert into mandates (name, owner_token_hash, max_per_bounty_cents, total_cents, max_open_bounties, allowed_repos, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) returning *`,
    [name, hashToken(ownerToken), perBounty, total, open, [...new Set(repos)].sort(), days],
  );
  return { mandate: rows[0]!, ownerToken };
}

export function mandateDocument(m: Mandate): MandateDocument {
  if (m.vault_status !== "done" || !m.vault_id) throw new InvariantViolation("Save the card before signing the mandate.");
  return {
    v: 1,
    type: "milestone.intent-mandate",
    mandateId: m.id,
    name: m.name,
    maxPerBountyCents: m.max_per_bounty_cents,
    totalCents: m.total_cents,
    maxOpenBounties: m.max_open_bounties,
    allowedRepos: m.allowed_repos,
    allowedVerifiers: m.allowed_verifiers,
    expiresAt: new Date(m.expires_at).toISOString(),
    card: { last4: m.card_last4, vaultIdDigest: createHash("sha256").update(m.vault_id).digest("hex") },
  };
}

export const documentHash = (d: MandateDocument) => createHash("sha256").update(canonical(d)).digest("hex");
/** What the passkey signs (its challenge is this string's SHA-256), as the terms statement is. */
export const mandateStatement = (id: string, hash: string, nonce: string) => `milestone-mandate:v1|${id}|${hash}|${nonce}`;

/** The owner's link, or 401/403. */
export async function mandateForOwner(id: string, token: string | undefined): Promise<Mandate> {
  if (!token) throw new Unauthorized("Open this mandate with its owner link.");
  const m = await getMandate(id);
  if (!sameHash(hashToken(token), (m as unknown as { owner_token_hash: string }).owner_token_hash)) throw new Unauthorized("This link doesn't manage that mandate.");
  return m;
}

/** The mandate behind an agent's token (`mmd_…`), or undefined if the request carries none. */
export async function mandateFromAgent(token: string | undefined): Promise<Mandate | undefined> {
  if (!token?.startsWith("mmd_")) return undefined;
  const { rows } = await db().query<Mandate>("select * from mandates where agent_token_hash = $1", [hashToken(token)]);
  if (!rows[0]) throw new Unauthorized("That mandate key isn't valid.");
  return rows[0];
}

async function setChallenge(id: string, purpose: "register" | "sign", challenge: string, statement: string | null) {
  await db().query("update mandates set challenge = $2, challenge_purpose = $3, challenge_statement = $4, challenge_expires_at = $5, updated_at = now() where id = $1", [id, challenge, purpose, statement, new Date(Date.now() + CHALLENGE_TTL_MS)]);
}

async function takeChallenge(m: Mandate, purpose: "register" | "sign"): Promise<{ challenge: string; statement: string | null }> {
  await db().query("update mandates set challenge = null, challenge_purpose = null, challenge_statement = null where id = $1", [m.id]);
  if (!m.challenge || m.challenge_purpose !== purpose || !m.challenge_expires_at || m.challenge_expires_at.getTime() < Date.now()) throw new InvariantViolation("That passkey request expired. Try again.");
  return { challenge: m.challenge, statement: m.challenge_statement };
}

/** The next passkey step: register one (first time), or sign the mandate's exact limits with it. */
export async function mandatePasskeyOptions(m: Mandate, site: Site) {
  if (m.status !== "draft") throw new InvariantViolation("This mandate is already signed.");
  if (!m.credential_id) {
    const options = await generateRegistrationOptions({
      rpName: "Milestone",
      rpID: site.rpId,
      userName: `Mandate · ${m.name}`.slice(0, 64),
      userID: createHash("sha256").update(`mandate:${m.id}`).digest(),
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      supportedAlgorithmIDs: [-7],
    });
    await setChallenge(m.id, "register", options.challenge, null);
    return { mode: "register" as const, options };
  }
  const doc = mandateDocument(m);
  const statement = mandateStatement(m.id, documentHash(doc), randomBytes(16).toString("hex"));
  const options = await generateAuthenticationOptions({
    rpID: site.rpId,
    challenge: createHash("sha256").update(statement).digest(),
    userVerification: "preferred",
    allowCredentials: [{ id: m.credential_id, ...(m.transports ? { transports: m.transports as AuthenticatorTransport[] } : {}) }],
  });
  await setChallenge(m.id, "sign", options.challenge, statement);
  return { mode: "sign" as const, options, statement, document: doc };
}

export async function mandatePasskeyRegister(m: Mandate, site: Site, response: RegistrationResponseJSON): Promise<void> {
  if (m.status !== "draft" || m.credential_id) throw new InvariantViolation("This mandate already has its passkey.");
  const { challenge } = await takeChallenge(m, "register");
  const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: site.origin, expectedRPID: site.rpId, requireUserVerification: false }).catch((err: Error) => {
    throw new InvariantViolation(`The passkey couldn't be registered: ${err.message}`);
  });
  if (!v.verified || !v.registrationInfo) throw new InvariantViolation("The passkey couldn't be registered.");
  const c = v.registrationInfo.credential;
  await db().query("update mandates set credential_id = $2, public_jwk = $3, cose_key = $4, counter = $5, transports = $6, updated_at = now() where id = $1", [
    m.id,
    c.id,
    JSON.stringify(coseToJwk(c.publicKey)),
    isoBase64URL.fromBuffer(c.publicKey),
    c.counter,
    c.transports ?? null,
  ]);
}

/** Check the passkey's signature over the mandate's limits, activate it, and issue the agent's token once. */
export async function signMandate(m: Mandate, site: Site, response: AuthenticationResponseJSON): Promise<{ mandate: Mandate; agentToken: string }> {
  if (m.status !== "draft") throw new InvariantViolation("This mandate is already signed.");
  if (!m.credential_id || !m.cose_key) throw new InvariantViolation("Register the passkey first.");
  const { challenge, statement } = await takeChallenge(m, "sign");
  const doc = mandateDocument(m);
  const hash = documentHash(doc);
  if (!statement?.includes(`|${hash}|`)) throw new InvariantViolation("The mandate changed since the passkey request. Sign again.");
  if (response.id !== m.credential_id) throw new InvariantViolation("That isn't this mandate's passkey.");
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: site.origin,
    expectedRPID: site.rpId,
    credential: { id: m.credential_id, publicKey: isoBase64URL.toBuffer(m.cose_key), counter: Number(m.counter) },
    requireUserVerification: false,
  }).catch((err: Error) => {
    throw new InvariantViolation(`The passkey signature didn't check out: ${err.message}`);
  });
  if (!v.verified) throw new InvariantViolation("The passkey signature didn't check out.");
  const agentToken = newToken("mmd");
  const signature = { statement, authenticatorData: response.response.authenticatorData, clientDataJSON: response.response.clientDataJSON, signature: response.response.signature };
  const { rows } = await db().query<Mandate>(
    `update mandates set status = 'active', document = $2, document_hash = $3, signature = $4, counter = $5, agent_token_hash = $6, signed_at = now(), updated_at = now()
     where id = $1 and status = 'draft' returning *`,
    [m.id, JSON.stringify(doc), hash, JSON.stringify(signature), v.authenticationInfo.newCounter, hashToken(agentToken)],
  );
  if (!rows[0]) throw new InvariantViolation("This mandate was signed already.");
  return { mandate: rows[0], agentToken };
}

export async function revokeMandate(m: Mandate): Promise<Mandate> {
  const { rows } = await db().query<Mandate>("update mandates set status = 'revoked', revoked_at = now(), updated_at = now() where id = $1 returning *", [m.id]);
  return rows[0]!;
}

/** What the mandate has committed: holds not yet ended (open or claimed), plus what was captured. */
export async function spent(mandateId: string): Promise<{ committedCents: number; openBounties: number }> {
  const { rows } = await db().query<{ committed: string | null; open: string }>(
    `select sum(case when paypal_capture_id is not null then coalesce(captured_cents, 0)
                     when state <> 'CANCELLED' then coalesce(authorized_cents, amount_cents) else 0 end) as committed,
            count(*) filter (where state = 'OFFERED') as open
     from milestones where mandate_id = $1`,
    [mandateId],
  );
  return { committedCents: Number(rows[0]?.committed ?? 0), openBounties: Number(rows[0]?.open ?? 0) };
}

/**
 * The fixed rule a bounty must pass before anything is created or funded (paypal-plan.md, CROSS-OPERATION
 * INVARIANTS): an active, unexpired, signed mandate, the amount within its per-bounty limit and what is left
 * of its budget, a repository and verifier it names, and room under its open-bounty limit.
 */
export async function checkLimits(m: Mandate, b: { amountCents: number; repo: string; verifier: string }): Promise<void> {
  if (m.status !== "active" || !m.document || !m.signature) throw new InvariantViolation(m.status === "revoked" ? "This mandate was revoked." : "This mandate isn't signed yet.");
  // The limits come from the document the passkey signed, never from columns a later write could change.
  const d = m.document;
  if (documentHash(d) !== m.document_hash || d.mandateId !== m.id) throw new InvariantViolation("This mandate's signed document doesn't check out, so it funds nothing.");
  if (new Date(d.expiresAt).getTime() <= Date.now()) throw new InvariantViolation("This mandate has expired.");
  if (!Number.isInteger(b.amountCents) || b.amountCents < MIN_AMOUNT_CENTS) throw new InvariantViolation("The smallest bounty is $10.00.");
  if (b.amountCents > d.maxPerBountyCents) throw new InvariantViolation(`The mandate allows at most $${(d.maxPerBountyCents / 100).toFixed(2)} per bounty.`);
  if (!d.allowedRepos.includes(b.repo.toLowerCase())) throw new InvariantViolation(`The mandate doesn't allow bounties in ${b.repo}.`);
  if (!d.allowedVerifiers.includes(b.verifier)) throw new InvariantViolation(`The mandate doesn't allow the ${b.verifier} verifier.`);
  if (!m.vault_id || createHash("sha256").update(m.vault_id).digest("hex") !== d.card.vaultIdDigest) throw new InvariantViolation("The saved card isn't the one the mandate was signed for.");
  const s = await spent(m.id);
  if (s.openBounties >= d.maxOpenBounties) throw new InvariantViolation(`The mandate allows at most ${d.maxOpenBounties} open bounties at once.`);
  if (s.committedCents + b.amountCents > d.totalCents) throw new InvariantViolation(`That would go over the mandate's budget: $${((d.totalCents - s.committedCents) / 100).toFixed(2)} is left.`);
}

/** What anyone may see: the signed document, the passkey's public key and signature (checkable), and use. */
export async function publicMandate(m: Mandate) {
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    document: m.document,
    documentHash: m.document_hash,
    publicJwk: m.public_jwk,
    credentialId: m.credential_id,
    signature: m.signature,
    signedAt: m.signed_at,
    revokedAt: m.revoked_at,
    expiresAt: m.expires_at,
    card: m.vault_status === "done" ? { last4: m.card_last4 } : null,
    ...(await spent(m.id)),
  };
}
