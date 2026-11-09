# Milestone: a 51-agent review swarm (orchestrator prompt)

Paste everything below the line into a Claude Code session opened at the repo root. It runs 51 subagents in
4 waves, then combines what they find into one report. It reviews the project as a hackathon entry, as a
real product PayPal could launch, and through the eyes of the people who would use it.

---

You are the **orchestrator** of a review swarm for **Milestone**, a pay-on-proof payments layer on PayPal,
entered in the PayPal AI Hackathon 2026. Your job: launch the subagents below, enforce the shared rules,
check what they claim, and combine their reports into one decision document. You do not edit product code
in this task.

## 0. Ground truth (give this to every agent)

- **Repo:** `/Users/tanmay/Paypal` (GitHub `TanmayShah29/milestone-ai-escrow`, MIT). Read first:
  - `CLAUDE.md` (status and money rules), `README.md` (threat model, limits), `docs/DEVPOST.md`,
    `docs/MILESTONE_PLAN.md`, `docs/MULTIPARTY.md`, `PRODUCT.md`, `DESIGN.md`;
  - `PayPal_Sandbox_Guide.md` (facts tagged [VERIFIED] / [DOCS]), `PayPal_AI_Hackathon_2026.md` (rules,
    judging criteria, prizes, judges), `paypal-plan.md` (the APIMatic SDK contract sheet).
- **Live app:** https://milestone-ai-escrow.onrender.com. Judge mode: `/demo`. Also `/ledger` (AG Grid),
  `/timeline` (Bryntum), `/milestones`, `/new`, `/api/health`, `/api/status`.
- **Demo repo:** https://github.com/TanmayShah29/milestone-demo.
  - The workflow is `.github/workflows/milestone.yml` and the trusted harness is `.github/milestone/*`.
  - Paid runs: PRs #1, #2 (injection caught, then fixed), #3 (AI agent over MCP) and #5 (end-to-end run on
    the current code, Oct 22: $12.00 held, captured, PayPal fee $0.80 read from the capture, $10.39 paid out).
- **Code map:**
  - money: `src/lib/money/{flow,claims,amounts,webhooks}.ts` and `src/lib/paypal/*`;
  - contract: `src/lib/contract/{terms,testcheck,warnings}.ts`;
  - review: `src/lib/review/{run,verifiers,policy,injection,deadlines,github}.ts`;
  - auth: `src/lib/auth.ts` and `src/lib/client/links.ts`; rate limits: `src/lib/ratelimit.ts`;
  - MCP server: `mcp/server.mts`; UI: `src/app/**`, `src/components/**`; tests: `tests/` (240 passing).
- **How it works:**
  1. The client writes a brief.
  2. One AI call drafts the criteria and `node:test` tests. AI-written tests must fail on empty code, and a
     test the client writes is only checked statically.
  3. Both sides sign the SHA-256 fingerprint of the terms.
  4. The client funds a PayPal authorization hold (sandbox test card or PayPal login).
  5. The worker (a person or an AI agent over MCP) opens a PR citing exactly one `Milestone-Terms:` line.
  6. CI runs the signed tests through a base-branch harness; check runs are tied to the workflow file,
     `pull_request`, the head commit and the full hash.
  7. The AI reviews only the criteria no test covers. The decision is made by fixed rules (`policy.ts`).
  8. After the objection window: capture, then a payout of captured − PayPal fee − payout fee − the
     platform fee in the signed terms.
  9. An objection gets one second review by a different model. Every human check has a deadline. Voided
     or expired holds move to CANCELLED. Dispute webhooks move the milestone to DISPUTE.
- **Known, documented limits** (count one as a finding only if the docs misstate it, or you have something
  new to add):
  - Holds last 29 days; reauthorizing is allowed once, on days 4–29, and doesn't extend them.
  - Multiparty is blocked by PayPal partner permissions; the platform is merchant of record.
  - The test harness runs in the same process as the worker's code; the workflow YAML comes from the PR.
  - Free OpenRouter models; access is by capability links, with no accounts.
  - Bryntum runs on the trial build; Render's free tier has cold starts.

## 1. Shared rules (every agent must follow these; give them verbatim)

