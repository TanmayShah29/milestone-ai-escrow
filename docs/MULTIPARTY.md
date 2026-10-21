# PayPal Multiparty: feasibility spike

Spike run on 2026-10-22 (IST) against the sandbox with app "hackathon2" (`APP-8H366052M49310022`, US business account `sb-47hvxh49451990@business.example.com`). Run it again with `./scripts/multiparty-check.sh`. The script keeps every amount at or under $1.00, voids every hold it creates and refunds anything it captures.

**Recommendation: NO-GO before the Nov 6 feature freeze.** Every Multiparty feature we would need is switched off for this app, and only PayPal can switch it on. Keep today's flow (hold on the platform, then capture, then a payout minus the fee). Put Multiparty in the README as the production path.

## What the sandbox returned

| # | Request | Result |
|---|---|---|
| 1 | `AUTHORIZE` + card, `payee.email_address` = freelancer (personal) | 422 `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` (debug `ca4e280f7ce01`) [VERIFIED 2026-10-22] |
| 1b | Same, payee = the client (another personal account) | 422 `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` [VERIFIED 2026-10-22] |
| 2 | `AUTHORIZE` + payee + `payment_instruction.platform_fees` 0.25 at order create | 422 `UNSUPPORTED_PAYMENT_INSTRUCTION`: payment_instruction only works with `intent=CAPTURE`; with AUTHORIZE you pass it on `/v2/payments/authorizations/{id}/capture` [VERIFIED 2026-10-22] |
| 5a | `AUTHORIZE` + card, payee = our own business account (control) | 201 COMPLETED, auth `6MB00621X58007547` CREATED, then voided (VOIDED) [VERIFIED 2026-10-22] |
| 5b | `AUTHORIZE` + card, no payee; `platform_fees` 0.25 on the **capture** call | Order 201, auth `4YM15739WC987930P`. Capture 422 `PLATFORM_FEES_NOT_SUPPORTED`: "The API Caller is not enabled to process transactions by specifying 'platform_fees'. Please work with your PayPal Account Manager…" (debug `ca4e281d7adb2`). The auth was voided [VERIFIED 2026-10-22] |
| 5c | `CAPTURE` + card + `platform_fees` at create | 422 `PLATFORM_FEES_NOT_SUPPORTED` [VERIFIED 2026-10-22] |
| 5d | `AUTHORIZE`, PayPal wallet (no payment_source), payee = freelancer | 201 CREATED (order `40C51016LV821233T`, left unapproved to expire). A personal payee is accepted for **wallet** payments [VERIFIED 2026-10-22]. Approving and capturing it needs a human in the browser and was not done (see open questions) |
| 5e | `CAPTURE`, wallet, payee = freelancer + `platform_fees` | 422 `PLATFORM_FEES_NOT_SUPPORTED` [VERIFIED 2026-10-22] |
| 3 / 3b | `CAPTURE` + card + `payment_instruction.disbursement_mode: DELAYED` (with and without payee) | 422 `DELAYED_DISBURSEMENT_NOT_SUPPORTED`: "The API Caller is not enabled to process transactions by specifying disbursement mode as delayed." So `/v1/payments/referenced-payouts-items` could not be reached with a real capture [VERIFIED 2026-10-22] |
| 4 | `POST /v2/customer/partner-referrals` (seller onboarding link) | 403 `NOT_AUTHORIZED` [VERIFIED 2026-10-22] |
| — | OAuth token scopes | include `payment/authcapture` and `payments/payouts`; nothing for referenced payouts or partner referrals [VERIFIED 2026-10-22] |

Nothing was captured, so nothing needed a refund. The only money objects created were two $1.00 card authorizations, and both were voided (`6MB00621X58007547`, `4YM15739WC987930P`). The script's second run gave the same results as the first.

## What this means

