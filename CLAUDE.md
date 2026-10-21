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

## Setup items still open (found in the Oct 20 audit)
- **Repo layout**: the local folder isn't a git repo, and GitHub `milestone-ai-escrow` is empty. Proposed: make `/Users/tanmay/Paypal` the repo root (Next.js app at the root; docs/, scripts/, CLAUDE.md committed; agent-toolkit/ and .env gitignored). Confirm with the user before `git init`
- **Local DB**: Homebrew PostgreSQL 14 is installed but not running. Start it with `brew services start postgresql@14` (ask first), create a `milestone` DB, and have the user add `DATABASE_URL=postgres://localhost:5432/milestone` to `.env`
- **GITHUB_TOKEN** (needed at the reviewer step): ask the user for a fine-grained, read-only token for public repos, added to `.env`. Don't reuse the gh CLI token (it has full `repo` scope)
- **Render**: done Oct 20. Free web service `milestone-ai-escrow` (`srv-dbbpughjfumc73d08ia0`, https://milestone-ai-escrow.onrender.com). The user will not add a card: free tiers only. The production DB is **Neon** free tier (project `milestone` / `ancient-bonus-35699012`, branch `production`, Oregon, never expires), live since Oct 21. The unused Render free Postgres (`dpg-dbbpubbrjlhs73eqglbg-a`) expires on its own Nov 19. Secrets (`DATABASE_URL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) are pasted by the user in the Render dashboard; non-secret env vars can be set through the Render MCP
- **Bryntum trial**: start around Nov 1 (the 45-day trial must outlast judging, which ends Dec 15)

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
