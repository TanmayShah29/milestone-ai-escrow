// Turns the junit report into results.json, the document the attestation signs.
import fs from "node:fs";
const [, , junitPath, nonce, fixture, runnerSha, image] = process.argv;
const xml = fs.existsSync(junitPath) ? fs.readFileSync(junitPath, "utf8") : "";
const cases = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => ({
  name: m[1],
  pass: !/<(failure|error|skipped)\b/.test(m[3] ?? ""),
}));
const out = { type: "milestone.test-results/v1", nonce, fixture, runnerSha, image, cases, allPassed: cases.length > 0 && cases.every((c) => c.pass) };
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
