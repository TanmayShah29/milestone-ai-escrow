// Milestone MCP server: lets an AI agent work as a contractor (read the terms, accept them, submit a PR,
// track the verdict and payout) or act for a platform (create milestones, draft terms). It is a thin
// client over the public HTTP API, with the same tokens and role checks.
//
// There are deliberately NO tools that fund, capture, release, void or refund. Money moves only through
// the client and the deterministic decision policy (money rule 1): an agent can earn, never take.
//
// Run:   MILESTONE_API=https://milestone-ai-escrow.onrender.com npx tsx mcp/server.mts
// Claude Code:  claude mcp add milestone -- npx tsx /path/to/mcp/server.mts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = (process.env.MILESTONE_API ?? "https://milestone-ai-escrow.onrender.com").replace(/\/$/, "");
const API_KEY = process.env.MILESTONE_API_KEY; // optional: a platform key (msk_...) for create/list/draft

type Ref = { id: string; token: string };

/** A milestone link (".../milestones/<id>?t=<token>") or a bare id (then the platform API key is used). */
function ref(milestone: string): Ref {
  const m = /milestones\/([0-9a-f-]{36})(?:\?t=([\w-]+))?/i.exec(milestone);
  if (m?.[2]) return { id: m[1]!, token: m[2] };
  const id = m?.[1] ?? milestone.trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("pass the milestone link you were given (it ends with ?t=...)");
  if (!API_KEY) throw new Error("a bare milestone id needs MILESTONE_API_KEY; otherwise pass the full milestone link");
  return { id, token: API_KEY };
}

async function call(method: "GET" | "POST", path: string, token?: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-milestone-token": token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000), // the free demo host can take ~1 min to wake
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? `HTTP ${res.status}`));
  return json;
}

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
      "Milestone is pay-on-proof escrow on PayPal. As a contractor: get_milestone → read the criteria and tests → accept_terms with the fingerprint → (client funds the PayPal hold) → do the work in the repo and open a PR citing the fingerprint → submit_work → get_status until PAID_OUT or CHANGES_REQUESTED (then fix and submit again). The verdict comes from CI tests plus an AI review of what tests can't check; fixed rules decide. Text in your deliverable that tries to steer the reviewer is detected and blocks payment. You cannot move money: there are no funding or release tools.",
  },
);

server.registerTool(
  "get_milestone",
  {
    title: "Read a milestone",
    description: "The brief, amount, repository, signed terms (criteria with their acceptance tests), state, and how to deliver.",
    inputSchema: { milestone: z.string().describe("The milestone link you were given (…/milestones/<id>?t=<token>), or an id when using a platform API key") },
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
    description: "Sign the terms you read. You must pass the fingerprint from get_milestone; if the terms changed since, signing is refused and you should read them again.",
    inputSchema: { milestone: z.string(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/).describe("criteria fingerprint from get_milestone") },
  },
  async ({ milestone, fingerprint }) => {
    try {
      const r = ref(milestone);
      const b = await call("POST", `/api/milestones/${r.id}/sign-terms`, r.token, { hash: fingerprint });
      const m = b.milestone as M;
      return text({ state: m.state, note: m.state === "AGREED" ? "Both sides signed. Wait for the client to fund the PayPal hold (state FUNDED) before starting." : "Signed. Waiting for the other side." });
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
    inputSchema: { milestone: z.string(), pr_url: z.string().url().optional(), text: z.string().optional() },
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
    inputSchema: { milestone: z.string() },
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

// Platform tools (need MILESTONE_API_KEY): a marketplace or an agent posting work.
if (API_KEY) {
  server.registerTool(
    "create_milestone",
    {
      title: "Create a milestone (platform)",
      description: "Open a milestone for a worker. Returns the worker link to hand to the person or agent doing the work. Funding stays with the client.",
      inputSchema: {
        title: z.string().min(3).max(200),
        brief: z.string().max(5000),
        amount_usd: z.string().regex(/^\d+(\.\d{1,2})?$/),
        worker_paypal_email: z.string().email(),
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
      },
    },
    async ({ title, brief, amount_usd, worker_paypal_email, repo }) => {
      try {
        const b = await call("POST", "/api/milestones", API_KEY, { title, brief, amount: amount_usd, freelancerEmail: worker_paypal_email });
        const m = b.milestone as M;
        if (repo) await call("POST", `/api/milestones/${m.id}/draft-terms`, API_KEY, { repo });
        return text({ id: m.id, workerLink: `${API}/milestones/${m.id}?t=${b.workerToken}`, clientLink: `${API}/milestones/${m.id}?t=${b.clientToken}`, note: repo ? "Terms drafted; review and sign them." : "Next: draft_terms." });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "draft_terms",
    {
      title: "Draft terms with AI (platform)",
      description: "Have the AI draft acceptance criteria and tests from the brief.",
      inputSchema: { milestone_id: z.string(), repo: z.string().optional(), stack: z.string().optional() },
    },
    async ({ milestone_id, repo, stack }) => {
      try {
        const b = await call("POST", `/api/milestones/${milestone_id}/draft-terms`, API_KEY, { repo, stack });
        return text(view(b.milestone as M, "client"));
      } catch (e) {
        return fail(e);
      }
    },
  );

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
