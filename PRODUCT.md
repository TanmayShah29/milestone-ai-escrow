# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Primary: the client paying for work.** Someone funding a piece of software work (a feature, a fix) who wants to pay only for work that is actually done, without becoming the reviewer or chasing a dispute. Their job: write a brief, agree terms, put the money on hold, and see it released only when the work is proven. Their anxiety peaks at funding and at release.
- **The worker**, a freelancer or an AI coding agent. Wants certainty that the money exists before starting and an exact definition of "done". Humans use the worker link in the browser; agents use the MCP server, so in the UI an agent appears as a badge and in the activity feed.
- **Hackathon judges** (PayPal AI Hackathon 2026, judging until Dec 15) arrive cold, often on a phone, with about a minute: they need the idea at a glance and a demo that needs no login.

## Product Purpose
Milestone is a pay-on-proof layer on PayPal. The client's money is a PayPal authorization hold; the AI turns the brief into acceptance criteria and compiles the testable ones into tests; both sides sign the terms' SHA-256 fingerprint, which rides on the PayPal order; the worker opens a GitHub PR; CI runs the signed tests, the AI reviews only what tests can't check, and fixed rules decide whether to capture and pay out (after an objection window) or request changes. Success: a client who never has to trust a person or a model, only the proof.

## Positioning
**Money moves only on proof.** Held on PayPal until the work is proven; the AI checks, fixed rules decide, and the AI never moves money. The same rails pay humans or AI agents.

## Operating Context
- Lifecycle: draft terms → sign → fund (PayPal hold, via PayPal login or the sandbox test card) → deliver (GitHub PR citing `Milestone-Terms: <fingerprint>`) → review (per-criterion CI checks + AI review) → decision (passed / changes requested / needs the client) → objection window → capture and payout.
- Access is by capability links: a client link and a worker link per milestone (no accounts). Platforms use API keys; agents use the MCP server.
- Proof lives elsewhere and should be linked, not copied: PayPal order/authorization/capture/payout ids, the GitHub PR and its CI jobs, the locked contract at `/api/contracts/<fingerprint>`.
- Hosting is free tier: the server can take ~1 minute to wake; AI calls are rate-limited and occasionally busy; CI takes 1–2 minutes.

## Capabilities and Constraints
- Built: everything in the lifecycle above, verifiers `code_pr` and `rubric_text`, prompt-injection and tampering detection, objection window with auto-release, test-card funding, Bryntum Gantt timeline (`/timeline`), MCP server, HTTP API.
- PayPal **sandbox only**. USD only. One hold per milestone.
- Terms: `PRODUCT.md` describes product truth only; the visual system will live in `DESIGN.md`.
- Undecided: pricing and fees beyond the 5% platform-fee setting; any real-money deployment.

## Brand Commitments
- Name: **Milestone**. Voice: plain, calm, precise; states what happened and what happens next.
- **Never look like PayPal.** Our own name and look; PayPal appears only as a factual mention ("held on PayPal sandbox") with its ids, never its logo or brand styling.

## Evidence on Hand
- Real paid runs on PayPal sandbox with public PRs: https://github.com/TanmayShah29/milestone-demo/pull/1 (paid $23.75), /pull/2 (prompt injection caught, then fixed and paid), /pull/3 (an AI agent via MCP, paid $14.25).
- Live app: https://milestone-ai-escrow.onrender.com
- No customers, testimonials, usage numbers or press exist. Do not invent any.

## Product Principles
1. Money state is always visible: where the money is, and what releases it.
2. One next action per person; otherwise say who we are waiting on.
3. Every decision explains itself with evidence, and says it was decided by rules, not the model.
4. Proof is clickable, never paraphrased.
5. Be honest about waiting: cold starts, CI, AI busy.

## Accessibility & Inclusion
WCAG 2.2 AA: contrast, visible keyboard focus, reduced motion respected, screen-reader labels on status and money amounts. Every flow must be fully usable on a phone at 390px wide.