- **Splitting the payment (`platform_fees`) is a permission on the API caller, not on the payee.** It fails even when the payee is our own account (5b, 5c). On a normal sandbox REST app it is off. [VERIFIED 2026-10-22]
- **Delayed disbursement is also a permission on the caller.** It is off (3b), so neither the hold-then-release step nor `referenced-payouts-items` is available. [VERIFIED 2026-10-22]
- **A third-party payee and card payments:** the payee must be a business account that is enabled for card processing (Advanced Credit and Debit Card). Our personal freelancer account can't receive card payments. [VERIFIED 2026-10-22, for personal payees] A second sandbox business account would get past this error. But without onboarding through the platform, that account would not have consented to us capturing for it or charging a fee. [DOCS]
- **Unlocking any of this means becoming a PayPal Commerce Platform partner.** PayPal approves the partner account (by hand, through an account manager) and enables PARTNER_FEE, DELAY_FUNDS_DISBURSEMENT and the partner-referrals scope. Each seller then onboards through the Partner Referrals API and grants consent, and we store their `merchant_id` as `payee.merchant_id`. Each call also sends a `PayPal-Partner-Attribution-Id` (BN code). [DOCS] The 403 on partner-referrals and the "work with your PayPal Account Manager" wording back this up. [VERIFIED 2026-10-22]

## How the Milestone flow would map (once approved)

| Milestone step | Today | Multiparty |
|---|---|---|
| Worker joins | sandbox email for payouts | onboard through Partner Referrals → `merchant_id` stored on the worker |
| Fund | `AUTHORIZE` order, payee = platform | `AUTHORIZE` order, `payee.merchant_id` = worker, `PayPal-Partner-Attribution-Id` |
| Release on proof | capture to the platform, then a Payouts batch minus the fee | `POST /v2/payments/authorizations/{id}/capture` with `payment_instruction.platform_fees` = our fee. The money lands in the worker's account in one step, with no Payouts call |
| Optional extra hold after capture | n/a | `CAPTURE` intent + `disbursement_mode: DELAYED`, then `POST /v1/payments/referenced-payouts-items {reference_id: capture id}` to release |
| Cancel / changes | void the auth | unchanged (void the auth) |
| Refund | refund the capture, but the payout has already left | refund the capture and reverse the platform fee (`payment_instruction` on refund); the worker's balance is debited |
| Disputes / chargebacks | the platform is the merchant of record and eats them | the **worker (seller) is the merchant of record**: disputes, chargebacks and seller protection are theirs. The platform only loses its fee |

The money rules all still hold: the AI never moves money, the idempotency keys stay the same, and the capture is capped at the authorized amount. The fee is taken by PayPal at capture instead of by subtracting before the payout.

## Effort if it were unlocked

About 2 to 3 days: worker onboarding (a referral link, a return handler, then a merchant-integration status check), a `payee_merchant_id` column, changing the capture to carry `platform_fees`, dropping the payout step for Multiparty milestones, refund fee reversal, the `MERCHANT.ONBOARDING.COMPLETED` and `MERCHANT.PARTNER-CONSENT.REVOKED` webhooks, and tests. **The blocker is the calendar, not the code.** Partner approval goes through PayPal partner and account managers and usually takes weeks, and we can't control it before Nov 6. You can't build or demo any of this against the current sandbox app. The only thing we could build is code that we can't run.

## GO / NO-GO

**NO-GO for the Nov 6 freeze.** Instead:
1. Keep the working flow (hold → capture → payout minus the fee). It is real and verified end to end.
2. In the README "real-world path" section, describe the Multiparty mapping above. Cite the exact sandbox errors (`PLATFORM_FEES_NOT_SUPPORTED`, `DELAYED_DISBURSEMENT_NOT_SUPPORTED`, `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`, partner-referrals 403) to show we checked.
3. Optional and cheap: ask in the PayPal hackathon Discord whether hackathon sandbox apps can have PARTNER_FEE and DELAY_FUNDS_DISBURSEMENT enabled. If a mentor enables them, re-run `./scripts/multiparty-check.sh` and look at this again.

## Open questions (not tested)
- Could a wallet-funded order with a personal payee (5d), once approved by the client, be **captured by our app** for that payee without consent? The docs suggest it would fail (`PAYEE_NOT_CONSENTED` or `PERMISSION_DENIED`). Testing it needs a browser approval at sandbox.paypal.com. It would also give us no platform fee, so it doesn't change the recommendation. [DOCS]
