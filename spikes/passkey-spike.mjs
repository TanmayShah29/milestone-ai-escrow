// A1 spike: a party registers a passkey, then signs the contract by using the terms fingerprint as the
// WebAuthn challenge. The server verifies with @simplewebauthn/server. Headless Chromium with a CDP virtual
// authenticator stands in for a phone or laptop. A signature over different terms must fail.
import { createRequire } from "node:module";
import http from "node:http";
import crypto from "node:crypto";
const [, , depsDir, repoDir] = process.argv;
const req1 = createRequire(depsDir + "/package.json");
const req2 = createRequire(repoDir + "/package.json");
const swa = req1("@simplewebauthn/server");
const { chromium } = req2("playwright");

const RP_ID = "localhost", ORIGIN = "http://localhost:8787";
const fingerprint = crypto.createHash("sha256").update('{"criteria":[{"id":"C1","text":"add returns the sum"}]}').digest("hex");
const b64u = (buf) => Buffer.from(buf).toString("base64url");
let regOptions, credential;

const page = `<!doctype html><script>
const toB = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
const toS = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
window.register = async (o) => {
  const c = await navigator.credentials.create({ publicKey: { ...o, challenge: toB(o.challenge), user: { ...o.user, id: toB(o.user.id) },
    excludeCredentials: [] } });
  return { id: c.id, rawId: toS(c.rawId), type: c.type, clientExtensionResults: {}, response: {
    clientDataJSON: toS(c.response.clientDataJSON), attestationObject: toS(c.response.attestationObject), transports: c.response.getTransports() } };
};
window.sign = async (challenge, credId) => {
  const a = await navigator.credentials.get({ publicKey: { challenge: toB(challenge), rpId: location.hostname, userVerification: 'required',
    allowCredentials: [{ id: toB(credId), type: 'public-key' }] } });
  return { id: a.id, rawId: toS(a.rawId), type: a.type, clientExtensionResults: {}, response: {
    clientDataJSON: toS(a.response.clientDataJSON), authenticatorData: toS(a.response.authenticatorData), signature: toS(a.response.signature),
    userHandle: a.response.userHandle ? toS(a.response.userHandle) : undefined } };
};
</script>`;
const server = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(page); }).listen(8787);

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
  await p.goto(ORIGIN);

  regOptions = await swa.generateRegistrationOptions({ rpName: "Milestone", rpID: RP_ID, userName: "client@example.test", attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" } });
  const regResp = await p.evaluate((o) => window.register(o), regOptions);
  const reg = await swa.verifyRegistrationResponse({ response: regResp, expectedChallenge: regOptions.challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID });
  credential = reg.registrationInfo.credential;
  console.log("register:", reg.verified ? "VERIFIED" : "FAILED", "| credential", credential.id.slice(0, 12) + "…");

  // Sign the terms: the challenge is the fingerprint itself (plus a server nonce in production).
  const challenge = b64u(Buffer.from(fingerprint, "hex"));
  const asr = await p.evaluate(([c, id]) => window.sign(c, id), [challenge, credential.id]);
  const check = (expected) => swa.verifyAuthenticationResponse({ response: asr, expectedChallenge: expected, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
    credential, requireUserVerification: true }).then((v) => (v.verified ? "VERIFIED" : "FAILED"), (e) => "REJECTED (" + e.message.slice(0, 80) + ")");
  console.log("signature over the signed terms:", await check(challenge));
  const other = b64u(crypto.createHash("sha256").update("different terms").digest());
  console.log("same signature presented for other terms:", await check(other));
  console.log("stored per party: credential id, public key (" + credential.publicKey.length + " bytes COSE), counter", credential.counter);
} finally {
  await browser.close();
  server.close();
}
