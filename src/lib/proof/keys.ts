import { db, tx } from "@/lib/db";
import { sha256Hex, toB64url, type ProofKey } from "./verify";

// The proof chain's signing key (ES256). PROOF_SIGNING_KEY, when set, is a base64 PKCS#8 P-256 private key
// and never touches the database. Without it the app generates one key on first use and keeps it in
// proof_keys: weaker (the database holds it), and labelled so in /.well-known/milestone-proof-keys.json.

export type SigningKey = { id: string; key: CryptoKey; jwk: JsonWebKey; source: "env" | "generated" };

const g = globalThis as unknown as { __proofKey?: Promise<SigningKey> };

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;

function publicJwk(jwk: JsonWebKey): JsonWebKey {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

async function keyId(key: CryptoKey): Promise<string> {
  // A CryptoKey's public SPKI is only exportable from a public key: rebuild it from the JWK.
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const pub = await crypto.subtle.importKey("jwk", publicJwk(jwk), ALG, true, ["verify"]);
  return (await sha256Hex(new Uint8Array(await crypto.subtle.exportKey("spki", pub)))).slice(0, 16);
}

async function fromPkcs8(b64: string): Promise<{ key: CryptoKey; jwk: JsonWebKey }> {
  const der = Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, ALG, true, ["sign"]);
  return { key, jwk: publicJwk(await crypto.subtle.exportKey("jwk", key)) };
}

async function load(): Promise<SigningKey> {
  const env = process.env.PROOF_SIGNING_KEY;
  if (env) {
    const { key, jwk } = await fromPkcs8(env);
    const id = await keyId(key);
    await db().query("insert into proof_keys (id, public_jwk) values ($1, $2) on conflict (id) do nothing", [id, JSON.stringify(jwk)]);
    return { id, key, jwk, source: "env" };
  }
  return tx(async (c) => {
    // One generated key per database, even when two processes start at once.
    await c.query("select pg_advisory_xact_lock(hashtext('milestone:proof-key'))");
    const { rows } = await c.query<{ private_pkcs8: string }>("select private_pkcs8 from proof_keys where private_pkcs8 is not null order by created_at limit 1");
    if (rows[0]) {
      const { key, jwk } = await fromPkcs8(rows[0].private_pkcs8);
      return { id: await keyId(key), key, jwk, source: "generated" as const };
    }
    const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
    const pkcs8 = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))));
    const jwk = publicJwk(await crypto.subtle.exportKey("jwk", pair.publicKey));
    const id = await keyId(pair.privateKey);
    await c.query("insert into proof_keys (id, public_jwk, private_pkcs8) values ($1, $2, $3)", [id, JSON.stringify(jwk), pkcs8]);
    return { id, key: pair.privateKey, jwk, source: "generated" as const };
  });
}

export function signingKey(): Promise<SigningKey> {
  g.__proofKey ??= load().catch((err) => {
    g.__proofKey = undefined; // try again next time rather than caching the failure
    throw err;
  });
  return g.__proofKey;
}

export async function sign(key: SigningKey, body: string): Promise<string> {
  return toB64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.key, new TextEncoder().encode(body)));
}

/** Every key that ever signed, public halves only, as published at /.well-known/milestone-proof-keys.json. */
export async function publishedKeys(): Promise<(ProofKey & { source: "env" | "generated"; createdAt: string })[]> {
  const { rows } = await db().query<{ id: string; alg: "ES256"; public_jwk: JsonWebKey; generated: boolean; created_at: Date }>(
    "select id, alg, public_jwk, private_pkcs8 is not null as generated, created_at from proof_keys order by created_at",
  );
  return rows.map((r) => ({ id: r.id, alg: r.alg, jwk: r.public_jwk, source: r.generated ? "generated" : "env", createdAt: r.created_at.toISOString() }));
}

/** Tests only: forget the cached key (a truncated proof_keys table would otherwise leave it dangling). */
export function resetSigningKeyCache(): void {
  g.__proofKey = undefined;
}
