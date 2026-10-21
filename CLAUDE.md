# Milestone: pay-on-proof payments on PayPal

PayPal AI Hackathon 2026 entry (Devpost). **Deadline: Nov 12, 2026 12:00 PM PST (Nov 13, 1:30 AM IST).**
The user is in IST.

**Direction (Oct 21):** a pay-on-proof layer on PayPal. Any platform or AI agent creates a payment that is held on PayPal (authorization hold) and released only when the outcome is proven by a pluggable verifier (tests, an AI judge, a deterministic check). The AI writes and checks the contract; only code moves money. The first use case and reference app is freelance code work: a client funds a milestone, the worker (human **or AI agent**) delivers a GitHub PR, the `code_pr` verifier checks it against criteria both sides agreed up front, and fixed rules then **capture** the hold and **pay out**, or send it back for changes. The current plan, cuts and prize targets are at the top of `docs/MILESTONE_PLAN.md`.

## Key docs (read these before big decisions)
- `docs/MILESTONE_PLAN.md`: states, transitions, API map, build order, demo script (text version of the PDF)
- `PayPal_Sandbox_Guide.md`: how the sandbox behaves, verified by live calls. Section 0 is the current account status
- `Milestone_Project_Plan.pdf`: the same plan with diagrams, for humans
- `PayPal_AI_Hackathon_2026.md`: rules, judging criteria, prizes
- `agent-toolkit/`: cloned `paypal/agent-toolkit` v1.11.0, **reference only**, not part of our app (gitignored)

## Repo
GitHub: https://github.com/TanmayShah29/milestone-ai-escrow (public; no code or license yet). Add an MIT LICENSE during setup.

## Stack (confirmed Oct 20)
- Render MCP is connected: workspace "Tanmay's workspace" (`tea-dbbntvgn74is73daou00`). No services yet as of Oct 20. $50 hackathon credit applied: keep to a small web service + small Postgres
- Next.js + TypeScript (app router), Postgres, deployed on **Render** (web service + Render Workflows for agent jobs)
- AI: **free models on OpenRouter** through the Vercel AI SDK with the OpenRouter provider. The model is an env setting (`AI_MODEL`), never hard-coded. Key is in `.env` as `OPENROUTER_API_KEY`
  - Tested Oct 20: `AI_MODEL=minimax/minimax-m3.1-flash:free` (fast, 1M context, valid JSON). `AI_MODEL_FALLBACK=nvidia/nemotron-3.5-super-vl:free` (a reasoning model: set max_tokens to 1500 or more, or the content comes back empty). `AI_MODEL_FALLBACK_2=google/gemma-4-31b-it:free` (often 429s from a shared upstream pool). `nvidia/nemotron-3-super-120b-a12b:free` is broken (provider 404)
  - The AI client must fall through primary, then fallback, then fallback 2 on 404, 429 or 5xx. Check with `./scripts/ai-check.sh`
  - Free limit: 20 requests/min and **50/day** (1,000/day once $10 of credit has ever been bought). Keep a review to **1–2 calls**: pass the diff, files and CI status in the prompt, then one structured-output call. Don't build multi-step tool loops
  - Cache verdicts in the DB, and never re-review the same commit. Handle 429s with a clear "AI busy, retry" state, not a crash
  - Use a different free model for each agent if the daily cap bites (e.g. criteria writer on gemma, reviewer on nemotron)
