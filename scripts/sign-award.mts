// The arbitrator's tool. The private key stays on the arbitrator's machine; the server only ever holds the
// public key (ARBITRATOR_PUBLIC_JWK) and checks signatures with it (src/lib/resolution/desk.ts).
//
//   npx tsx scripts/sign-award.mts keygen <private-key-file>     make a key; prints the public JWK for the server
//   npx tsx scripts/sign-award.mts read <milestone-id>            read a case: the pack hash, statements, the AI draft
//   npx tsx scripts/sign-award.mts sign <milestone-id> <share-bps> <reasons-file>
//
// ARBITRATOR_KEY_FILE names the private key file for read and sign; APP_URL the server (default: the live app).
import { readFileSync, writeFileSync } from "node:fs";
import { awardStatement, courtReadStatement } from "../src/lib/resolution/desk.ts";
import { toB64url } from "../src/lib/proof/verify.ts";

const API = process.env.APP_URL ?? "https://milestone-ai-escrow.onrender.com";
const [cmd, a, b, c] = process.argv.slice(2);

async function privateKey(): Promise<CryptoKey> {
  const file = process.env.ARBITRATOR_KEY_FILE;
  if (!file) throw new Error("set ARBITRATOR_KEY_FILE to the private key file from `keygen`");
  return crypto.subtle.importKey("jwk", JSON.parse(readFileSync(file, "utf8")), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function sign(text: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await privateKey(), new TextEncoder().encode(text));
  return toB64url(new Uint8Array(sig));
}

async function readCase(id: string) {
  const minute = Math.floor(Date.now() / 60_000);
  const res = await fetch(`${API}/api/milestones/${id}/court`, { headers: { "x-arbitrator-signature": `${minute}.${await sign(courtReadStatement(id, minute))}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

if (cmd === "keygen" && a) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  writeFileSync(a, JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)), { mode: 0o600 });
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  console.log(`Private key written to ${a} (keep it off the server).\nSet this on the server:\nARBITRATOR_PUBLIC_JWK=${JSON.stringify({ kty, crv, x, y })}`);
} else if (cmd === "read" && a) {
  const v = await readCase(a);
  console.log(JSON.stringify({ state: v.state, status: v.lock?.status, lockedBy: v.lock?.lockedBy, ruleBy: v.lock?.ruleBy, packHash: v.lock?.packHash, statements: v.lock?.statements, draft: v.lock?.draft, draftError: v.lock?.draftError, fees: v.fees }, null, 2));
} else if (cmd === "sign" && a && b && c) {
  const share = Number(b);
  const reasons = readFileSync(c, "utf8").trim();
  const v = await readCase(a);
  if (!v.lock?.packHash || !v.lock.pack?.termsHash) throw new Error("this case has no frozen evidence pack yet");
  const statement = awardStatement(a, v.lock.pack.termsHash, v.lock.packHash, share, reasons);
  const res = await fetch(`${API}/api/milestones/${a}/court`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shareBps: share, reasons, signature: await sign(statement) }) });
  const out = await res.json();
  console.log(res.ok ? `Award signed: ${share / 100}%. Milestone is now ${out.state}.` : `Refused (${res.status}): ${out.error}`);
} else {
  console.log("usage: keygen <file> | read <milestone-id> | sign <milestone-id> <share-bps> <reasons-file>");
}
