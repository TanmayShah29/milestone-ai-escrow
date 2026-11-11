// Milestone MCP server: lets an AI agent work as a contractor (read the terms, accept them, submit a PR,
// track the verdict and payout) or act for a platform (create milestones, draft terms). It is a thin
// client over the public HTTP API, with the same tokens and role checks.
//
// There are deliberately NO tools that capture, release, void or refund. Money moves only through the client
// and the deterministic decision policy (money rule 1): an agent can earn, never take. The one exception is
// post_bounty, offered only with a mandate key (MILESTONE_MANDATE_KEY, mmd_...): the agent chooses what to
// post, and fixed code funds the hold only within the limits a person signed with a passkey.
//
// Run:   MILESTONE_API=https://milestone-ai-escrow.onrender.com npx tsx mcp/server.mts
// Claude Code:  claude mcp add milestone -- npx tsx /path/to/mcp/server.mts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { termsStatement, toB64url, type Role } from "../src/lib/proof/verify.ts";

const API = (process.env.MILESTONE_API ?? "https://milestone-ai-escrow.onrender.com").replace(/\/$/, "");
const API_KEY = process.env.MILESTONE_API_KEY; // optional: a platform key (msk_...) adds list_milestones and id-only access
const MANDATE_KEY = process.env.MILESTONE_MANDATE_KEY; // optional: a mandate's agent key (mmd_...) adds post_bounty

type Ref = { id: string; token: string };

/** A milestone link (".../milestones/<id>?t=<token>") or a bare id (then the platform API key is used). */
function ref(milestone: string): Ref {
  const m = /milestones\/([0-9a-f-]{36})(?:\?t=([\w-]+))?/i.exec(milestone);
  if (m?.[2]) return { id: m[1]!, token: m[2] };
  const id = m?.[1] ?? milestone.trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Pass the milestone link you were given (it ends with ?t=...).");
  if (!API_KEY) throw new Error("This link is missing its ?t= token. Paste the full worker link.");
  return { id, token: API_KEY };
}

async function call(method: "GET" | "POST", path: string, token?: string, body?: unknown, extra: Record<string, string> = {}) {
  const auth = !token ? {} : token.startsWith("mmd_") ? { authorization: `Bearer ${token}` } : { "x-milestone-token": token };
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...auth, ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(420_000), // the free host can take ~1 min to wake, and an AI attack can try every model twice
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? `HTTP ${res.status}`));
  return json;
}

// This agent's own signing key (ES256), made on first use and kept on disk, so its signatures on terms
// can be checked by anyone and tie its milestones together. MILESTONE_AGENT_KEY_FILE overrides the path.
const KEY_FILE = process.env.MILESTONE_AGENT_KEY_FILE ?? join(homedir(), ".config", "milestone", "agent-key.json");
const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
let agentKey: Promise<{ key: CryptoKey; jwk: JsonWebKey }> | undefined;
function loadAgentKey() {
  agentKey ??= (async () => {
    let jwk: JsonWebKey;
    try {
      jwk = JSON.parse(readFileSync(KEY_FILE, "utf8")) as JsonWebKey;
    } catch {
      const pair = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
      jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
      mkdirSync(dirname(KEY_FILE), { recursive: true });
      writeFileSync(KEY_FILE, JSON.stringify(jwk), { mode: 0o600 });
    }
    const key = await crypto.subtle.importKey("jwk", jwk, ALG, false, ["sign"]);
    return { key, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
  })();
  return agentKey;
}

async function agentSignature(milestoneId: string, role: Role, hash: string, githubLogin: string | undefined) {
  const { key, jwk } = await loadAgentKey();
  const statement = termsStatement(milestoneId, role, hash, githubLogin?.trim().replace(/^@/, "") || null, "-");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(statement));
  return { jwk, signature: toB64url(sig) };
}

const WRONG_FINGERPRINT = "That fingerprint doesn't match these terms. Call get_milestone and use its fingerprint.";
/** The link argument every worker tool takes. */
const milestoneArg = z.string().describe("The milestone link you were given (…/milestones/<id>?t=<token>), or an id when using a platform API key");

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true });

type M = Record<string, unknown> & { id: string; state: string; criteria?: { criteria: unknown[]; testCommand?: string } | null; criteria_hash?: string | null };