- APIMatic Context Plugin is installed (user scope, as `paypal@context-plugins`). For any PayPal server-SDK code, **load `paypal:typescript-integrate-paypal` first**. It requires a `paypal-plan.md` contract sheet at the repo root before editing project files. Use the SDK for orders, payments, vault and subscriptions where it covers them; this usage counts toward the APIMatic prize
- `@paypal/agent-toolkit` for orders, refunds and disputes. Small typed REST functions for authorize, void, reauthorize, payouts and webhook verification (the toolkit doesn't have these)
- **Bryntum Gantt** for the milestone and payment timeline (the main sponsor-prize target). **APIMatic** Context Plugin while coding

## PayPal sandbox facts
- REST base: `https://api-m.sandbox.paypal.com`. `scripts/paypal-token.sh` prints a fresh OAuth token from `.env` (lasts about 9 h)
- App "hackathon2" (`APP-8H366052M49310022`, created Oct 20 to replace "hackathon") is linked to the **US** business account. As of Oct 20 everything works (orders, cards, card vault, payouts, refunds, subscriptions, disputes, invoicing, transaction search) **except** PayPal-wallet vault (limited release). Re-check with `./scripts/sandbox-check.sh [--deep]`
- Sandbox account emails (fake, safe to share; never store passwords here): business/platform `sb-47hvxh49451990@business.example.com`; freelancer `sb-puo47p53461265@personal.example.com` (a $1 payout reached SUCCESS on Oct 20); client `sb-eg47t53461254@personal.example.com` (US personal, created Oct 20; a $1 payout reached SUCCESS). The user holds the passwords. The client logs in with them at sandbox.paypal.com to approve holds
- Sandbox roles: Business = the platform. Personal #1 = the client (approves holds at sandbox.paypal.com). Personal #2 = the freelancer (receives payouts)
- A human must approve each hold in the browser. No API can approve on the buyer's behalf
- Holds: 3-day honor period, valid 29 days. Reauthorize after day 3. Refunds need the **capture id**
- Force errors with the `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}` header

## Current status (updated Oct 21, end of session)
**Phases 0–5 of `docs/MILESTONE_PLAN.md` are done and live.** Next: README + submission polish, then the demo video. Feature freeze Nov 6.
- **Live app:** https://milestone-ai-escrow.onrender.com (Render free web service `srv-dbbpughjfumc73d08ia0`, auto-deploys from `main`; `/api/health` reports the live commit). Workspace `tea-dbbntvgn74is73daou00`. The user will not add a card anywhere: free tiers only.
- **DB:** Neon free (project `milestone` / `ancient-bonus-35699012`, branch `production`, never expires). Local dev: Postgres 14 DBs `milestone` and `milestone_test`. Migrations run at startup (`npm run db:migrate`).
- **Render env:** `DATABASE_URL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN` (fine-grained, PR read/write on milestone-demo only; fine-grained tokens have no Checks permission and public check runs need none) were pasted by the user. Non-secret vars (`APP_URL`, `PAYPAL_ENVIRONMENT`, `PAYPAL_WEBHOOK_ID=2JC020923H9067634`, `AI_MODEL*`, `AI_DAILY_CAP=40`, `PLATFORM_FEE_BPS`, `NODE_VERSION`, `ALLOW_DEV_ACTIONS=1`) were set through the Render MCP. Turn `ALLOW_DEV_ACTIONS` off before submission.
- **Demo repo:** https://github.com/TanmayShah29/milestone-demo has a `milestone` workflow that runs the signed acceptance tests per criterion. Real paid runs: PR #1 (paid), #2 (prompt injection caught, then fixed and paid), #3 (an AI agent via MCP, paid).
- **Design:** `PRODUCT.md`, `DESIGN.md`, `docs/design/deal-room.brief.md` ("Security print"). Skills in `.claude/skills/`: `frontend-design`, `impeccable`. Impeccable's binary launcher is **not** run (it downloads a binary); ask the user before enabling it.
- **Verification tools:** Playwright + headless Chromium are installed (`node_modules/playwright`) for screenshots. The Claude in Chrome extension was not connected on Oct 21.
- **Key code:** money flow `src/lib/money/flow.ts` (claims, locks, unknown-outcome settling), contract `src/lib/contract/terms.ts`, verifiers and policy `src/lib/review/`, webhooks `src/lib/money/webhooks.ts`, MCP server `mcp/server.mts`, judge mode `src/lib/demo.ts` + `/demo`, Gantt `src/app/timeline/`.
- **Open user actions:** (1) set up a free keep-awake pinger (cron-job.org, every 10 min) on `/api/tick`; (2) post the Bryntum hackathon-license request in the PayPal Discord (https://discord.gg/sJ2G6DyvSK); remind them before the video; (3) around Nov 9–11, submit APIMatic's usage form (link in the checklist below).

## Money rules (do not break these)
1. **The AI never moves money.** Model output is a recommendation. Only deterministic code applies the decision policy and calls capture, void, payout or refund. Never expose those calls as tools the model can use.
2. Every money-moving POST sends a `PayPal-Request-Id` idempotency key, derived from the milestone id and the action.
3. Never capture more than the authorized amount. Payout = captured amount minus the platform fee.
4. Store every PayPal id (order, authorization, capture, payout batch and item, refund, dispute) on the milestone row.
5. Every state change writes an audit-log row: who or what caused it, and the PayPal response id.
6. Webhooks: verify the signature (`/v1/notifications/verify-webhook-signature`) before acting. Handlers must be idempotent.
7. Amounts are decimal strings in PayPal calls (`"300.00"`) and integer cents in our DB. USD only.

## Secrets
- `.env` holds `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT`, `OPENROUTER_API_KEY`, `AI_MODEL`, `AI_MODEL_FALLBACK`, `AI_MODEL_FALLBACK_2`. Claude's permissions block reading `.env` (and `.env.local`, `.env.production` etc.; `.env.example` is readable): give the user the exact lines to add, and use scripts that `source .env` (`scripts/paypal-token.sh`, `scripts/sandbox-check.sh`, `scripts/ai-check.sh`) to use the values. Never print, log or commit secrets or tokens. Use `.env.example` for names only.

## Working preferences
- The user has limited usage. Be efficient: prefer targeted reads, batch tool calls, and don't re-fetch docs already summarised in the files above.
- Verify PayPal behavior with a real sandbox call before claiming it works. Record new findings in `PayPal_Sandbox_Guide.md` and tag them [VERIFIED] or [DOCS].
- Before writing AI code, check the current free model list (`curl -s https://openrouter.ai/api/v1/models`, filter ids ending `:free` with `tools` in `supported_parameters`). Free models get added and removed without notice.
- Keep scope tight: code (PR) deliverables only. Design and document review are roadmap.

## Submission checklist (from the official rules)
- [ ] Public GitHub repo with an OSS license visible in the About section
- [ ] README: what it does, PayPal APIs and AI used, setup steps, sandbox test logins for client and freelancer
- [ ] Working hosted demo (Render URL) or complete run instructions
- [ ] YouTube demo video under 3 minutes, showing it working end to end. No copyrighted music
- [ ] Devpost text description, plus which tools and models were used and how
- [ ] **Remind the user:** once the project is built (about Nov 9–11), submit APIMatic's usage form to show we used the Context Plugin: https://docs.google.com/forms/d/e/1FAIpQLScc2oCgAFACm7d6H3R4mgzv-O34DdyVnLIBNiwmUNggr_-hhA/viewform
- [ ] Sponsor credit: README, Devpost text and video name APIMatic Context Plugin (used to build the PayPal integration; no APIMatic account needed), Bryntum (Gantt) and Render (hosting + Workflows)
