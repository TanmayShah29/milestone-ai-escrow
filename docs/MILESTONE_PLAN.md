# Milestone: build plan

> **Direction (decided Oct 21, after a five-agent audit).** Milestone is a **pay-on-proof layer on PayPal**:
> any platform or AI agent can create a payment that is held on PayPal and released only when the outcome
> is proven (tests, an AI judge, or a deterministic check). *The AI writes and checks the contract; only
> code moves money.* The freelance GitHub-PR flow is the first use case and reference app. Workers can be
> humans **or AI agents**. The sections below the "Pay-on-proof plan" are the original plan; where they
> conflict, the new plan wins. `Milestone_Project_Plan.pdf` predates this change.

## Pay-on-proof plan (Oct 21)

### What we build (about 8–9 feature-days available)
| # | Feature | Days |
|---|---|---|
| 0 | Fix audit bugs (stuck pending claim, 5xx counted as refused, raw-body webhook verify, auth, expired orders, payout failures), API keys per platform, move DB to Neon, test card-funded holds | 1.5 |
| 1 | **Contract compiled into tests**: AI turns acceptance criteria into tests where possible; criteria hash locked into the PayPal order at funding | 2.5 |
| 2 | **Verifier interface + reviewer + decision policy**: `code_pr` verifier (CI + AI review, prompt-injection resistant, posts a GitHub check run) and one cheap second verifier (text/document deliverable vs a rubric) | 3 |
| 3 | **Escrow as an API + MCP server** (no money tools): create a conditional payment, attach a verifier, submit proof, check status. Demo: a coding agent takes a bounty, opens the PR, gets paid | 2 |
| 4 | **Bryntum Gantt**: holds as dependencies, day-3 honor and day-29 expiry lines, agent rescheduling flags reauthorization | 2.5 |
| 5 | Real UI (client / worker views, verdict card) + judge mode (`/demo` reset + seeded data, cached verdicts, keep-awake pinger) | 1.5 |

Feature freeze **Nov 6**. Nov 7–8 README + hardening; Nov 9–10 video; Nov 11 submit + APIMatic usage form.

