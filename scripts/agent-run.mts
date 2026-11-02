// An agent hires an agent, on the live app. Two separate MCP clients talk to mcp/server.mts:
//  - the buyer agent posts a job and signs the terms the AI drafted (a scripted agent; the job is fixed here);
//  - the worker agent reads the signed tests, writes code with a free AI model, opens a real PR, reads the
//    verdict and fixes the code. Its first attempt is told to rush (see FIRST_ATTEMPT), so the failure path
//    shows up on every run. Say so wherever this run is shown.
// Neither agent has a tool that moves money. A person funds the hold once, in the deal room.
//
// Run:    npm run agents               (prints the client link, then waits for you to click Fund)
//         npm run agents -- --auto-fund  (for testing: this script, not an agent, clicks Fund with the sandbox test card)
// Needs:  OPENROUTER_API_KEY and AI_MODEL* in .env, and `gh` signed in with write access to the demo repo.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const API = (process.env.MILESTONE_API ?? "https://milestone-ai-escrow.onrender.com").replace(/\/$/, "");
const REPO = "TanmayShah29/milestone-demo";
const WORKER_EMAIL = "sb-puo47p53461265@personal.example.com";
const MONEY_WORDS = /fund|capture|release|void|refund|payout|pay_|authorize/i;
const MAX_ATTEMPTS = 3;
const TOOL_TIMEOUT_MS = 300_000;
const POLL_MS = 15_000;
const WAIT_LIMIT_MS = 15 * 60_000;

const JOB = {
  title: "Add a Roman numeral helper",
  amount_usd: "15.00",
  brief: "Add src/roman.ts exporting toRoman(n: number): string. It converts whole numbers from 1 to 3999 to Roman numerals, using subtractive forms: 4 is IV, 9 is IX, 40 is XL, 1994 is MCMXCIV. Anything outside 1 to 3999, and any non-integer, throws a RangeError. Test only behaviour in code; no documentation criteria.",
};
const FIRST_ATTEMPT = "You're in a hurry. Write the shortest version that handles simple numbers such as 1, 2, 3, 5, 6, 10 and 20, by adding up symbols. Skip subtractive forms and skip input checks for now.";

const started = Date.now();
const say = (who: string, line: string) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s] ${who.padEnd(12)} ${line}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Tool = (name: string, args: Record<string, unknown>) => Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function connect(name: string): Promise<{ tool: Tool; names: string[]; close: () => Promise<void> }> {
  const { MILESTONE_API_KEY: _key, OPENROUTER_API_KEY: _ai, ...env } = process.env as Record<string, string>;
  void _key;
  void _ai;
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "mcp/server.mts"], env: { ...env, MILESTONE_API: API }, stderr: "inherit" }));
  const names = (await client.listTools()).tools.map((t) => t.name);
  const tool: Tool = async (tool, args) => {
    const out = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
    const body = (out.content as { text: string }[])[0]?.text ?? "";
    if (out.isError) throw new Error(`${tool}: ${body}`);
    return JSON.parse(body);
  };
  return { tool, names, close: () => client.close() };
}

// ---------------------------------------------------------------------------------------------
// The worker's two outside abilities: an AI model that writes code, and git (through the GitHub API).

async function writeCode(prompt: string): Promise<{ path: string; code: string }> {
  const models = [process.env.AI_MODEL, process.env.AI_MODEL_FALLBACK, process.env.AI_MODEL_FALLBACK_2].filter(Boolean) as string[];
  if (!process.env.OPENROUTER_API_KEY || !models.length) throw new Error("Set OPENROUTER_API_KEY and AI_MODEL in .env");
  for (const model of models) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 6000, messages: [{ role: "system", content: 'You are a contractor writing one TypeScript file, using type annotations only (no enums or namespaces). Reply with ONLY a JSON object: {"path":"src/<file>.ts","code":"<the whole file>"}' }, { role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
      const out = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { path?: unknown; code?: unknown };
      if (typeof out.path === "string" && /^src\/[\w.-]+\.ts$/.test(out.path) && typeof out.code === "string" && out.code.length > 10) {
        say("worker", `${model} wrote ${out.path} (${out.code.split("\n").length} lines)`);
        return { path: out.path, code: out.code };
      }
      throw new Error("no usable file in the reply");
    } catch (err) {
      say("worker", `${model} didn't work (${String(err).slice(0, 80)}); trying the next model`);
    }
  }
  throw new Error("no AI model could write the code; free models come and go, so try again shortly");
}

