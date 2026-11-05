// Checking a proof chain: pure, and the same code runs on the server, in the browser (/proof/<id>) and in
// a standalone script, using only WebCrypto. Nothing here trusts Milestone: given the events and the
// public keys, it recomputes every hash, checks every signature and every link to the event before.

export type ProofKey = { id: string; alg: "ES256"; jwk: JsonWebKey };

/** One event as published: `body` is the exact text that was hashed and signed. */
export type ProofEvent = { seq: number; body: string; hash: string; prev: string | null; keyId: string; sig: string };

/** What a body says. Personal data never appears: the audit detail is committed to by a salted digest. */
export type ProofBody = {
  v: 1;
  milestoneId: string;
  seq: number;
  prev: string | null;
  at: string;
  actor: string;
  event: string;
  from: string | null;
  to: string | null;
  paypalId: string | null;
  /** Non-personal facts copied from the detail so anyone can read them: the terms hash, commit, decision… */
  facts: Record<string, string | number | boolean>;
  detailDigest: string | null;
  /** Signed after the fact for an audit row written before the chain existed (or while signing failed). */
  backfilled?: true;
  auditId: string;
};

export type EventCheck = { seq: number; ok: boolean; problems: string[]; body?: ProofBody };
export type ChainCheck = { ok: boolean; events: EventCheck[]; head: string | null; problems: string[] };

/** JSON with sorted keys and no undefined members: the same value always gives the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const enc = new TextEncoder();

export async function sha256Hex(text: string | Uint8Array): Promise<string> {
  const bytes = typeof text === "string" ? enc.encode(text) : text;
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toB64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** The keys that sign; a published key is only ever the public half. */
export async function importVerifyKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

export async function verifySig(key: CryptoKey, body: string, sig: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(sig) as BufferSource, enc.encode(body));
  } catch {
    return false;
  }
}

/** Checks every event of one milestone's chain, in order. A chain with a gap, a reorder or one edited byte fails. */
export async function verifyChain(milestoneId: string, events: ProofEvent[], keys: ProofKey[]): Promise<ChainCheck> {
  const imported = new Map<string, CryptoKey | null>();
  for (const k of keys) imported.set(k.id, k.alg === "ES256" ? await importVerifyKey(k.jwk).catch(() => null) : null);
  const out: EventCheck[] = [];
  let prev: string | null = null;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]!;
    const problems: string[] = [];
    let body: ProofBody | undefined;
    try {
      body = JSON.parse(e.body) as ProofBody;
      if (canonical(body) !== e.body) problems.push("body is not in canonical form");
    } catch {
      problems.push("body is not JSON");
    }
    if (e.seq !== i + 1) problems.push(`expected event ${i + 1}, found ${e.seq}`);
    if (body) {
      if (body.v !== 1) problems.push(`unknown body version ${String(body.v)}`);
      if (body.milestoneId !== milestoneId) problems.push("belongs to another milestone");
      if (body.seq !== e.seq) problems.push("body's sequence number differs from the event's");
      if (body.prev !== prev) problems.push("does not link to the event before it");
    }
    if (e.prev !== prev) problems.push("published link differs from the chain");
    const hash = await sha256Hex(e.body);
    if (hash !== e.hash) problems.push("hash does not match the body");
    const key = imported.get(e.keyId);
    if (key === undefined) problems.push(`signed with unknown key ${e.keyId}`);
    else if (key === null) problems.push(`key ${e.keyId} could not be loaded`);
    else if (!(await verifySig(key, e.body, e.sig))) problems.push("signature is not valid");
    out.push({ seq: e.seq, ok: problems.length === 0, problems, ...(body ? { body } : {}) });
    prev = hash;
  }
  const problems = out.flatMap((c) => c.problems.map((p) => `event ${c.seq}: ${p}`));
  return { ok: problems.length === 0, events: out, head: prev, problems };
}

// ---------------------------------------------------------------------------------------------
// Signatures on the terms: a passkey (WebAuthn assertion) or an agent's own ES256 key, over a statement
// naming the milestone, the side, the terms fingerprint and (for the worker) the GitHub account.

export type Role = "client" | "worker";

export type TermSignature = {
  role: Role;
  termsHash: string;
  kind: "passkey" | "agent";
  credentialId: string;
  statement: string;
  rpId: string | null;
  authenticatorData: string | null;
  clientDataJSON: string | null;
  signature: string;
  publicJwk: JsonWebKey;
  createdAt: string;
};