### Progress
- Oct 21: Phase 0 (audit fixes, auth, Neon), Phase 1 (contract compiled to tests) and Phase 2 (verifiers, policy,
  objection window, auto-release, test-card funding) done. Verified live on Render + sandbox: good PR
  (milestone-demo #1) went PASSED → auto-released → PAID_OUT with all four signed webhooks verified; bad PR (#2)
  with a prompt-injection comment → CHANGES_REQUESTED, injection flagged, hold kept.

- Oct 21: Phase 3 (MCP server; an agent was paid for milestone-demo#3) and Phase 4 (Bryntum Gantt at /timeline:
  phases + money-gate dependencies, honor/expiry/due indicators, drag-to-reschedule with hold-expiry warning,
  payment tranches) done. `scripts/seed-demo.ts` seeds a three-milestone project for screenshots/judge mode.
  Bryntum notes: the trial is the public npm alias (no account, no card, watermark); the React wrapper takes
  `<name>Feature` props (a `features` object is silently ignored); `fields` on a TaskModel subclass must be a
  static getter.

### Cut to the roadmap slide
Negotiating agents, dispute evidence pack, partial-refund splits, AG Grid, Kernel / Elastic / Zapier,
one hold spanning several milestones (partial captures unverified), Bryntum baselines and critical path.

### Prize targets
Max one main prize + **one** sponsor prize per project. Targets: Best Use of PayPal + AI, Best Use of
Agentic Commerce, main prizes; sponsor: **Bryntum** (primary), **APIMatic** (backup). Render prize is
credits only: deploy there and credit it.

### Free-tier constraints (the user will not add a card anywhere)
- AI: free OpenRouter models only (50/day). Cache verdicts by commit SHA, pre-review demo PRs, rate-limit
  live reviews per visitor, show which model answered, fall back to a labelled "replayed verdict".
- Hosting: Render free web service (sleeps after 15 min; free pinger) + **Neon** free Postgres (Render's
  free DB is deleted after 30 days, before judging ends Dec 15).
- Render Workflows likely needs billing: use DB-backed jobs + a protected cron endpoint instead.

### Video arc
1. A freelancer is paid safely (relatable). 2. A bad PR tries to prompt-inject the reviewer; money stays
held (trust). 3. An AI agent takes a bounty through the API and is paid (agentic). 4. "Same rails:
bounties, agencies, agent-to-agent commerce" (scale).

---

# Original plan (Oct 20)

## Actors
- **Client**: writes the brief, approves the PayPal hold, can object during the objection window
- **Freelancer**: accepts the criteria, submits a GitHub PR, receives the payout
- **Milestone app**: orchestrates everything and is the only thing that calls money APIs
- **AI reviewer** (free OpenRouter model, set by `AI_MODEL`): writes criteria, reviews deliverables, proposes splits, drafts dispute evidence
- **PayPal**: orders, authorizations, captures, payouts, refunds, disputes, webhooks

## Happy path (15 steps)
| # | From → To | Action | Phase |
|---|---|---|---|
| 1 | Client → App | post brief + budget | Agree |
| 2 | App → AI | draft acceptance criteria | Agree |
| 3 | AI → App | checklist: must / nice-to-have, each testable | Agree |
| 4 | App → Freelancer | offer + criteria | Agree |
| 5 | Freelancer → App | accept | Agree |
| 6 | App → PayPal | create order, `intent: AUTHORIZE` | Fund |
| 7 | PayPal → Client | approve link; client logs in at sandbox.paypal.com | Fund |
| 8 | App → PayPal | `POST /v2/checkout/orders/{id}/authorize` → hold (authorization id) | Fund |
| 9 | Freelancer → App | submit deliverable (PR URL) | Deliver + review |
| 10 | App → AI | review against criteria | Deliver + review |
| 11 | AI → App | per-criterion verdict + evidence + confidence (JSON) | Deliver + review |
| 12 | App → Client | review report; objection window (48 h, 2 min in demo) | Deliver + review |
| 13 | App → PayPal | `POST /v2/payments/authorizations/{id}/capture` | Release |
| 14 | App → PayPal | `POST /v1/payments/payouts` (amount minus fee) | Release |
| 15 | PayPal → Freelancer | money arrives; `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` webhook to the app | Release |

## Milestone states
`DRAFT → AGREED → FUNDED → SUBMITTED → IN_REVIEW → PASSED → RELEASED → PAID_OUT`

| Transition | Trigger | PayPal call |
|---|---|---|
| AGREED → FUNDED | client approves the hold | create order (AUTHORIZE) + authorize |
| FUNDED → CANCELLED | both cancel before submission | void authorization |
| IN_REVIEW → CHANGES_REQUESTED | a must-have criterion fails | none (back to SUBMITTED on resubmit) |
| IN_REVIEW → HUMAN_CHECK | confidence < 0.8 | none (client decides) |
| IN_REVIEW → PASSED | all musts pass and confidence ≥ 0.8 | none |
| PASSED → RELEASED | objection window ends with no objection | capture authorization |
| RELEASED → PAID_OUT | capture completed (webhook) | payout |
| PASSED → CONTESTED | client objects | none |
| CONTESTED → PARTIAL_REFUND | both accept the AI-proposed split | capture partial, void the rest |
| CONTESTED → DISPUTE | no agreement | AI drafts the evidence pack |
| FUNDED (day 3+) | daily `refreshHolds` job | reauthorize |

## Decision policy (deterministic code, not the model)
- Any `must` criterion = fail → CHANGES_REQUESTED, with the AI's feedback
- Any `must` = unclear, or overall confidence < 0.8 → HUMAN_CHECK
- All `must` = pass and confidence ≥ 0.8 → PASSED (starts the objection window)

## Reviewer agent
- Tools (read-only): fetch PR metadata and diff, list changed files, read a file, get CI check status. Later: screenshots and docs
- Output JSON: `{ criteria: [{ id, verdict: pass|fail|unclear, evidence: [quotes/links], confidence }], summary, feedback_for_freelancer }`
- It has no access to money APIs

## PayPal API map
| Step | Endpoint | Tested on our sandbox? |
|---|---|---|
| Create hold order | `POST /v2/checkout/orders` (intent AUTHORIZE) | ✅ returns CREATED with an approve link |
| Authorize | `POST /v2/checkout/orders/{id}/authorize` | ✅ Oct 20 (needs Content-Type: application/json, else 415) |
| Capture hold | `POST /v2/payments/authorizations/{id}/capture` | ✅ Oct 20, COMPLETED immediately |
| Void | `POST /v2/payments/authorizations/{id}/void` | not yet |
| Reauthorize | `POST /v2/payments/authorizations/{id}/reauthorize` | not yet |
| Payout | `POST /v1/payments/payouts` | ✅ SUCCESS in ~15 s (Oct 20, from a real capture) |
| Refund | `POST /v2/payments/captures/{id}/refund` | not yet |
| Disputes | `/v1/customer/disputes/...` | not yet |
| Webhooks | `/v1/notifications/webhooks`, `verify-webhook-signature` | not yet |
| Card hold (alternative to wallet) | order with `payment_source.card` | ✅ card capture works |

Webhooks to handle: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED/VOIDED`, `PAYMENT.CAPTURE.COMPLETED/REFUNDED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED/FAILED/UNCLAIMED`, `CUSTOMER.DISPUTE.CREATED/RESOLVED`.

## Build order (riskiest first)
1. Oct 21–24: repo, license, Next.js skeleton, DB schema, second US Personal sandbox account (the freelancer)
2. Oct 23–29: **money flow end to end**: hold → approve → authorize → capture → payout, with idempotency and the audit log
3. Oct 27–30: webhooks with signature verification + first Render deploy (needs a public URL)
4. Oct 28–Nov 4: criteria writer + reviewer agent + decision policy
5. Nov 1–6: Bryntum Gantt timeline (holds as dependencies, blocked and unlocked states)
6. Nov 4–8: objections, partial refunds, dispute evidence
7. Nov 7–10: polish, README, tests
8. Nov 9–12: demo video + Devpost submission

## Sponsors
- **Bryntum** (prize target): Gantt of milestones with payment holds as dependencies; the agent moves dates when work is late
- **APIMatic**: Context Plugin in Claude Code while building the PayPal integration; mention it in the README and video
- **Render**: hosting (live URL for judges, HTTPS for webhooks) + Workflows for `reviewDeliverable`, `releaseFunds`, `refreshHolds`, `syncPayouts`
- Skipped: AG Grid (stretch goal only), Channel3, Kernel, Elastic, Astropods, Zapier, Postman

## Demo (under 3 min)
1. Problem: a freelancer's unpaid-invoice story
2. Brief → AI checklist → freelancer accepts
3. Client approves on PayPal; the Gantt bar shows "Funded: $300 held"
4. PR submitted; the per-criterion report fills in live
5. Objection window ends → capture → payout; the freelancer's balance goes up
6. A bad PR is rejected with feedback, and the money stays held
7. Architecture slide and closing line