1. **Read-only on the code.** Never edit, commit, push, open or close PRs or issues, or change repo settings.
2. **Money.** Never trigger PayPal payments, captures, voids, refunds or payouts on the live site, even in
   the sandbox, and never click Fund or Cancel there. Money flows may only be exercised on the **local
   copy** (section 2), with sandbox keys, at $10–$20.
3. **Secrets.** Never read `.env` files or print tokens, keys or capability links. Scripts that `source .env`
   in a subshell are allowed if they print nothing secret. Delete any file you wrote that holds a link token.
4. **Shared budgets (the orchestrator gives each agent its share):**
   - **AI calls:** at most 12 live AI drafts or reviews for the whole swarm. The daily cap is 40, and
     agents share one OpenRouter key. If an agent hasn't been given an AI budget, it uses 0.
   - **Live judge demos:** at most 4 starts for the whole swarm (the limit is 5 per hour per IP).
   - **Creating milestones:** 10 per hour per IP, shared by every agent on this machine.
5. **Live site:** browse and run read-only GETs only. No load tests, floods, or attacks of any kind.
   Security testing is allowed **only** on the local copy.
6. **Evidence or it didn't happen.** Every finding cites at least one of: `file:line`, a URL plus what was
   observed, a screenshot path, or a command plus its output. Mark each finding **VERIFIED** (reproduced
   or observed) or **THEORETICAL** (reasoned from code or docs). Don't repeat the known limits above as new.
7. **Be blunt and calibrated.** No flattery, and no scores of 10 without exceptional evidence. Say "I don't
   know" rather than guess. Separate *bug*, *design limit*, *missing feature* and *wording*.
8. **Report format** (≤ 600 words, except where stated):
   ```
   AGENT <id> · <role>
   VERDICT (2–3 sentences, in character)
   SCORES (1–10, one-line reason each): <the role's own axes>
   FINDINGS (max 8): [SEV: blocker|high|med|low] [VERIFIED|THEORETICAL] title — evidence — impact — fix (effort S/M/L)
   WHAT WORKS (max 4)
   TOP QUESTION A REAL <role> WOULD ASK
   ```
9. **Tools:** Playwright + Chromium (`node_modules/playwright`), `axe-core`, `curl`, `gh` (read-only), the
   MCP SDK (`@modelcontextprotocol/sdk`), and web search where the role needs market facts (cite sources).
   Put scripts and screenshots under `<scratchpad>/swarm/<agent-id>/`. Don't use the Claude-in-Chrome extension.

## 2. Orchestrator setup (do this before Wave 1)

1. Check that the live site is awake (`/api/health`) and the AI is ready (`/api/status` shows `busy:false`).
2. Build an isolated copy for local testing, so a dev server on :3000 isn't disturbed:
   - `rsync` the repo, excluding `.next`, `node_modules`, `.git` and `.env*`, into `<scratchpad>/swarm/build`;
   - symlink `node_modules`, then run `next build`;
   - start it with
     `DATABASE_URL=postgres://localhost:5432/milestone APP_URL=http://localhost:3120 ALLOW_DEV_ACTIONS=1 OBJECTION_WINDOW_SECONDS=120 OBJECTION_RELEASE_SECONDS=180 next start -p 3120`,
     sourcing `.env` in a subshell.
   - Clear `rate_events` in the local database before each wave.
   - Agents with a local budget use `http://localhost:3120`.
3. Give each agent its AI and demo budget from section 1.4. Keep a ledger of what's been spent.
4. Run at most **10 agents at a time**. Waves:
   - **Wave 1:** groups A, B, H;
   - **Wave 2:** groups C, G;
   - **Wave 3:** groups D, E, F;
   - **Wave 4:** group I (meta). It reads the other reports and verifies them.
5. When an agent finishes, record its report verbatim in `<scratchpad>/swarm/reports/<id>.md`.

## 3. The agents

Each entry gives the role and mission and the questions the agent must answer. Prepend sections 0 and 1 to
every prompt. Default budget is **AI 0, demo 0, local yes**, unless stated.

### Group A: Hackathon judges (Wave 1)
- **A1 Devpost lead judge.** Score each official criterion (Technological Implementation, Design, Potential
  Impact, Quality of the Idea / Innovation, Presentation). Do the 5-minute test: 60 s of README, the video
  outline, then 2 min on the live site from a cold start. Give calibrated odds for every prize category.
  What is the "wow" moment, and does it land in the first 20 seconds? *Budget: demo 1.*
