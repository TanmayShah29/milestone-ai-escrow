import { createHash } from "node:crypto";
import { canonical, toB64url } from "@/lib/proof/verify";

// The arbitrator this server offers (V2_PLAN §3.G): named in the signed terms (policy.arbitrator) when it is
// configured at signing, so neither side can be handed a different one later. Their award is checked
// against this public key; the private key never reaches the server (scripts/sign-award.mts).
//   ARBITRATOR_NAME           shown to both sides; default "Milestone Resolution Desk"
//   ARBITRATOR_PUBLIC_JWK     the ES256 (P-256) public key, as JSON
//   ARBITRATOR_PAYPAL_EMAIL   where the losing side's fee is paid out
//   RESOLUTION_FEE_CENTS      each side's fee hold; default 500 ($5)

export type Arbitrator = { name: string; keyId: string; publicJwk: JsonWebKey; payoutEmail: string; feeCents: number };

/** RFC 7638 thumbprint of a P-256 key: the arbitrator's key id in the terms (signatures.ts uses the same). */
export function keyIdOf(jwk: JsonWebKey): string {
  return toB64url(createHash("sha256").update(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}

/** The configured arbitrator, or undefined when this server offers none (then nothing can be locked). */
export function arbitrator(): Arbitrator | undefined {
  const raw = process.env.ARBITRATOR_PUBLIC_JWK;
  const payoutEmail = process.env.ARBITRATOR_PAYPAL_EMAIL?.trim();
  if (!raw || !payoutEmail) return undefined;
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return undefined;
  const publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const fee = Number(process.env.RESOLUTION_FEE_CENTS ?? "500");
  return {
    name: (process.env.ARBITRATOR_NAME ?? "Milestone Resolution Desk").slice(0, 80),
    keyId: keyIdOf(publicJwk),
    publicJwk,
    payoutEmail,
    feeCents: Number.isInteger(fee) && fee >= 100 && fee <= 10_000 ? fee : 500,
  };
}