const exec = promisify(execFile);
async function gh(args: string[]): Promise<string> {
  return (await exec("gh", ["api", ...args], { maxBuffer: 10_000_000 })).stdout.trim();
}

async function commit(branch: string, file: { path: string; code: string }, message: string): Promise<void> {
  const sha = await gh([`repos/${REPO}/contents/${file.path}?ref=${branch}`, "--jq", ".sha"]).catch(() => "");
  await gh(["-X", "PUT", `repos/${REPO}/contents/${file.path}`, "-f", `message=${message}`, "-f", `branch=${branch}`, "-f", `content=${Buffer.from(file.code).toString("base64")}`, ...(sha ? ["-f", `sha=${sha}`] : []), "--silent"]);
}

// ---------------------------------------------------------------------------------------------

async function waitFor<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + WAIT_LIMIT_MS;
  while (Date.now() < until) {
    const got = await check();
    if (got !== undefined) return got;
    await sleep(POLL_MS);
  }
  throw new Error(`gave up waiting for ${what}`);
}

async function main() {
  const buyer = await connect("buyer-agent");
  const worker = await connect("worker-agent");
  try {
    const leaked = [...buyer.names, ...worker.names].filter((n) => MONEY_WORDS.test(n));
    say("harness", `Tools both agents have: ${[...new Set([...buyer.names, ...worker.names])].join(", ")}`);
    if (leaked.length) throw new Error(`an agent has a money tool: ${leaked.join(", ")}`);
    say("harness", "No tool can fund, capture, release, void or refund.");

    say("buyer", `Posting a $${JOB.amount_usd} job: ${JOB.title}. The AI is drafting the criteria and tests…`);
    const posted = await buyer.tool("create_milestone", { ...JOB, worker_paypal_email: WORKER_EMAIL, repo: REPO });
    const clientLink = posted.clientLink as string;
    const workerLink = posted.workerLink as string;
    let terms = await buyer.tool("get_milestone", { milestone: clientLink });
    for (let i = 0; i < 2 && terms.criteria.some((c: { testWeak?: boolean; testStale?: boolean }) => c.testWeak || c.testStale); i++) {
      say("buyer", "A drafted test wouldn't catch missing work, so signing is blocked. Asking for it to be rewritten…");
      terms = await buyer.tool("draft_terms", { milestone: clientLink });
    }
    const tested = terms.criteria.filter((c: { test?: unknown }) => c.test);
    if (!tested.length) throw new Error("the draft has no tests; run again");
    for (const c of terms.criteria) say("buyer", `  ${c.id} (${c.kind}, ${c.check}): ${c.text}`);
    await buyer.tool("accept_terms", { milestone: clientLink, fingerprint: terms.fingerprint });
    say("buyer", `Signed terms ${String(terms.fingerprint).slice(0, 16)}…`);

    const read = await worker.tool("get_milestone", { milestone: workerLink });
    if (read.fingerprint !== terms.fingerprint) throw new Error("the worker read different terms");
    const signed = await worker.tool("accept_terms", { milestone: workerLink, fingerprint: read.fingerprint });
    say("worker", `Read the same terms and signed. State: ${signed.state}`);

    if (process.argv.includes("--auto-fund")) {
      const [, id, token] = /milestones\/([0-9a-f-]{36})\?t=([\w-]+)/.exec(clientLink)!;
      const res = await fetch(`${API}/api/milestones/${id}/fund-card`, { method: "POST", headers: { "content-type": "application/json", "x-milestone-token": token! }, body: "{}" });
      if (!res.ok) throw new Error(`funding failed: HTTP ${res.status}`);
      say("harness", "Test mode: this script, standing in for the person, placed the hold with the sandbox test card.");
    } else {
      console.log(`\n  A person must approve the money. Open this client link and fund the hold:\n  ${clientLink}\n`);
      say("harness", "Waiting for a person to fund the hold. Neither agent has a tool for this.");
    }
    await waitFor("the hold", async () => ((await worker.tool("get_milestone", { milestone: workerLink })).state === "FUNDED" ? true : undefined));
    say("worker", `$${JOB.amount_usd} is on hold at PayPal, so the money exists. Starting work.`);

    const branch = `agent/roman-${Date.now().toString(36)}`;
    const main = await gh([`repos/${REPO}/git/ref/heads/main`, "--jq", ".object.sha"]);
    await gh(["-X", "POST", `repos/${REPO}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${main}`, "--silent"]);
    const contract = tested.map((c: { id: string; text: string; test: { code: string } }) => `${c.id}: ${c.text}\n${c.test.code}`).join("\n\n");
    let prUrl = "";
    let feedback = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const prompt =
        attempt === 1
          ? `Job: ${JOB.brief}\n\nThe acceptance tests import from this path, so use it:\n${contract}\n\n${FIRST_ATTEMPT}`
          : `Job: ${JOB.brief}\n\nYour last version failed. The tests:\n${contract}\n\nWhat the review said:\n${feedback}\n\nWrite the complete, correct file now.`;
      say("worker", attempt === 1 ? "Attempt 1, told to rush (a demo setting, so the failure path shows)." : `Attempt ${attempt}: fixing it from the verdict.`);
      const file = await writeCode(prompt);
      await commit(branch, file, attempt === 1 ? "Add toRoman" : `Fix toRoman (attempt ${attempt})`);
      if (!prUrl) {
        prUrl = await gh(["-X", "POST", `repos/${REPO}/pulls`, "-f", "title=Add toRoman", "-f", `head=${branch}`, "-f", "base=main", "-f", `body=Written by an AI agent through the Milestone MCP server.\n\nMilestone-Terms: ${read.fingerprint}`, "--jq", ".html_url"]);
        say("worker", `Opened ${prUrl}`);
      }
      await worker.tool("submit_work", { milestone: workerLink, pr_url: prUrl });
      say("worker", "Submitted. GitHub Actions is running the signed tests…");

      const end = await waitFor("the verdict", async () => {
        const s = await worker.tool("get_status", { milestone: workerLink });
        return ["SUBMITTED", "IN_REVIEW"].includes(s.state) ? undefined : s;
      });
      for (const c of end.review?.criteria ?? []) say("fixed rules", `  ${c.id} (${c.kind}) ${c.verdict}`);
      say("fixed rules", `${end.state}: ${(end.review?.reasons ?? []).join("; ")}`);
      if (end.state === "CHANGES_REQUESTED") {
        say("fixed rules", "No money moved. The hold is untouched.");
        feedback = `${(end.review?.reasons ?? []).join("; ")}\n${end.review?.feedback ?? ""}`;
        continue;
      }
      if (end.state === "HUMAN_CHECK") throw new Error("the rules sent this to a person, so the run stops here");

      say("fixed rules", `Passed. The client can object until ${end.releaseAfter}; then code captures the hold.`);
      const paid = await waitFor("the payout", async () => {
        const s = await worker.tool("get_status", { milestone: workerLink });
        return s.state === "PAID_OUT" ? s : ["PAYOUT_FAILED", "CANCELLED", "CONTESTED"].includes(s.state) ? Promise.reject(new Error(`ended in ${s.state}`)) : undefined;
      });
      say("paypal", `Paid the worker $${paid.payout.amountUSD} (${paid.payout.status}, item ${paid.payout.paypalPayoutItem}).`);
      console.log(`\n  Deal room (client view): ${clientLink}\n`);
      return;
    }
    throw new Error(`still failing after ${MAX_ATTEMPTS} attempts`);
  } finally {
    await Promise.allSettled([buyer.close(), worker.close()]);
  }
}

main().catch((err) => {
  console.error(`\nThe run stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