function view(m: M, role: unknown) {
  return {
    id: m.id,
    yourRole: role,
    title: m.title,
    brief: m.brief,
    amountUSD: typeof m.amount_cents === "number" ? (m.amount_cents / 100).toFixed(2) : null,
    state: m.state,
    repo: m.repo,
    fingerprint: m.criteria_hash,
    criteria: m.criteria?.criteria ?? [],
    testCommand: m.criteria?.testCommand ?? null,
    signed: { client: !!m.criteria_hash && m.client_signed_hash === m.criteria_hash, worker: !!m.criteria_hash && m.worker_signed_hash === m.criteria_hash },
    howToDeliver:
      m.verifier === "rubric_text"
        ? "Call submit_work with the deliverable text."
        : `Open a pull request in ${m.repo ?? "the repository"} that makes every acceptance test pass, with this exact line in the PR description: "Milestone-Terms: ${m.criteria_hash}". Do not edit .github/ or acceptance/ (CI overwrites acceptance/ with the signed tests). Then call submit_work with the PR URL.`,
  };
}

const server = new McpServer(
  { name: "milestone", version: "1.0.0" },
  {
    instructions:
      "Milestone is pay-on-proof escrow on PayPal. To find work: list_bounties → claim_bounty (returns your worker link). As a contractor: get_milestone → read the criteria and tests → accept_terms with the fingerprint → (client funds the PayPal hold) → do the work in the repo and open a PR citing the fingerprint → submit_work → get_status until PAID_OUT or CHANGES_REQUESTED (then fix and submit again). The verdict comes from CI tests plus an AI review of what tests can't check; fixed rules decide. Text in your deliverable that tries to steer the reviewer is detected and blocks payment. You cannot move money: there are no capture, release or refund tools, and post_bounty (only with a mandate key) funds holds solely within limits a person signed.",
  },
);

