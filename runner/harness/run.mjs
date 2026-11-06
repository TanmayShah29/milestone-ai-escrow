// The runner job's host side: our code only. It fetches the signed contract, checks its hash, and runs each
// tested criterion in a fresh pair of containers: the PR's code in `worker` (no network, read-only, the
// checkout mounted read-only), the signed test in `tests` with proxies in place of the worker's modules.
// The PR's code never runs on the host and never shares a process with an assertion. Prints results.json.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { proxiesFor, proxySource } from "./plan.mjs";

const { REPO, PR, HEAD_SHA, FINGERPRINT, NONCE, IMG, MILESTONE_API } = process.env;
const CHECKOUT = path.resolve(process.env.CHECKOUT ?? "pr");
const HARNESS = path.dirname(new URL(import.meta.url).pathname);
const TEST_TIMEOUT_MS = 120_000;
const log = (...a) => console.error(...a);
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function contract() {
  let res;
  for (let i = 0; i < 12; i++) {
    // The app sleeps when idle on the free tier; give it time to wake up.
    res = await fetch(`${MILESTONE_API}/api/contracts/${FINGERPRINT}`).catch(() => undefined);
    if (res?.ok || res?.status === 404) break;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!res?.ok) throw new Error(`contract ${FINGERPRINT} not found (${res?.status ?? "no response"})`);
  const { document } = await res.json();
  if (createHash("sha256").update(document).digest("hex") !== FINGERPRINT) throw new Error("contract hash mismatch");
  const doc = JSON.parse(document);
  if (!doc.repo || doc.repo.toLowerCase() !== REPO.toLowerCase()) throw new Error(`contract is for ${doc.repo ?? "no repository"}, not ${REPO}`);
  return doc;
}

function runCriterion(c) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), `t-${c.id}-`));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `o-${c.id}-`));
  fs.chmodSync(out, 0o777);
  const write = (rel, code) => {
    fs.mkdirSync(path.dirname(path.join(t, rel)), { recursive: true });
    fs.writeFileSync(path.join(t, rel), code);
  };
  write(c.test.path, c.test.code);
  for (const p of proxiesFor(c.test.path, c.test.code)) write(p.file, proxySource(p));
  fs.chmodSync(t, 0o755);

  const vol = `sock-${c.id.toLowerCase()}`;
  const worker = `worker-${c.id.toLowerCase()}`;
  docker("volume", "create", vol);
  docker("run", "--rm", "-v", `${vol}:/sock`, IMG, "chmod", "777", "/sock");
  const limits = ["--network", "none", "--read-only", "--tmpfs", "/tmp", "--user", "1000:1000", "--memory", "512m", "--pids-limit", "256", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
  try {
    docker("run", "-d", "--name", worker, ...limits, "-v", `${CHECKOUT}:/work:ro`, "-v", `${HARNESS}:/harness:ro`, "-v", `${vol}:/sock`, IMG, "node", "/harness/shim.mjs", "/work", "/sock/rpc.sock");
    for (let i = 0; i < 50 && spawnSync("docker", ["exec", worker, "test", "-S", "/sock/rpc.sock"]).status !== 0; i++) spawnSync("sleep", ["0.2"]);
    const run = spawnSync(
      "docker",
      ["run", "--rm", ...limits, "-e", "RPC_SOCK=/sock/rpc.sock", "-v", `${t}:/t:ro`, "-v", `${HARNESS}:/harness:ro`, "-v", `${vol}:/sock`, "-v", `${out}:/out`, IMG,
        "node", "--test", "--test-reporter=/harness/reporter.mjs", "--test-reporter-destination=/out/r.jsonl", `/t/${c.test.path}`],
      { encoding: "utf8", timeout: TEST_TIMEOUT_MS },
    );
    const lines = fs.existsSync(path.join(out, "r.jsonl")) ? fs.readFileSync(path.join(out, "r.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const failed = lines.filter((l) => !l.ok);
    log(`--- ${c.id}: exit ${run.status ?? run.signal}, ${lines.length} tests, ${failed.length} failed`);
    for (const f of failed) log(`    ✗ ${f.name}: ${f.message}`);
    const pass = run.status === 0 && lines.length > 0 && failed.length === 0;
    return { id: c.id, pass, tests: lines.length, failed: failed.length, ...(run.error ? { error: `the test did not finish (${run.error.code ?? run.error.message})` } : {}) };
  } finally {
    log(`--- ${c.id} worker log`);
    log(spawnSync("docker", ["logs", worker], { encoding: "utf8" }).stdout ?? "");
    spawnSync("docker", ["rm", "-f", worker]);
    spawnSync("docker", ["volume", "rm", "-f", vol]);
  }
}

const doc = await contract();
// The workflow checked out HEAD_SHA and confirmed it is the PR's head (run.yml).
const criteria = [];
for (const c of doc.criteria.filter((x) => x.test)) {
  if (!/\.(ts|js|mjs)$/.test(c.test.path)) {
    criteria.push({ id: c.id, pass: false, tests: 0, failed: 0, error: `the runner can't run ${c.test.path} yet (JavaScript and TypeScript only)` });
    continue;
  }
  try {
    criteria.push(runCriterion(c));
  } catch (e) {
    criteria.push({ id: c.id, pass: false, tests: 0, failed: 0, error: String(e.message ?? e).slice(0, 300) });
  }
}
const image = docker("image", "inspect", IMG, "--format", "{{index .RepoDigests 0}}");
const results = {
  type: "milestone.test-results/v2",
  nonce: NONCE,
  repo: REPO,
  pr: Number(PR),
  headSha: HEAD_SHA,
  fingerprint: FINGERPRINT,
  runner: { sha: process.env.GITHUB_SHA ?? null, runId: Number(process.env.GITHUB_RUN_ID ?? 0) || null, image },
  criteria,
};
process.stdout.write(JSON.stringify(results, null, 1) + "\n");
