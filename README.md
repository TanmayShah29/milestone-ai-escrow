# Milestone: pay-on-proof payments on PayPal

Money is held on PayPal and released only when the work is proven. The client's payment is a PayPal
**authorization hold**. The AI turns the brief into acceptance criteria and **compiles them into tests**;
both sides sign the terms' SHA-256 fingerprint, which is written into the PayPal order. The worker (a
person **or an AI agent**) opens a PR; CI runs the signed tests, the AI reviews only what tests can't check,
and **fixed rules, never the model**, decide: capture and pay out after an objection window, or request
changes. Prompt injection in a deliverable is detected and blocks payment.

Built for the PayPal AI Hackathon 2026. Live: https://milestone-ai-escrow.onrender.com (free tier: the first
load can take about a minute). Demo repo with real funded PRs: https://github.com/TanmayShah29/milestone-demo

## Stack
- Next.js 15 (app router) + TypeScript, Postgres
- PayPal server SDK (TypeScript, APIMatic-generated) for orders and payments; REST for payouts
- Built with the APIMatic Context Plugin in Claude Code
- Hosting: Render (planned)

## Run locally
```bash
npm install
cp .env.example .env        # fill in PayPal sandbox + OpenRouter keys
createdb milestone
npm run db:migrate
npm run dev                 # http://localhost:3000
```

Tests (uses a separate `milestone_test` database, PayPal faked at the fetch layer):
```bash
createdb milestone_test
npm test
```

## For AI agents: the Milestone MCP server

An AI agent can work as the contractor: read the signed terms, accept them, open a PR, submit it and get
paid, all through MCP tools. There are **no tools that fund, capture, release or refund**: an agent can
earn, never take.

```bash
# Claude Code (this repo's .mcp.json already registers it)
claude mcp add milestone -- npx tsx /path/to/milestone-ai-escrow/mcp/server.mts
```

| Tool | What it does |
|---|---|
| `get_milestone` | Brief, amount, repo, signed criteria with their acceptance tests, fingerprint, how to deliver |
| `accept_terms` | Sign the terms by fingerprint (refused if they changed since you read them) |
| `submit_work` | Submit the PR URL (or text for text deliverables) |
| `get_status` | Verdict per criterion, feedback, objection window, payout |
| `create_milestone`, `draft_terms`, `list_milestones` | Platform tools, with `MILESTONE_API_KEY` set |

Give the agent the milestone's **worker link** (`…/milestones/<id>?t=mwt_…`). Verified Oct 21: an agent
completed [milestone-demo#3](https://github.com/TanmayShah29/milestone-demo/pull/3) through MCP and was
paid $14.25 on PayPal sandbox.

## HTTP API

Every action is `POST /api/milestones/:id/:action` with the caller's milestone link token in
`x-milestone-token` (or a platform key `msk_…` as `Authorization: Bearer`). Actions: `draft-terms`,
`edit-terms`, `sign-terms`, `fund`, `fund-card`, `submit`, `check`, `approve`, `request-changes`,
`object`, `release`, `cancel`, `sync`. Also `GET /api/contracts/:fingerprint` (the locked contract CI
runs), `GET /api/status` (AI budget) and `GET /api/tick` (moves milestones forward; ping it every few
minutes).

## Money rules
1. The AI never moves money. Only deterministic code calls capture, void, payout or refund.
2. Every money-moving call sends a `PayPal-Request-Id` derived from the milestone and action, and is
   claimed in the DB first, so a double click or a retry can't move money twice.
3. Never capture more than was authorized. Payout = captured minus the platform fee.
4. Every PayPal id is stored on the milestone; every state change writes an audit-log row.

See `paypal-plan.md` for the full contract (idempotency, unknown-outcome handling, error mapping).

## License
MIT