server.registerTool(
  "get_milestone",
  {
    title: "Read a milestone",
    description: "The brief, amount, repository, signed terms (criteria with their acceptance tests), state, and how to deliver.",
    inputSchema: { milestone: milestoneArg },
    annotations: { readOnlyHint: true },
  },
  async ({ milestone }) => {
    try {
      const r = ref(milestone);
      const b = await call("GET", `/api/milestones/${r.id}`, r.token);
      return text(view(b.milestone as M, b.role));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "accept_terms",
  {
    title: "Accept the terms",
    description:
      "Sign the terms you read, with this agent's own key (made on first use, kept on disk), so anyone can check that you signed exactly these terms. You must pass the fingerprint from get_milestone; if the terms changed since, signing is refused and you should read them again. As the worker, pass github_login: only a pull request opened from that account can be submitted.",
    inputSchema: {
      milestone: milestoneArg,
      fingerprint: z.string().regex(/^[0-9a-f]{64}$/, WRONG_FINGERPRINT).describe("The `fingerprint` field from get_milestone (64 hex characters)"),
      github_login: z.string().max(40).optional().describe("Worker only: the GitHub account you will open the pull request from"),
    },
  },
  async ({ milestone, fingerprint, github_login }) => {
    try {
      const r = ref(milestone);
      // Compare first so a stale or mistyped fingerprint gets a message that says what to do.
      const got = await call("GET", `/api/milestones/${r.id}`, r.token);
      const current = got.milestone as M;
      if (current.criteria_hash !== fingerprint) throw new Error(WRONG_FINGERPRINT);
      const role = got.role === "client" ? "client" : "worker";
      const login = role === "worker" ? github_login : undefined;
      const agent = await agentSignature(r.id, role, fingerprint, login);
      const b = await call("POST", `/api/milestones/${r.id}/sign-terms`, r.token, { hash: fingerprint, agent, ...(login ? { githubLogin: login } : {}) }).catch((e: unknown) => {
        // The terms changed between the read above and the signature.
        throw e instanceof Error && /terms changed since/i.test(e.message) ? new Error(WRONG_FINGERPRINT) : e;
      });
      const m = b.milestone as M;
      return text({
        state: m.state,
        signedWith: "this agent's key (checkable on the proof page)",
        proof: `${API}/proof/${r.id}`,
        note: m.state === "AGREED" ? "Both sides signed. Wait for the client to fund the PayPal hold (state FUNDED) before starting." : "Signed. Waiting for the other side.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "submit_work",
  {
    title: "Submit the deliverable",
    description: "Submit a GitHub pull request URL (code milestones) or the deliverable text (text milestones). Allowed once the milestone is FUNDED, or after CHANGES_REQUESTED.",
    inputSchema: {
      milestone: milestoneArg,
      pr_url: z.string().url().optional().describe("Code milestones: the pull request URL (https://github.com/<owner>/<repo>/pull/<n>)"),
      text: z.string().optional().describe("Text milestones: the full deliverable text"),
    },
  },
  async ({ milestone, pr_url, text: deliverable }) => {
    try {
      const r = ref(milestone);
      const b = await call("POST", `/api/milestones/${r.id}/submit`, r.token, { ...(pr_url ? { prUrl: pr_url } : {}), ...(deliverable ? { text: deliverable } : {}) });
      return text({ state: (b.milestone as M).state, next: "CI runs the signed tests on the PR. Call get_status in a minute or two." });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_status",
  {
    title: "Check the verdict and payout",
    description: "Moves the milestone forward if possible (review once CI finishes, release once the objection window passes) and returns the state, the per-criterion verdict, feedback, and the payout.",
    inputSchema: { milestone: milestoneArg },
  },
  async ({ milestone }) => {
    try {
      const r = ref(milestone);
      await call("POST", `/api/milestones/${r.id}/check`, r.token).catch(() => undefined); // best effort nudge
      const b = await call("GET", `/api/milestones/${r.id}`, r.token);
      const m = b.milestone as M;
      const review = b.review as { status: string; decision: string | null; reasons: string[] | null; verdict: { criteria: unknown[]; feedbackForWorker: string; injection: { detected: boolean } } | null } | null;
      return text({
        state: m.state,
        review: review && {
          status: review.status,
          decision: review.decision,
          reasons: review.reasons,
          criteria: review.verdict?.criteria,
          feedback: review.verdict?.feedbackForWorker,
          injectionDetected: review.verdict?.injection.detected,
        },
        releaseAfter: m.release_after,
        payout: m.payout_cents != null ? { amountUSD: ((m.payout_cents as number) / 100).toFixed(2), status: m.payout_status, paypalPayoutItem: m.paypal_payout_item_id } : null,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

// Posting work: a marketplace or an agent acting for a client. A platform key is optional, as on the website.
server.registerTool(
  "create_milestone",
  {
    title: "Create a milestone",
    description: "Open a milestone for a worker. Returns the worker link to hand to the person or agent doing the work, and the client link for signing. Funding stays with a person: there is no tool for it.",
    inputSchema: {
      title: z.string().min(3).max(200).describe("Short name of the work"),
      brief: z.string().max(5000).describe("What the client wants done; the AI drafts the criteria and tests from it"),
      amount_usd: z.string().regex(/^\d+(\.\d{1,2})?$/).describe('Amount in US dollars, e.g. "300.00"'),
      worker_paypal_email: z.string().email().describe("The PayPal email the worker is paid to"),
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional().describe('GitHub repository "owner/repo" for code work; when given, terms are drafted right away'),
    },
  },
  async ({ title, brief, amount_usd, worker_paypal_email, repo }) => {
    try {
      const b = await call("POST", "/api/milestones", API_KEY, { title, brief, amount: amount_usd, freelancerEmail: worker_paypal_email });
      const m = b.milestone as M;
      if (repo) await call("POST", `/api/milestones/${m.id}/draft-terms`, API_KEY ?? (b.clientToken as string), { repo });
      return text({ id: m.id, workerLink: `${API}/milestones/${m.id}?t=${b.workerToken}`, clientLink: `${API}/milestones/${m.id}?t=${b.clientToken}`, note: repo ? "Terms drafted; review and sign them." : "Next: draft_terms." });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "draft_terms",
  {
    title: "Draft terms with AI",
    description: "Have the AI draft acceptance criteria and tests from the brief, or rewrite tests that can't be signed yet.",
    inputSchema: {
      milestone: z.string().describe("The client link from create_milestone, or its id when using a platform API key"),
      repo: z.string().optional().describe('GitHub repository "owner/repo" the work happens in'),
      stack: z.string().optional().describe('Language and test setup, e.g. "TypeScript, node:test"'),
    },
  },
  async ({ milestone, repo, stack }) => {
    try {
      const r = ref(milestone);
      const b = await call("POST", `/api/milestones/${r.id}/draft-terms`, r.token, { repo, stack });
      return text(view(b.milestone as M, "client"));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "attack_terms",
  {
    title: "Attack the terms with AI",
    description: "Before signing: a second AI writes fake code that tries to pass the must-have tests without doing the work, and code runs it. Strengthens the tests if the fake wins, which changes the fingerprint, so call get_milestone afterwards.",
    inputSchema: { milestone: z.string().describe("The client link from create_milestone, or its id when using a platform API key") },
  },
  async ({ milestone }) => {
    try {
      const r = ref(milestone);
      const b = await call("POST", `/api/milestones/${r.id}/attack-terms`, r.token);
      const { attack } = ((b.milestone as M).criteria ?? {}) as { attack?: unknown };
      return text({ fingerprint: (b.milestone as M).criteria_hash, attack: attack ?? null });
    } catch (e) {
      return fail(e);
    }
  },
);

type Bounty = { id: string; title: string; brief: string; amountCents: number; repo: string | null; dueAt: string; postedBy: string; termsHash: string; document: string };

server.registerTool(
  "list_bounties",
  {
    title: "List open bounties",
    description: "Funded bounties anyone can claim: the amount held on PayPal, the repository, the due date, and the signed terms (criteria and acceptance tests) with their fingerprint.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const b = await call("GET", "/api/bounties");
      return text(
        (b.bounties as Bounty[]).map((x) => {
          const doc = JSON.parse(x.document) as { criteria: unknown[]; testCommand: string | null };
          return { id: x.id, title: x.title, brief: x.brief, amountUSD: (x.amountCents / 100).toFixed(2), repo: x.repo, dueAt: x.dueAt, postedBy: x.postedBy, fingerprint: x.termsHash, criteria: doc.criteria, testCommand: doc.testCommand };
        }),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "claim_bounty",
  {
    title: "Claim a bounty",
    description:
      "Take an open bounty: sign its terms with this agent's key as the GitHub account you will open the pull request from, and name the PayPal email the payment goes to. The first valid claim takes it. You then have 3 days to submit a pull request (submit_work with the returned link), or the claim lapses and the bounty reopens.",
    inputSchema: {
      bounty: z.string().regex(/^[0-9a-f-]{36}$/i).describe("The bounty id from list_bounties"),
      fingerprint: z.string().regex(/^[0-9a-f]{64}$/, WRONG_FINGERPRINT).describe("The bounty's fingerprint from list_bounties"),
      github_login: z.string().max(40).describe("The GitHub account you will open the pull request from"),
      paypal_email: z.string().email().describe("The PayPal email the payment should go to"),
    },
  },
  async ({ bounty, fingerprint, github_login, paypal_email }) => {
    try {
      const login = github_login.trim().replace(/^@/, "");
      const agent = await agentSignature(bounty, "worker", fingerprint, login);
      const b = await call("POST", `/api/bounties/${bounty}/claim`, undefined, { githubLogin: login, paypalEmail: paypal_email, hash: fingerprint, agent });
      return text({ state: (b.milestone as M).state, workerLink: `${API}/milestones/${bounty}?t=${b.workerToken as string}`, claimLine: b.claimLine, note: "Keep this link: it is your worker link for get_milestone, submit_work and get_status. Open the pull request from the GitHub account you named, with both the Milestone-Terms line and this claimLine in its description, and submit it within 3 days." });
    } catch (e) {
      return fail(e);
    }
  },
);

if (MANDATE_KEY) {
  server.registerTool(
    "post_bounty",
    {
      title: "Post a bounty (within your mandate)",
      description:
        "Post and fund a bounty under the spending mandate a person signed: fixed code checks the amount, repository, budget and open-bounty limit, then puts a hold on the mandate's saved card. You choose what to buy; you can't capture, release or refund anything. Criteria use the same shape as the terms: [{ id: 'C1', text, kind: 'must'|'nice', check: 'test'|'review', test?: { path: 'acceptance/c1.test.ts', code } }].",
      inputSchema: {
        title: z.string().max(200),
        brief: z.string().max(5000).optional(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/).describe("USD, like 50.00"),
        repo: z.string().describe("owner/name, one the mandate allows"),
        criteria: z.array(z.record(z.string(), z.unknown())).min(1).max(8),
        test_command: z.string().max(200).optional(),
        due_date: z.string().optional().describe("ISO date-time, inside the hold's 29 days"),
      },
    },
    async ({ title, brief, amount, repo, criteria, test_command, due_date }) => {
      try {
        const body = { title, brief, amount, repo, criteria, ...(test_command ? { testCommand: test_command } : {}), ...(due_date ? { dueDate: due_date } : {}) };
        // The same request retried is the same bounty, not a second hold.
        const key = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(body)))).toString("hex").slice(0, 64);
        const b = await call("POST", "/api/bounties", MANDATE_KEY, body, { "idempotency-key": key });
        return text({ ...(b.bounty as Record<string, unknown>), listed: `${API}/bounties` });
      } catch (e) {
        return fail(e);
      }
    },
  );
}

if (API_KEY) {
  server.registerTool(
    "list_milestones",
    { title: "List my milestones (platform)", description: "Milestones this platform created.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => {
      try {
        const b = await call("GET", "/api/milestones", API_KEY);
        return text((b.milestones as M[]).map((m) => ({ id: m.id, title: m.title, state: m.state, amountUSD: ((m.amount_cents as number) / 100).toFixed(2) })));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

await server.connect(new StdioServerTransport());
