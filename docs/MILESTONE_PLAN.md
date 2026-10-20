# Milestone: build plan (text version of Milestone_Project_Plan.pdf)

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
| Authorize | `POST /v2/checkout/orders/{id}/authorize` | not yet |
| Capture hold | `POST /v2/payments/authorizations/{id}/capture` | not yet |
| Void | `POST /v2/payments/authorizations/{id}/void` | not yet |
| Reauthorize | `POST /v2/payments/authorizations/{id}/reauthorize` | not yet |
| Payout | `POST /v1/payments/payouts` | ✅ PENDING |
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
