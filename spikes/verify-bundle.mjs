// C2/B1 spike, verifier half: check a real GitHub Actions Sigstore bundle (SLSA provenance) the way Milestone
// would check a runner attestation: signature, Fulcio certificate identity (workflow + issuer), Rekor inclusion.
// Then flip one byte of the signed payload and confirm the check fails.
import { createRequire } from "node:module";
import fs from "node:fs";
const [, , depsDir, attestPath] = process.argv;
const require = createRequire(depsDir + "/package.json");
const { verify } = require("sigstore");

const doc = JSON.parse(fs.readFileSync(attestPath, "utf8"));
const bundle = doc.attestations.find((a) => a.predicateType === "https://slsa.dev/provenance/v1").bundle;
const payload = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString());
const wf = payload.predicate.buildDefinition.externalParameters.workflow;
const identity = `https://github.com/${wf.repository.replace("https://github.com/", "")}/${wf.path}@${wf.ref}`;
console.log("subject:", payload.subject[0].name, "| claimed workflow:", identity);
console.log("rekor log index:", bundle.verificationMaterial.tlogEntries?.[0]?.logIndex, "| inclusion proof:", !!bundle.verificationMaterial.tlogEntries?.[0]?.inclusionProof);

const policy = { certificateIssuer: "https://token.actions.githubusercontent.com", certificateIdentityURI: identity };
async function attempt(label, b, p) {
  const t = Date.now();
  try { await verify(b, p); console.log(`${label}: VERIFIED (${Date.now() - t} ms)`); }
  catch (e) { console.log(`${label}: REJECTED (${e.code ?? e.name}: ${String(e.message).slice(0, 120)})`); }
}
await attempt("genuine bundle, right workflow", bundle, policy);
await attempt("genuine bundle, wrong workflow identity", bundle, { ...policy, certificateIdentityURI: "https://github.com/someone/else/.github/workflows/run.yml@refs/heads/main" });
const tampered = structuredClone(bundle);
const raw = Buffer.from(tampered.dsseEnvelope.payload, "base64");
raw[raw.length - 5] ^= 1;
tampered.dsseEnvelope.payload = raw.toString("base64");
await attempt("payload with one byte flipped", tampered, policy);
