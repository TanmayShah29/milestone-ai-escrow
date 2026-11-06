import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { after, beforeEach, describe, it } from "node:test";
import { depsWith, jsonResponse, resetDb, sampleTerms, seedMilestone, stubFetch } from "./helpers";
import { db } from "@/lib/db";
import { hashTerms, type Terms } from "@/lib/contract/terms";
import { getMilestone } from "@/lib/milestones/repo";
import type { CheckRun, GitHub, PrFile, PullRequest } from "@/lib/review/github";
import { checkAttested, RESULTS_PREDICATE, RunnerRejected, runTrusted, zipEntry, type RunnerApi, type RunnerResults, type RunnerRun } from "@/lib/review/runner";
import { acceptanceCheckName } from "@/lib/review/verifiers";
import { objectToRelease, reviewMilestone, tick, type ReviewDeps } from "@/lib/review/run";

beforeEach(resetDb);
after(() => db().end());

const SHA = "a".repeat(40);
const FP = "f".repeat(64);
const expect = { nonce: "ms-1", repo: "acme/web", pr: 7, headSha: SHA, fingerprint: FP };
const results = (over: Partial<RunnerResults> = {}): RunnerResults => ({
  type: "milestone.test-results/v2", nonce: "ms-1", repo: "acme/web", pr: 7, headSha: SHA, fingerprint: FP,
  runner: { sha: "r".repeat(40), runId: 99, image: "node@sha256:x" },
  criteria: [{ id: "C1", pass: true, tests: 1, failed: 0 }],
  ...over,
});
const file = (r: unknown) => Buffer.from(JSON.stringify(r, null, 1) + "\n");
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** What actions/attest produces, minus the real signature: verifySignature stands in for Sigstore. */
function bundleFor(bytes: Buffer, o: { predicate?: unknown; predicateType?: string; signedOk?: boolean } = {}) {
  const statement = { _type: "https://in-toto.io/Statement/v1", subject: [{ name: "results.json", digest: { sha256: digest(bytes) } }], predicateType: o.predicateType ?? RESULTS_PREDICATE, predicate: o.predicate ?? JSON.parse(bytes.toString()) };
  return { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") }, verificationMaterial: { tlogEntries: [{ logIndex: "3696651884" }] }, signedOk: o.signedOk ?? true };
}
const sigstore = (bundles: (d: string) => unknown[]) => ({
  bundles: async (d: string) => bundles(d),
  verifySignature: async (b: unknown) => {
    if (!(b as { signedOk: boolean }).signedOk) throw Object.assign(new Error("untrusted"), { code: "UNTRUSTED_SIGNER_ERROR" });
  },
});

describe("trusted runner: checking a signed result", () => {
  it("accepts a genuine result and reads its Rekor log index", async () => {
    const f = file(results());
    const out = await checkAttested(sigstore(() => [bundleFor(f)]), f, expect);
    assert.equal(out.results.criteria[0]!.pass, true);
    assert.equal(out.rekorIndex, 3696651884);
  });

  it("rejects results.json edited after signing, even when handed the genuine bundle", async () => {
    const genuine = file(results({ criteria: [{ id: "C1", pass: false, tests: 1, failed: 1 }] }));
    const edited = file(results());
    await assert.rejects(checkAttested(sigstore(() => []), edited, expect), /no attestation/);
    await assert.rejects(checkAttested(sigstore(() => [bundleFor(genuine)]), edited, expect), /not the signed subject/);
  });

  it("rejects a predicate that differs from the file, another predicate type, and a bad signature", async () => {
    const f = file(results());
    await assert.rejects(checkAttested(sigstore(() => [bundleFor(f, { predicate: results({ criteria: [] }) })]), f, expect), /predicate differs/);
    await assert.rejects(checkAttested(sigstore(() => [bundleFor(f, { predicateType: "https://slsa.dev/provenance/v1" })]), f, expect), /predicate type/);
    await assert.rejects(checkAttested(sigstore(() => [bundleFor(f, { signedOk: false })]), f, expect), /UNTRUSTED_SIGNER_ERROR/);
  });

  it("uses the bundle that checks out when there are several", async () => {
    const f = file(results());
    assert.ok(await checkAttested(sigstore(() => [bundleFor(f, { signedOk: false }), bundleFor(f)]), f, expect));
  });

  it("rejects a genuine result replayed for another nonce, commit, PR or contract", async () => {
    for (const [k, v] of [["nonce", "ms-2"], ["headSha", "b".repeat(40)], ["pr", 8], ["fingerprint", "e".repeat(64)], ["repo", "evil/web"]] as const) {
      const f = file(results({ [k]: v }));
      await assert.rejects(checkAttested(sigstore(() => [bundleFor(f)]), f, expect), (e: unknown) => e instanceof RunnerRejected && e.message.includes(k));
    }
  });
});

describe("zipEntry (GitHub artifact archives)", () => {
  function zip(entries: { name: string; data: Buffer; deflate: boolean }[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
      const body = e.deflate ? deflateRawSync(e.data) : e.data;
      const name = Buffer.from(e.name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(e.deflate ? 8 : 0, 8);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(e.data.length, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(e.deflate ? 8 : 0, 10);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(e.data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, name, body);
      centrals.push(central, name);
      offset += 30 + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  }

  it("reads a stored or deflated entry by name", () => {
    const z = zip([{ name: "notes.txt", data: Buffer.from("hi"), deflate: false }, { name: "results.json", data: Buffer.from('{"ok":true}'), deflate: true }]);
    assert.equal(zipEntry(z, "results.json")!.toString(), '{"ok":true}');
    assert.equal(zipEntry(z, "notes.txt")!.toString(), "hi");
    assert.equal(zipEntry(z, "missing.json"), undefined);
    assert.equal(zipEntry(Buffer.from("not a zip"), "results.json"), undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// The run lifecycle and the review, with a fake runner (no dispatches, no Sigstore).

const PR_URL = "https://github.com/acme/web/pull/7";

function fakeRunner(o: { outcome?: (nonce: string) => { pass: boolean }[]; dispatchFails?: boolean } = {}) {
  const dispatched: Record<string, string>[] = [];
  const runs = new Map<string, RunnerRun>();
  const files = new Map<number, Buffer>();
  const api: RunnerApi & { complete(i?: number, conclusion?: string): void } = {
    async dispatch(inputs) {
      if (o.dispatchFails) throw new Error("GitHub 403");
      dispatched.push(inputs);
    },
    async findRun(nonce) {
      return runs.get(nonce);
    },
    async resultsFile(id) {
      return files.get(id);
    },
    ...sigstore((d) => [...files.values()].filter((f) => digest(f) === d).map((f) => bundleFor(f))),
    complete(i = dispatched.length - 1, conclusion = "success") {
      const inp = dispatched[i]!;
      const id = 1000 + i;
      runs.set(inp.nonce!, { id, status: "completed", conclusion, url: `https://github.com/TanmayShah29/milestone-runner/actions/runs/${id}` });
      const crit = (o.outcome?.(inp.nonce!) ?? [{ pass: true }]).map((r, k) => ({ id: `C${k + 1}`, pass: r.pass, tests: 1, failed: r.pass ? 0 : 1 }));
      files.set(id, file({ type: "milestone.test-results/v2", nonce: inp.nonce, repo: inp.repo, pr: Number(inp.pr), headSha: inp.head_sha, fingerprint: inp.fingerprint, runner: { sha: null, runId: id, image: "node" }, criteria: crit }));
    },
  };
  return { api, dispatched, runs };
}

const runnerTerms = (policyVersion = "policy-2", extra: Partial<Terms["criteria"][number]> = {}): Terms => ({
  criteria: [{ ...sampleTerms.criteria[0]!, ...extra }],
  testCommand: sampleTerms.testCommand,
  policy: { platformFeeBps: 500, objectionWindowSeconds: 3600, policyVersion, confidenceFloor: 0.8, reviewModels: [], verifier: "code_pr@2" },
});

async function seeded(terms: Terms) {
  const id = await seedMilestone({ state: "SUBMITTED", repo: "acme/web", pr_url: PR_URL, paypal_order_id: "O1", paypal_authorization_id: "A1", authorized_cents: 30_000 });
  const m = await getMilestone(id);
  const hash = hashTerms(m, terms);
  await db().query("update milestones set criteria = $2, criteria_hash = $3, client_signed_hash = $3, worker_signed_hash = $3 where id = $1", [id, JSON.stringify(terms), hash]);
  return { id, hash };
}

function github(hash: string, o: { files?: PrFile[]; ci?: string } = {}) {
  const calls: string[] = [];
  const run = (name: string): CheckRun => ({ name, status: "completed", conclusion: o.ci ?? "success", url: `https://ci/${name}`, startedAt: new Date().toISOString(), app: "github-actions", headSha: SHA, workflowRunId: 1 });
  const gh: GitHub = {
    async pr(owner, repo, n) {
      return { number: n, title: "Dark mode", body: `Milestone-Terms: ${hash}`, state: "open", merged: false, headSha: SHA, baseRepo: `${owner}/${repo}`, htmlUrl: PR_URL } satisfies PullRequest;
    },
    async files() {
      return o.files ?? [{ filename: "src/theme.ts", status: "added", additions: 1, deletions: 0, patch: "+export const dark = true;" }];
    },
    async checkRuns() {
      calls.push("checks");
      return [run("contract"), run(acceptanceCheckName("C1", hash))];
    },
    async workflowRun(_o, _r, id) {
      return { id, path: ".github/workflows/milestone.yml", event: "pull_request", headSha: SHA };
    },
    async comment() {},
  };
  return { gh, calls };
}

const deps = (gh: GitHub, runner?: RunnerApi): ReviewDeps => ({ github: gh, ...(runner ? { runner } : {}), money: depsWith(stubFetch(() => jsonResponse(500, {}))) });

describe("trusted runner: one run per review", () => {
  it("dispatches once, waits while queued, and stores the checked result", async () => {
    const { id, hash } = await seeded(runnerTerms());
    const { api, dispatched } = fakeRunner();
    const m = await getMilestone(id);
    const pr = { number: 7, headSha: SHA, baseRepo: "acme/web" };
    assert.equal((await runTrusted(m, pr, SHA, api)).status, "pending");
    assert.equal((await runTrusted(m, pr, SHA, api)).status, "pending");
    assert.equal(dispatched.length, 1);
    assert.deepEqual({ ...dispatched[0], nonce: "x" }, { repo: "acme/web", pr: "7", head_sha: SHA, fingerprint: hash, nonce: "x" });
    assert.match(dispatched[0]!.nonce!, /^ms-[0-9a-f]{24}$/);
    api.complete();
    const done = await runTrusted(m, pr, SHA, api);
    assert.equal(done.status, "done");
    assert.equal(done.status === "done" && done.rekorIndex, 3696651884);
  });

  it("gives up (unavailable) on a refused dispatch, a failed run, or a run that never starts", async () => {
    const { id } = await seeded(runnerTerms());
    const m = await getMilestone(id);
    const pr = { number: 7, headSha: SHA, baseRepo: "acme/web" };
    assert.match(JSON.stringify(await runTrusted(m, pr, "k1", fakeRunner({ dispatchFails: true }).api)), /could not be started/);
    const failing = fakeRunner();
    await runTrusted(m, pr, "k2", failing.api);
    failing.api.complete(0, "failure");
    assert.match(JSON.stringify(await runTrusted(m, pr, "k2", failing.api)), /ended failure/);
    const lost = fakeRunner();
    await runTrusted(m, pr, "k3", lost.api);
    await db().query("update runner_runs set created_at = now() - interval '6 minutes' where run_key = 'k3'");
    assert.match(JSON.stringify(await runTrusted(m, pr, "k3", lost.api)), /never started/);
    // Each failure is final for its run: no second dispatch.
    assert.equal(lost.dispatched.length, 1);
  });
});

describe("review with the trusted runner (policy-2 terms)", () => {
  it("passes on a signed runner pass at E3 without reading the PR's CI, and the proof chain names the run", async () => {
    const { id, hash } = await seeded(runnerTerms());
    const { gh, calls } = github(hash);
    const { api } = fakeRunner();
    assert.equal((await reviewMilestone(id, deps(gh, api))).state, "IN_REVIEW");
    api.complete();
    assert.equal((await reviewMilestone(id, deps(gh, api))).state, "PASSED");
    assert.deepEqual(calls, []);
    const { rows } = await db().query<{ verdict: { criteria: { level: string; evidence: string[] }[] } }>("select verdict from reviews where milestone_id = $1", [id]);
    assert.equal(rows[0]!.verdict.criteria[0]!.level, "E3");
    assert.match(rows[0]!.verdict.criteria[0]!.evidence[0]!, /signed: .*runs\/1000, Rekor 3696651884/);
    const { rows: proof } = await db().query<{ body: unknown }>("select body from proof_events where milestone_id = $1 order by seq", [id]);
    const passed = proof.map((r) => (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as { event: string; facts: Record<string, unknown> }).find((b) => b.event === "review:passed")!;
    assert.equal(passed.facts.runnerRunId, 1000);
    assert.equal(passed.facts.rekorLogIndex, 3696651884);
  });

  it("a signed runner failure requests changes", async () => {
    const { id, hash } = await seeded(runnerTerms());
    const { api } = fakeRunner({ outcome: () => [{ pass: false }] });
    await reviewMilestone(id, deps(github(hash).gh, api));
    api.complete();
    assert.equal((await reviewMilestone(id, deps(github(hash).gh, api))).state, "CHANGES_REQUESTED");
  });

  it("editing .github/ or acceptance/ isn't tampering under the runner, because the PR's workflow and tests count for nothing", async () => {
    const { id, hash } = await seeded(runnerTerms());
    const files = [{ filename: ".github/workflows/milestone.yml", status: "modified", additions: 1, deletions: 1, patch: "+      - run: exit 0" }, { filename: "acceptance/c1.test.ts", status: "modified", additions: 1, deletions: 0, patch: "+process.exit(0)" }];
    const { api } = fakeRunner();
    await reviewMilestone(id, deps(github(hash, { files }).gh, api));
    api.complete();
    assert.equal((await reviewMilestone(id, deps(github(hash, { files }).gh, api))).state, "PASSED");
  });

  it("an E3 floor passes on the runner, and escalates when only the PR's CI (E2) is left", async () => {
    const e3 = runnerTerms("policy-2", { evidenceFloor: "E3" });
    const a = await seeded(e3);
    const ok = fakeRunner();
    await reviewMilestone(a.id, deps(github(a.hash).gh, ok.api));
    ok.api.complete();
    assert.equal((await reviewMilestone(a.id, deps(github(a.hash).gh, ok.api))).state, "PASSED");

    await resetDb();
    const b = await seeded(e3);
    const { gh, calls } = github(b.hash);
    assert.equal((await reviewMilestone(b.id, deps(gh, fakeRunner({ dispatchFails: true }).api))).state, "HUMAN_CHECK");
    assert.deepEqual(calls, ["checks"]); // fell back to CI
    const { rows } = await db().query<{ verdict: { criteria: { evidence: string[] }[] } }>("select verdict from reviews where milestone_id = $1", [b.id]);
    assert.match(rows[0]!.verdict.criteria[0]!.evidence.join(" "), /trusted runner unavailable: the runner could not be started/);
  });

  it("policy-1 terms never use the runner", async () => {
    const { id, hash } = await seeded(runnerTerms("policy-1"));
    const runner = fakeRunner();
    assert.equal((await reviewMilestone(id, deps(github(hash).gh, runner.api))).state, "PASSED");
    assert.equal(runner.dispatched.length, 0);
  });

  it("an objection's second review re-runs the tests on a fresh run (new nonce)", async () => {
    const { id, hash } = await seeded(runnerTerms());
    const { api, dispatched } = fakeRunner({ outcome: (nonce) => [{ pass: nonce === dispatched[0]?.nonce }] });
    const d = deps(github(hash).gh, api);
    await reviewMilestone(id, d);
    api.complete();
    assert.equal((await reviewMilestone(id, d)).state, "PASSED");
    await objectToRelease(id, { reason: "it breaks on mobile" });
    assert.equal((await tick(id, d)).state, "CONTESTED"); // second run dispatched, pending
    assert.equal(dispatched.length, 2);
    assert.notEqual(dispatched[1]!.nonce, dispatched[0]!.nonce);
    api.complete(1);
    await db().query("update reviews set updated_at = now() - interval '6 minutes' where milestone_id = $1 and status = 'pending'", [id]); // past the retry pause
    assert.equal((await tick(id, d)).state, "CHANGES_REQUESTED"); // the re-run failed
  });
});

// ---------------------------------------------------------------------------------------------
// The harness itself (runner/harness), without Docker: the shim and the synchronous client over a socket.

describe("runner harness: synchronous calls across the boundary", () => {
  const HARNESS = resolve("runner/harness");
  it("plans proxies only for relative imports, and refuses imports from acceptance/ or outside the repo", async () => {
    const plan = (await import(join(HARNESS, "plan.mjs") as string)) as { proxiesFor(p: string, c: string): { file: string; names: string[]; default: boolean }[] };
    const code = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { initials, later as l } from '../src/initials.ts';\nimport * as u from '../src/util.ts';\nu.pad(1);";
    assert.deepEqual(plan.proxiesFor("acceptance/c1.test.ts", code), [{ file: "src/initials.ts", names: ["initials", "later"], default: false }, { file: "src/util.ts", names: ["pad"], default: false }]);
    assert.throws(() => plan.proxiesFor("acceptance/c1.test.ts", "import { x } from './helper.ts';"), /acceptance/);
    assert.throws(() => plan.proxiesFor("acceptance/c1.test.ts", "import { x } from '../../etc/passwd.ts';"), /outside/);
  });

  it("values, async results and thrown errors survive; a worker that exits fails the test instead of passing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-"));
    const sock = join(dir, "rpc.sock");
    writeFileSync(join(dir, "mod.mjs"), [
      "export const add = (a, b) => a + b;",
      "export const shape = () => ({ n: undefined, inf: Infinity, d: new Date(0), $: 1 });",
      "export const later = async (n) => n * 2;",
      "export const boom = () => { throw new TypeError('nope'); };",
      "export const quit = () => process.exit(0);",
    ].join("\n"));
    const plan = (await import(join(HARNESS, "plan.mjs") as string)) as { proxySource(p: unknown, client: string): string };
    writeFileSync(join(dir, "proxy.mjs"), plan.proxySource({ file: "mod.mjs", names: ["add", "shape", "later", "boom", "quit"], default: false }, join(HARNESS, "client.mjs")));
    writeFileSync(join(dir, "t.test.mjs"), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add, shape, later, boom, quit } from './proxy.mjs';",
      "test('values', async () => {",
      "  assert.equal(add(2, 3), 5);",
      "  assert.deepEqual(shape(), { n: undefined, inf: Infinity, d: new Date(0), $: 1 });",
      "  assert.equal(await later(21), 42);",
      "  assert.throws(() => boom(), { name: 'TypeError', message: 'nope' });",
      "});",
      "test('exit', () => { quit(); });",
    ].join("\n"));
    const shim = spawn(process.execPath, [join(HARNESS, "shim.mjs"), dir, sock], { stdio: "ignore" });
    try {
      for (let i = 0; i < 50 && spawnSync("test", ["-S", sock]).status !== 0; i++) await new Promise((r) => setTimeout(r, 100));
      const env: NodeJS.ProcessEnv = { ...process.env, RPC_SOCK: sock };
      delete env.NODE_TEST_CONTEXT; // else the inner node --test thinks it is nested in this one and skips
      const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", join(dir, "t.test.mjs")], { env, encoding: "utf8", timeout: 30_000 });
      assert.match(run.stdout, /^ok \d+ - values$/m);
      assert.match(run.stdout, /^not ok \d+ - exit$/m);
      assert.match(run.stdout, /closed the connection/);
    } finally {
      shim.kill();
    }
  });
});
