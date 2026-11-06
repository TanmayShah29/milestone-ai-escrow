import { createHash, randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { verify as sigstoreVerify } from "sigstore";
import { canonical } from "@/lib/contract/terms";
import { db } from "@/lib/db";
import type { Milestone } from "@/lib/milestones/repo";
import type { PullRequest } from "./github";

// The trusted runner (evidence level E3, V2_PLAN §3.C). Milestone dispatches `run.yml` in our own public
// repo; it runs the signed tests against the PR in two containers (runner/harness) and signs results.json
// through GitHub's OIDC and Sigstore (actions/attest). A result counts only after code here checks:
//  1. the Sigstore signature, from a certificate issued to exactly our workflow on main;
//  2. the signed subject digest is sha256(results.json);
//  3. the predicate type is ours and the signed predicate is results.json itself;
//  4. the nonce, repository, PR, commit and fingerprint are the ones this run was dispatched for.
// Sigstore only checks the envelope: 2–4 are what bind the file to the signature (SPIKES_V2 C2).

export const RUNNER_REPO = "TanmayShah29/milestone-runner";
export const RUNNER_IDENTITY = `https://github.com/${RUNNER_REPO}/.github/workflows/run.yml@refs/heads/main`;
export const RUNNER_ISSUER = "https://token.actions.githubusercontent.com";
export const RESULTS_PREDICATE = "https://milestone-ai-escrow.onrender.com/attestations/test-results/v2";
/** A dispatch that never shows up as a run, and a run that never finishes, give up after these. */
const START_TIMEOUT_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 30 * 60_000;

export type RunnerResults = {
  type: "milestone.test-results/v2";
  nonce: string;
  repo: string;
  pr: number;
  headSha: string;
  fingerprint: string;
  runner: { sha: string | null; runId: number | null; image: string };
  criteria: { id: string; pass: boolean; tests: number; failed: number; error?: string }[];
};

export type RunnerRun = { id: number; status: string; conclusion: string | null; url: string };

/** GitHub and Sigstore, behind a seam so tests never dispatch or verify anything real. */
export type RunnerApi = {
  dispatch(inputs: { repo: string; pr: string; head_sha: string; fingerprint: string; nonce: string }): Promise<void>;
  findRun(nonce: string): Promise<RunnerRun | undefined>;
  /** results.json from the run's `results` artifact. */
  resultsFile(runId: number): Promise<Buffer | undefined>;
  /** Sigstore bundles attested in the runner repo for this sha256 subject (public, no token needed). */
  bundles(digestHex: string): Promise<unknown[]>;
  /** Throws unless the bundle's signature and certificate identity check out. */
  verifySignature(bundle: unknown): Promise<void>;
};

export type Expected = { nonce: string; repo: string; pr: number; headSha: string; fingerprint: string };

export class RunnerRejected extends Error {}

/** Checks 2–4 above, then 1 for each bundle until one passes. Returns the results and the Rekor log index. */
export async function checkAttested(api: Pick<RunnerApi, "bundles" | "verifySignature">, file: Buffer, expect: Expected): Promise<{ results: RunnerResults; rekorIndex: number | null }> {
  let results: RunnerResults;
  try {
    results = JSON.parse(file.toString("utf8"));
  } catch {
    throw new RunnerRejected("results.json is not JSON");
  }
  const digest = createHash("sha256").update(file).digest("hex");
  const bundles = await api.bundles(digest);
  if (!bundles.length) throw new RunnerRejected("no attestation for this results.json");
  let lastProblem = "no attestation checked out";
  for (const bundle of bundles) {
    const b = bundle as { dsseEnvelope?: { payload?: string }; verificationMaterial?: { tlogEntries?: { logIndex?: string | number }[] } };
    let stmt: { subject?: { digest?: { sha256?: string } }[]; predicateType?: string; predicate?: unknown };
    try {
      stmt = JSON.parse(Buffer.from(b.dsseEnvelope?.payload ?? "", "base64").toString("utf8"));
    } catch {
      lastProblem = "the attestation's statement is unreadable";
      continue;
    }
    if (!stmt.subject?.some((s) => s.digest?.sha256 === digest)) lastProblem = "results.json is not the signed subject";
    else if (stmt.predicateType !== RESULTS_PREDICATE) lastProblem = `the predicate type is ${stmt.predicateType}`;
    else if (canonical(stmt.predicate) !== canonical(results)) lastProblem = "the signed predicate differs from results.json";
    else {
      try {
        await api.verifySignature(bundle);
      } catch (e) {
        lastProblem = `the signature does not check out (${(e as { code?: string }).code ?? (e as Error).message})`;
        continue;
      }
      const mismatch = (["nonce", "repo", "pr", "headSha", "fingerprint"] as const).find((k) => String(results[k]).toLowerCase() !== String(expect[k]).toLowerCase());
      if (mismatch) throw new RunnerRejected(`the signed results are for another ${mismatch}`);
      if (results.type !== "milestone.test-results/v2" || !Array.isArray(results.criteria)) throw new RunnerRejected("results.json is not a v2 result");
      const idx = b.verificationMaterial?.tlogEntries?.[0]?.logIndex;
      return { results, rekorIndex: idx === undefined ? null : Number(idx) };
    }
  }
  throw new RunnerRejected(lastProblem);
}

export type RunnerOutcome =
  | { status: "pending"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "done"; results: RunnerResults; runId: number | null; rekorIndex: number | null; url: string };

type Row = { nonce: string; status: string; run_id: string | null; results: RunnerResults | null; rekor_index: string | null; error: string | null; created_at: Date };

const runUrl = (id: number | null) => (id ? `https://github.com/${RUNNER_REPO}/actions/runs/${id}` : `https://github.com/${RUNNER_REPO}/actions`);

/**
 * The runner's result for this milestone, PR commit and review (`runKey`): dispatches once, then reports
 * pending until the signed result is in and checked. Anything that goes wrong (no token, a dispatch
 * refused, a run that failed or timed out, a result that doesn't check out) is "unavailable", and the
 * verifier falls back to the PR's own CI (E2). Safe to call on every tick.
 */
export async function runTrusted(m: Pick<Milestone, "id" | "repo" | "criteria_hash">, pr: Pick<PullRequest, "number" | "headSha" | "baseRepo">, runKey: string, api: RunnerApi): Promise<RunnerOutcome> {
  const repo = m.repo ?? pr.baseRepo;
  const { rows } = await db().query<Row>("select nonce, status, run_id, results, rekor_index, error, created_at from runner_runs where milestone_id = $1 and run_key = $2", [m.id, runKey]);
  let row = rows[0];
  if (!row) {
    const nonce = `ms-${randomBytes(12).toString("hex")}`;
    const ins = await db().query<Row>(
      `insert into runner_runs (milestone_id, run_key, head_sha, nonce) values ($1, $2, $3, $4) on conflict (milestone_id, run_key) do nothing
       returning nonce, status, run_id, results, rekor_index, error, created_at`,
      [m.id, runKey, pr.headSha, nonce],
    );
    if (!ins.rows[0]) return runTrusted(m, pr, runKey, api); // another caller dispatched first
    row = ins.rows[0];
    try {
      await api.dispatch({ repo, pr: String(pr.number), head_sha: pr.headSha, fingerprint: m.criteria_hash!, nonce });
    } catch (e) {
      return fail(m.id, runKey, `the runner could not be started (${String((e as Error).message ?? e).slice(0, 120)})`);
    }
    return { status: "pending", reason: "trusted runner started" };
  }
  if (row.status === "done" && row.results) return { status: "done", results: row.results, runId: row.run_id ? Number(row.run_id) : null, rekorIndex: row.rekor_index ? Number(row.rekor_index) : null, url: runUrl(row.run_id ? Number(row.run_id) : null) };
  if (row.status === "failed") return { status: "unavailable", reason: row.error ?? "the trusted runner failed" };

  const age = Date.now() - row.created_at.getTime();
  const run = await api.findRun(row.nonce);
  if (!run) return age > START_TIMEOUT_MS ? fail(m.id, runKey, "the trusted runner never started") : { status: "pending", reason: "trusted runner queued" };
  if (run.status !== "completed") return age > RUN_TIMEOUT_MS ? fail(m.id, runKey, `the trusted runner did not finish in 30 minutes (${run.url})`) : { status: "pending", reason: `trusted runner ${run.status}` };
  if (run.conclusion !== "success") return fail(m.id, runKey, `the trusted runner ended ${run.conclusion ?? "without a result"} (${run.url})`);
  const file = await api.resultsFile(run.id);
  if (!file) return fail(m.id, runKey, `the trusted runner left no results (${run.url})`);
  try {
    const { results, rekorIndex } = await checkAttested(api, file, { nonce: row.nonce, repo, pr: pr.number, headSha: pr.headSha, fingerprint: m.criteria_hash! });
    await db().query("update runner_runs set status = 'done', run_id = $3, results = $4, rekor_index = $5, updated_at = now() where milestone_id = $1 and run_key = $2", [m.id, runKey, run.id, JSON.stringify(results), rekorIndex]);
    return { status: "done", results, runId: run.id, rekorIndex, url: run.url };
  } catch (e) {
    if (!(e instanceof RunnerRejected)) throw e;
    return fail(m.id, runKey, `the trusted runner's result was rejected: ${e.message} (${run.url})`);
  }
}

async function fail(milestoneId: string, runKey: string, error: string): Promise<RunnerOutcome> {
  await db().query("update runner_runs set status = 'failed', error = $3, updated_at = now() where milestone_id = $1 and run_key = $2", [milestoneId, runKey, error]);
  return { status: "unavailable", reason: error };
}

// ---------------------------------------------------------------------------------------------
// The real API: GitHub REST with the dispatch-only token, Sigstore for the signature.

/** One file out of a zip archive (GitHub serves artifacts as zips): stored or deflated entries. */
export function zipEntry(zip: Buffer, name: string): Buffer | undefined {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return undefined;
  let p = zip.readUInt32LE(eocd + 16);
  const count = zip.readUInt16LE(eocd + 10);
  for (let i = 0; i < count && zip.readUInt32LE(p) === 0x02014b50; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30);
    const comment = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    if (zip.toString("utf8", p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : undefined;
    }
    p += 46 + nameLen + extra + comment;
  }
  return undefined;
}

export function runnerApi(token = process.env.RUNNER_GITHUB_TOKEN): RunnerApi | undefined {
  if (!token) return undefined;
  const gh = (path: string, init: RequestInit = {}) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...init.headers },
      signal: AbortSignal.timeout(20_000),
    });
  return {
    async dispatch(inputs) {
      const res = await gh(`/repos/${RUNNER_REPO}/actions/workflows/run.yml/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main", inputs }) });
      if (res.status !== 204) throw new Error(`GitHub ${res.status}`);
    },
    async findRun(nonce) {
      const res = await gh(`/repos/${RUNNER_REPO}/actions/workflows/run.yml/runs?event=workflow_dispatch&branch=main&per_page=50`);
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const { workflow_runs } = (await res.json()) as { workflow_runs: { id: number; display_title: string; status: string; conclusion: string | null; html_url: string; path: string }[] };
      const r = workflow_runs.find((x) => x.display_title === `milestone ${nonce}` && x.path === ".github/workflows/run.yml");
      return r && { id: r.id, status: r.status, conclusion: r.conclusion, url: r.html_url };
    },
    async resultsFile(runId) {
      const res = await gh(`/repos/${RUNNER_REPO}/actions/runs/${runId}/artifacts?name=results`);
      if (!res.ok) return undefined;
      const { artifacts } = (await res.json()) as { artifacts: { archive_download_url: string; expired: boolean }[] };
      const a = artifacts.find((x) => !x.expired);
      if (!a) return undefined;
      const zip = await fetch(a.archive_download_url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      return zip.ok ? zipEntry(Buffer.from(await zip.arrayBuffer()), "results.json") : undefined;
    },
    async bundles(digest) {
      const res = await fetch(`https://api.github.com/repos/${RUNNER_REPO}/attestations/sha256:${digest}`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return [];
      const { attestations } = (await res.json()) as { attestations: { bundle: unknown }[] };
      return attestations.map((a) => a.bundle);
    },
    async verifySignature(bundle) {
      await sigstoreVerify(bundle as Parameters<typeof sigstoreVerify>[0], { certificateIssuer: RUNNER_ISSUER, certificateIdentityURI: RUNNER_IDENTITY });
    },
  };
}