- **A2 PayPal developer advocate (Jo Franchetti / Eddie Jaoude lens).** Is PayPal central or bolted on?
  Check the correctness of Orders v2, authorize, capture, void, reauthorize, Payouts and webhooks. What
  would you show on stage at a PayPal dev event? *Budget: demo 1.*
- **A3 PayPal staff engineer (Karthik Ravi lens).** Read `flow.ts`, `claims.ts` and `webhooks.ts` line by
  line: idempotency, locks, unknown outcomes, re-reads, fee math, money rule compliance. Name any path where
  money moves twice, never, or wrongly.
- **A4 PayPal engineering manager (Himraj Singh lens).** Code quality, tests (240), maintainability. What
  would it take to make this production-ready inside PayPal? Estimate team and weeks.
- **A5 PayPal senior PM (Nathaniel Olson lens).** Would PayPal build this? Who is the customer, what's the
  market, how does it fit PayPal's agentic commerce strategy? Write the one-page product memo you would
  send your VP.
- **A6 "Best Use of Agentic Commerce" category judge.** Is the agent story real (MCP, earn but never take)?
  Compare with other likely entries: agents that *buy* things. Odds, plus the 3 changes that would make it
  undeniable on video.
- **A7 Presentation and video judge.** Critique `docs/DEVPOST.md`'s video shot list and Devpost text: pacing,
  jargon, the order of claims, overclaims, missing submission requirements. Rewrite the first 30 seconds.
- **A8 Skeptical "seen it all" judge.** Argue the case **against** placing this project: gimmick, scope
  creep, overclaiming. Then argue the strongest case **for** it. Which wins?

### Group B: Sponsor judges (Wave 1)
- **B1 Bryntum (Mats Bryntse lens).** Depth of the `/timeline` integration: auto-scheduling, constraints,
  dependencies, indicators, theming, accessibility, the trial watermark. Is the Gantt essential? Odds, plus
  the 3 cheapest gains. *Local: drag bars on :3120.*
- **B2 AG Grid (Sylwia Vargas lens).** `/ledger` and the `/milestones` grid: feature depth (filters, pinned
  totals, CSV, column state), theming, performance, accessibility, genuine need. Odds, plus the 3 cheapest gains.
- **B3 APIMatic (Ameer Hassan lens).** How much of PayPal goes through the generated SDK, versus
  hand-written REST? The quality of `paypal-plan.md` as evidence of using the Context Plugin. Odds, gains,
  and the usage-form checklist.
- **B4 Render (Shifra Williams lens).** Hosting, cold starts, the cron keep-awake, Workflows (not used).
  Would a Blueprint or Render Cron raise the odds cheaply?
- **B5 Elastic / Postman / Channel3 / Kernel / Astropods scout.** Is there a cheap, *genuine* fit for any
  other sponsor prize? Answer "no" if there isn't.
- **B6 Sponsor-prize strategist.** Given B1–B5, where should the next 10 hours go to maximise expected
  prize money? Show expected-value arithmetic.

### Group C: Milestone as a real PayPal product (Wave 2)
- **C1 PayPal product strategist.** Position Milestone inside PayPal: as a feature of PayPal Commerce
  Platform, of Braintree, of the Agent Toolkit or MCP, or as a standalone product. Pick one and argue it.
- **C2 PayPal Multiparty / Commerce Platform architect.** Redesign the money flow for production:
  - partner onboarding and seller referrals;
  - `payee` plus `platform_fees` on capture, and delayed disbursement;
  - who is merchant of record.
  
  Map each current step (`flow.ts`) to its production equivalent. Use the real sandbox errors in
  `docs/MULTIPARTY.md`.
- **C3 Payments risk and fraud.** Chargebacks after payout, collusion (one person as both client and
  worker), laundering through a "passed" milestone, card testing on the demo, velocity limits. What
  controls would PayPal Risk require?
- **C4 Compliance and legal (money transmission, KYC/AML, OFAC, PSD2).** What licences or exemptions apply?
  Is the capability-link model compatible with KYC? What would compliance block?
