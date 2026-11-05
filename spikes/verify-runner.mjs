// C2 spike: check a milestone-runner attestation the way Milestone will before counting results.
// 1) Sigstore: DSSE signature, Fulcio cert issued to exactly our workflow on main, Rekor inclusion.
// 2) The in-toto subject digest equals sha256(results.json) we downloaded.
// 3) The predicate type is ours, and the signed predicate equals the file (nonce included).
// Then three forgeries: an edited results.json, a bundle checked against another workflow identity, a flipped payload byte.
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
const [, , depsDir, runDir] = process.argv;
const { verify } = createRequire(depsDir + "/package.json")("sigstore");

const IDENTITY = "https://github.com/TanmayShah29/milestone-runner/.github/workflows/run.yml@refs/heads/main";
const ISSUER = "https://token.actions.githubusercontent.com";
const PREDICATE = "https://milestone-ai-escrow.onrender.com/attestations/test-results/v1";

async function check(resultsBytes, bundle, identity = IDENTITY) {
  try {
    await verify(bundle, { certificateIssuer: ISSUER, certificateIdentityURI: identity });
  } catch (e) {
    return `REJECTED by Sigstore (${e.code ?? e.name})`;
  }
  const stmt = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString());
  const digest = crypto.createHash("sha256").update(resultsBytes).digest("hex");
  if (!stmt.subject.some((s) => s.digest?.sha256 === digest)) return "REJECTED (results.json digest is not the signed subject)";
  if (stmt.predicateType !== PREDICATE) return `REJECTED (predicate type ${stmt.predicateType})`;
  if (JSON.stringify(stmt.predicate) !== JSON.stringify(JSON.parse(resultsBytes))) return "REJECTED (predicate differs from results.json)";
  return `VERIFIED (${stmt.predicate.fixture}: ${stmt.predicate.cases.map((c) => c.name.slice(0, 2) + (c.pass ? "✓" : "✗")).join(" ")}, nonce ${stmt.predicate.nonce})`;
}

const results = fs.readFileSync(`${runDir}/results.json`);
const bundle = JSON.parse(fs.readFileSync(`${runDir}/attestations.json`, "utf8")).attestations[0].bundle;
console.log("genuine:", await check(results, bundle));

const edited = JSON.parse(results);
edited.cases.forEach((c) => (c.pass = true));
edited.allPassed = true;
console.log("results.json edited to all-pass:", await check(Buffer.from(JSON.stringify(edited, null, 1) + "\n"), bundle));
console.log("checked against another workflow:", await check(results, bundle, "https://github.com/TanmayShah29/milestone-demo/.github/workflows/milestone.yml@refs/heads/main"));
const flipped = structuredClone(bundle);
const raw = Buffer.from(flipped.dsseEnvelope.payload, "base64");
raw[raw.length - 3] ^= 1;
flipped.dsseEnvelope.payload = raw.toString("base64");
console.log("signed payload byte flipped:", await check(results, flipped));
console.log("rekor log index:", bundle.verificationMaterial.tlogEntries?.[0]?.logIndex);