/** The exact text a side signs. `nonce` is "-" for an agent key (it signs the statement directly). */
export function termsStatement(milestoneId: string, role: Role, termsHash: string, githubLogin: string | null, nonce: string): string {
  return `milestone-terms:v1|${milestoneId}|${role}|${termsHash}|${githubLogin ?? "-"}|${nonce}`;
}

/** What a statement says, or undefined when it isn't one. */
export function parseStatement(s: string): { milestoneId: string; role: Role; termsHash: string; githubLogin: string | null; nonce: string } | undefined {
  const p = s.split("|");
  if (p.length !== 6 || p[0] !== "milestone-terms:v1" || (p[2] !== "client" && p[2] !== "worker")) return undefined;
  return { milestoneId: p[1]!, role: p[2], termsHash: p[3]!, githubLogin: p[4] === "-" ? null : p[4]!, nonce: p[5]! };
}

/** WebAuthn signs with ASN.1 DER; WebCrypto verifies r || s. */
function derToRaw(der: Uint8Array): Uint8Array | undefined {
  if (der[0] !== 0x30) return undefined;
  let i = 2;
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[i] !== 0x02) return undefined;
    const len = der[i + 1]!;
    let int = der.slice(i + 2, i + 2 + len);
    while (int.length > 32 && int[0] === 0) int = int.slice(1);
    if (int.length > 32) return undefined;
    out.set(int, part * 32 + (32 - int.length));
    i += 2 + len;
  }
  return out;
}

/** Checks one signature on the terms, from the published record alone. */
export async function verifyTermSignature(s: TermSignature, milestoneId: string): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const st = parseStatement(s.statement);
  if (!st) return { ok: false, problems: ["the signed statement is not a terms statement"] };
  if (st.milestoneId !== milestoneId) problems.push("signed for another milestone");
  if (st.role !== s.role) problems.push(`signed as the ${st.role}, recorded as the ${s.role}`);
  if (st.termsHash !== s.termsHash) problems.push("signed different terms");
  let key: CryptoKey;
  try {
    key = await importVerifyKey(s.publicJwk);
  } catch {
    return { ok: false, problems: [...problems, "the public key can't be loaded"] };
  }
  if (s.kind === "agent") {
    if (st.nonce !== "-") problems.push("an agent statement carries no nonce");
    if (!(await verifySig(key, s.statement, s.signature))) problems.push("signature is not valid");
    return { ok: problems.length === 0, problems };
  }
  if (!s.authenticatorData || !s.clientDataJSON || !s.rpId) return { ok: false, problems: [...problems, "the passkey assertion is incomplete"] };
  const clientBytes = fromB64url(s.clientDataJSON);
  let client: { type?: string; challenge?: string; origin?: string };
  try {
    client = JSON.parse(new TextDecoder().decode(clientBytes));
  } catch {
    return { ok: false, problems: [...problems, "client data is not JSON"] };
  }
  if (client.type !== "webauthn.get") problems.push("not a WebAuthn sign-in assertion");
  const expected = toB64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s.statement))));
  if (client.challenge !== expected) problems.push("the passkey signed a different challenge");
  try {
    if (new URL(client.origin ?? "").hostname !== s.rpId) problems.push("signed on another site");
  } catch {
    problems.push("client data has no origin");
  }
  const auth = fromB64url(s.authenticatorData);
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s.rpId)));
  if (auth.length < 37 || rpHash.some((b, i) => auth[i] !== b)) problems.push("the assertion is for another site");
  if (!((auth[32] ?? 0) & 0x01)) problems.push("the user was not present");
  const raw = derToRaw(fromB64url(s.signature));
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientBytes as BufferSource));
  const data = new Uint8Array(auth.length + 32);
  data.set(auth);
  data.set(clientHash, auth.length);
  const good = !!raw && (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw as BufferSource, data as BufferSource).catch(() => false));
  if (!good) problems.push("signature is not valid");
  return { ok: problems.length === 0, problems };
}

/** For a reader holding the audit detail (a client or worker link): does it match the digest in the body? */
export async function detailMatches(detail: unknown, salt: string, digest: string | null): Promise<boolean> {
  if (detail === null || detail === undefined) return digest === null;
  return (await sha256Hex(`${salt}:${canonical(detail)}`)) === digest;
}