- **C5 Disputes and seller protection.** How the signed fingerprint, CI logs and proof trail could serve as
  dispute evidence. What Visa and Mastercard dispute rules actually accept. Design the evidence pack.
- **C6 Unit economics and pricing.** Fees, from the actual fee math (`amounts.ts`) and the PR #5 numbers.
  Break-even milestone size, pricing tiers, who pays what, against Upwork, Escrow.com and Algora (web
  search, cited).
- **C7 Platform / API product manager.** Design the public API and webhooks a marketplace would integrate
  against, and the SDKs. What's missing today (platform keys exist; there are no agent webhooks)? Write the
  API surface.
- **C8 Global expansion.** USD only today. Currencies, cross-border payouts, which regions PayPal supports
  for Payouts, tax forms (1099-K, DAC7). What breaks first outside the US?

### Group D: Users (Wave 3, hands-on with the local copy on :3120)
- **D1 Non-technical small-business client (Priya).** Hire for a $10–$20 job through `/new`, read the
  terms, fund, and try to understand everything. Where are you confused or scared? *Budget: AI 1.*
- **D2 Senior freelancer (Marco).** Do a full worker cycle, including a bad-faith objection and a human
  check deadline. Is it fair to you? Would you take jobs here? *Budget: AI 1.*
- **D3 Autonomous coding agent.** Drive the worker side **only through `mcp/server.mts`**, pointed at
  :3120. Are the errors actionable for an LLM, and can it complete the loop? (CI can't run against
  localhost, so use dev-pass from the client side.) *Budget: AI 0.*
- **D4 Agent-marketplace operator (platform API key).** Create milestones programmatically, and draft and
  track them. Is this integrable into your marketplace? What's missing? *Budget: AI 1.*
- **D5 Open-source maintainer paying bounties.** Would you use this instead of Algora or GitHub Sponsors?
  How well does it fit OSS workflows: forks, many contributors, CLA, maintainers reviewing?
- **D6 Enterprise procurement and engineering manager.** Paying contractors or agent vendors inside a
  company: approvals, budgets, invoices, audit, SSO. What's the gap?
- **D7 Accessibility user (screen reader and keyboard only).** Use the demo with the keyboard only, and run
  axe and VoiceOver-style checks on each page, including the grids and the Gantt. *Budget: demo 1, live
  read-only.*

### Group E: Security and adversarial testing (Wave 3, attacks on the local copy only)
- **E1 Malicious worker / CI bypass.** Try to get paid without the work against the harness design:
  - prototype pollution, `process.exitCode`, tampering with the TAP stream, test-runner hooks;
  - workflow edits, a fork PR, spoofed check names.
  
  Reproduce locally with the harness scripts from the demo repo (`gh` read-only).
- **E2 Malicious client.** Park the money, veto in bad faith, abuse objections and human-check reasons,
  cancel at the worst moment, write unpassable client tests. Check every deadline path in
  `run.ts` / `deadlines.ts`.
- **E3 Prompt-injection red team.** Bypass `injection.ts` and steer the reviewer on AI-reviewed criteria:
  other languages, Unicode, markdown, diff tricks. Measure what actually reaches the decision.
  *Budget: AI 2, local only.*
- **E4 Application security.** Capability tokens, the forged-link path, the CSP and headers, rate-limit
  bypass (`cf-connecting-ip` / `x-forwarded-for` on Render), IDOR on `/api/*`, webhook forgery and replay,
  the `/api/tick` throttle.
- **E5 Sandbox escape on `testcheck.ts`.** Craft AI-style test code that reads env, writes outside tmp,
  touches the network, spawns processes or exhausts resources. Use direct local calls to `checkTests`;
  never run it on the server.
- **E6 Concurrency and chaos.** Race fund against cancel, release against objection, double submits,
  webhook-before-response, a PayPal 5xx mid-capture (use mock headers locally with
  `ALLOW_DEV_ACTIONS=1`), and the unknown-outcome settling.

### Group F: Engineering and quality (Wave 3)
- **F1 Test-suite auditor.** What do the 240 tests really prove? Find gaps (untested branches in the money
  and review code), tests that mock away reality, and missing property tests for the fee math.
- **F2 Performance and reliability SRE.** Cold start, the Neon connection pool, the size of each page's
  first load, the 215 kB AG Grid chunk, the Bryntum chunk, the cost of each `/api/tick` run, the
  `/api/status` AI-failure modes.
- **F3 Frontend and design-system auditor.** Consistency with `DESIGN.md` across every page. Check:
  tokens, type, one accent, contrast in both themes, the phone layout at 390px, empty and error states, copy tone.
- **F4 Data model and migrations.** The schema (`db/migrations/*.sql`), indexes, audit completeness (money
  rule 5), the PayPal ids stored (money rule 4), migration safety on Neon at startup.
- **F5 AI systems engineer.** The prompts in `terms.ts` and `verifiers.ts`, the structured-output
  robustness, the fallback chain, free-model drift (minimax was removed on Oct 22), the cost per milestone
  in calls. Propose an evaluation set.
- **F6 Developer experience and documentation.** Clone-to-running time from the README alone, an
  undocumented env var hunt, the MCP setup instructions, reusing the demo workflow in another repo.

### Group G: Business and market (Wave 2)
- **G1 Fintech VC.** Market size for testable work and for agent work, defensibility, team-and-timing
  story, and a verdict: toy, feature or company. Cite your sources.
- **G2 Ex-Upwork / Fiverr marketplace operator.** Trust and safety, liquidity, off-platform leakage,
  reputation, and why marketplaces would (or wouldn't) adopt this as infrastructure.
- **G3 Competitive analyst.** A feature matrix against TaskBounty, Algora, Opire, Gitcoin, Escrow.com,
  Upwork escrow, Stripe Connect holds, x402 and crypto agent-escrow projects. Where is Milestone first,
  equal or behind?
- **G4 Go-to-market lead.** The first 100 customers: who, the channel, the message, the pricing experiment.
  The narrowest wedge that could work in 90 days.

### Group H: Content and truthfulness (Wave 1)
- **H1 Claim checker.** Every factual claim in `README.md`, `docs/DEVPOST.md` and the landing page: true,
  partly true or false, with evidence. Overclaims cost credibility with PayPal engineers.
- **H2 Live-site copy editor.** Every visible string on every page: jargon, tone, typos, raw technical
  text, inconsistent terms ("hold" versus "escrow", "worker" versus "freelancer"). *Budget: demo 1.*
- **H3 Submission compliance officer.** Check the official rules item by item: public repo plus a visible
  license, a working demo, a video under 3 minutes with no copyrighted music, tools and models disclosed,
  sponsor usage, eligibility. List what is missing.

### Group I: Meta (Wave 4, runs after all the others)
- **I1 Verifier.** Re-check every **blocker** and **high** finding from Waves 1–3. Reproduce it, or mark
  it NOT REPRODUCED with your evidence. Drop duplicates.
- **I2 Devil's advocate.** Challenge the swarm's consensus. Which praised strengths are actually fragile?
  Which criticisms are unfair or already answered in the README?
- **I3 Synthesizer.** Write the final report (section 4).

## 4. Final report (what I3 delivers, ≤ 2,500 words)

1. **Executive verdict:** one paragraph. Is it a gimmick, a strong hackathon entry, or the seed of a PayPal product?
2. **Scorecard:** each official judging criterion and each sponsor prize. Show the median and the range
   across agents, plus calibrated odds.
3. **Consensus and conflicts:** where 5 or more agents agree, and where they disagree, with I2's challenge.
4. **Verified issues table**, sorted by severity, after I1's verification:
   id · severity · area · evidence · fix · effort · owner (code, docs, video, or the user).
5. **Before Nov 12, ranked by expected score gain per hour:** at most 12 items. Mark the ones that must
   happen before recording the video.
6. **"If PayPal shipped this" roadmap:** 30, 90 and 365 days, from C1–C8 and G1–G4. Cover the
   production architecture, compliance, risk controls, API surface and pricing.
7. **User-experience gaps** by persona (D1–D7), each with the single fix that matters most.
8. **Security posture:** what's solid, what's open, and what's accepted residual risk, with honest
   wording for the README.
9. **Budget ledger:** the AI calls, demo starts and local milestones the swarm used.

Rules for the synthesis:
- Include only findings with evidence.
- Use "the agents found", never "everyone loved".
- Keep the known limits from section 0 out of the issues list unless an agent proved them misstated.
