# paypal-plan.md: money flow contract sheet

Scope (build-order step 2): hold → client approves → authorize → capture → payout, plus void and
reauthorize, with idempotency keys and the audit log. Refunds, disputes and webhooks are later steps
and will extend this sheet.

SDK: `paypal` 2.29.0 (installed from github.com/context-plugins/paypal-typescript-sdk#main, built `dist/`
present). Map: `node_modules/paypal/sdk-map.md`, `map/operations/{orders,payments}.md`.
Payouts are **not in the SDK** (resources: orders, payments, vault, transactionSearch, subscriptions), so
payouts are small typed REST functions in `src/lib/paypal/payouts.ts`.

## Repo survey

| Item | Value |
| --- | --- |
| Runtime | Node 22.20 (SDK floor `>=20.3`). Next.js 15.5 app router, server code runs in the Node runtime (route handlers set `runtime = "nodejs"`) |
| Module format | ESM source, but **Next's bundler loaded both SDK dialects** in the Oct 20 sandbox run, so `instanceof PaypalError` failed. Fixes: `serverExternalPackages: ["paypal"]` in `next.config.ts`, and `classify()` narrows on `kind`/`uri`/`method` |
| Package manager | npm (`package-lock.json`) |
| tsconfig | `strict: true`; no `exactOptionalPropertyTypes`, no `verbatimModuleSyntax` (still use `import type` for model types) |
| Checks | `npx tsc --noEmit`, `npm run lint`, `npm test` (node:test via tsx), `npm run build` |
| Baseline | fresh create-next-app scaffold: clean |
| Conventions | none yet (greenfield). Pattern: `src/lib/<area>/*.ts` for server modules, `src/app/api/**/route.ts` for handlers |
| DB | Postgres 14 local (`DATABASE_URL`), `pg` driver, plain SQL migrations in `db/migrations/` |

## Host and credentials

- The SDK declares one environment, default base URL `https://api-m.sandbox.paypal.com`. There is no `ServerEnvironment`.
- `src/lib/paypal/client.ts` reads `PAYPAL_ENVIRONMENT`. `SANDBOX` → `serverOptions: { baseUrl: "https://api-m.sandbox.paypal.com" }` set **explicitly**. Any other value throws at startup (live is out of scope for the hackathon).
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` checked non-empty before construction (an unset `oauth2` sends no credential and 401s later).
- One client per process (module-level lazy singleton), never per request.
- Read-only smoke, Oct 20: `getOrder({id:"NOPE123"})` → `api` 404 arm `"error2"` `RESOURCE_NOT_FOUND`; `getAuthorizedPayment` → 404 arm `"error3"`. Credential and host OK.

## Operations

All take one flat request object; every POST gets an SDK-minted `Idempotency-Key` per call (that one is not ours). **`prefer` defaults to `"return=minimal"` on every write below and is sent even when omitted.** Minimal responses omit `purchase_units[].payments` (the authorization id) and can come back with no body, so every write sets `prefer: "return=representation"` (required by the "record the result" rows below).

| Op | Signature | Wire | Returns | Members we assert on |
| --- | --- | --- | --- | --- |
| createOrder | `client.orders.createOrder(req: Orders.CreateOrderRequest)` | `POST /v2/checkout/orders` | `Order` | `id`, `status === "CREATED"`, `links[rel=="payer-action" \|\| rel=="approve"].href` |
| getOrder | `client.orders.getOrder(req: Orders.GetOrderRequest)` | `GET /v2/checkout/orders/{id}` | `Order` | `status`, `purchaseUnits[0].payments.authorizations[]`, `.captures[]` |
| authorizeOrder | `client.orders.authorizeOrder(req: Orders.AuthorizeOrderRequest)` | `POST /v2/checkout/orders/{id}/authorize` | `OrderAuthorizeResponse` | `purchaseUnits[0].payments.authorizations[0].{id,status,amount,expirationTime}` |
| getAuthorizedPayment | `client.payments.getAuthorizedPayment(req: Payments.GetAuthorizedPaymentRequest)` | `GET /v2/payments/authorizations/{authorization_id}` | `PaymentAuthorization` | `status`, `expirationTime` |
| captureAuthorizedPayment | `client.payments.captureAuthorizedPayment(req: Payments.CaptureAuthorizedPaymentRequest)` | `POST /v2/payments/authorizations/{authorization_id}/capture` | `CapturedPayment` | `id`, `status`, `amount` |
| voidPayment | `client.payments.voidPayment(req: Payments.VoidPaymentRequest)` | `POST /v2/payments/authorizations/{authorization_id}/void` | `PaymentAuthorization` | `status === "VOIDED"` |
| reauthorizePayment | `client.payments.reauthorizePayment(req: Payments.ReauthorizePaymentRequest)` | `POST /v2/payments/authorizations/{authorization_id}/reauthorize` | `PaymentAuthorization` | `id` (a NEW authorization id), `expirationTime` |

Response mode: throw-based (`await`) everywhere; none of these resolve to `undefined`.

### Request fields used

| Op | Field | Channel / wire | Value |
| --- | --- | --- | --- |
| createOrder | `body: OrderRequest` | body | see below |
| createOrder | `payPalRequestId` | header `PayPal-Request-Id` | claim's `request_id` |
| createOrder | `prefer` | header `Prefer` | `"return=representation"` |
| getOrder | `id` | path | stored `paypal_order_id` |
| authorizeOrder | `id` | path | stored `paypal_order_id` |
| authorizeOrder | `payPalRequestId`, `prefer` | headers | claim id, `"return=representation"` |
| authorizeOrder | `body` | body | `{}`: without a body the SDK sends no Content-Type and PayPal answers **415** [VERIFIED Oct 20] |
| capture | `authorizationId` | path `authorization_id` | stored `paypal_authorization_id` |
| capture | `payPalRequestId`, `prefer` | headers | claim id, `"return=representation"` |
| capture | `body: CaptureRequest` | body | `{ amount: { currencyCode: "USD", value: <authorized amount> }, finalCapture: true }` |
| void | `authorizationId`, `payPalRequestId`, `prefer` | path, headers | as above |
| reauthorize | `authorizationId`, `payPalRequestId`, `prefer`, `body: {}` | path, headers, body | as above; `{}` for the Content-Type (same 415 risk as authorize); re-authorizes the full original amount |
| any (tests/demo only) | `payPalMockResponse` | header `PayPal-Mock-Response` | only when the caller passes a mock code (forced-error demo) |

`OrderRequest` (members from `src/models/order-request.ts`, `purchase-unit-request.ts`, `amount-with-breakdown.ts`, `order-application-context.ts`):
```
{ intent: "AUTHORIZE",                                   // CheckoutPaymentIntent.Authorize
  purchaseUnits: [{ amount: { currencyCode: "USD", value }, customId: milestoneId, description }],
  applicationContext: { returnUrl, cancelUrl, shippingPreference: "NO_SHIPPING" } }
```
Enums (open, `as const`): `CheckoutPaymentIntent` {CAPTURE, AUTHORIZE}; `OrderStatus` {CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED}; `AuthorizationStatus` {CREATED, CAPTURED, DENIED, PARTIALLY_CAPTURED, VOIDED, PENDING}; `CaptureStatus` {COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED, FAILED}; shipping preference {GET_FROM_FILE, NO_SHIPPING, SET_PROVIDED_ADDRESS}.

`Error` model (`src/models/error.ts`) is imported as `type Error as PaypalApiErrorBody`: `name`, `message`, `debugId` required; `details?: { issue; description?; field? }[]`.

### Error arms (per operation; tags are schema-derived, never shared)

| Op | Arms |
| --- | --- |
| createOrder | `error` 400 · `error2` 401 · `error3` 422 · `error4` default · `undeclared` |
| getOrder | `error` 401 · `error2` 404 · `error3` default · `undeclared` |
| authorizeOrder | `error` 400 · `error2` 401 · `error3` 403 · `error4` 404 · `error5` 422 · `error6` 500 · `error7` default · `undeclared` |
| getAuthorizedPayment | `error` 401 · `error2` 403 · `error3` 404 · `error500` 500 (no body) · `error4` default · `undeclared` |
| captureAuthorizedPayment | `error` 400 · `error2` 401 · `error3` 403 · `error4` 404 · `error5` 409 · `error6` 422 · `error500` 500 (no body) · `error7` default · `undeclared` |
| voidPayment | `error` 401 · `error2` 403 · `error3` 404 · `error4` 409 · `error5` 422 · `error500` 500 (no body) · `error6` default · `undeclared` |
| reauthorizePayment | `error` 400 · `error2` 401 · `error3` 403 · `error4` 404 · `error5` 422 · `error500` 500 (no body) · `error6` default · `undeclared` |

Every arm except `error500`/`undeclared` carries the same `Error` body, so the one translator in
`src/lib/paypal/errors.ts` does not switch on `payload.kind` at all: it reads `err.status`, and takes the
reason from `"body" in payload ? payload.body : rawBody`. That keeps it valid across operations.

### Retry, timeout, logging

- Retry: SDK defaults kept (GETs retried; POSTs never auto-retried). `retry.timeout: 20_000` ms per attempt.
- Logging: **off**, `logging: { level: "off" }` set explicitly so `PAYPAL_CLIENT_LOG` can't turn it on. Request bodies carry the payer's flow only (amounts, URLs, ids), but we keep it off anyway. Our own audit log records `debugId` from error bodies.
- No pagination or streaming needed; no `fetch` wrapper in production (tests inject one).

## 1b.1 DURABLE WRITES

Claim store: table `money_actions` (one row per attempted money write). Partial unique index
`money_actions_live_uq ON (milestone_id, action) WHERE status IN ('pending','succeeded','unknown')`.
`request_id` = `ms_<milestoneId>_<action>_<attempt>` (derived, deterministic; `attempt` increments only after
a released claim), sent as `PayPal-Request-Id` (money rule 2). Release on a provider refusal = set `status='failed'`.

**DUPLICATE CLAIMS**

| Write | Where the claim is stored | What rejects the second one | Where that rejection is caught | Where in the code |
| --- | --- | --- | --- | --- |
| createOrder | `money_actions` action `create_order` | `money_actions_live_uq` | pg `23505` (`isUniqueViolation`, `src/lib/db.ts`) in `claimAction` → `{ won: false }`; `runWrite` returns the stored milestone if the winner succeeded, `InProgress` (409) if pending, settles if unknown | `src/lib/money/claims.ts` `claimAction`; `src/lib/money/flow.ts` `createHold` |
| authorizeOrder | action `authorize` | same index | same | `claimAction`; `flow.ts` `authorizeHold` |
| captureAuthorizedPayment | action `capture` | same index | same | `claimAction`; `flow.ts` `releaseFunds` |
| voidPayment | action `void` | same index | same | `claimAction`; `flow.ts` `cancelHold` |
| reauthorizePayment | action `reauthorize_<n>` (n = reauth count) | same index | same | `claimAction`; `flow.ts` `refreshHold` |
| payout (REST) | action `payout` | same index | same | `claimAction`; `flow.ts` `payoutFreelancer` |

State changes on `milestones` are conditional (`UPDATE … WHERE id=$1 AND state=$2`) so a second caller can't move the state twice.

**UNKNOWN OUTCOMES** (`connection`, `timeout`, a `decode` on a 2xx, **or an `api` 5xx/408** (Oct 21 audit fix: a 5xx was counted as refused, which released the claim and let a retry get a new request id, a double-payout risk); the claim moves to `status='unknown'`)

All writes share one path: `src/lib/money/flow.ts` `runWrite` catches, `classify()` (`src/lib/paypal/errors.ts`)
returns `kind: "unknown"`, the claim is marked `unknown`, then `settle()` calls the spec's `reread` and, if found,
`commit()` records it. Not found, or the re-read itself fails → `OutcomeUnknown` (HTTP 202), claim stays `unknown`. A re-read that **proves** PayPal did not act returns `NOT_DONE` (authorize: order still APPROVED with no authorization; capture/void: authorization still CREATED) → claim released (`failed`), so a retry is safe. If storing the result fails after PayPal acted, `commit()` marks the claim `unknown` with the PayPal id in its own statement (never left `pending`). Pending claims older than 2 minutes (a crashed process) are settled like unknown ones. Every action runs under a per-milestone Postgres advisory lock (`withMilestoneLock`), so actions on one milestone never overlap.

| Write | The operation you re-read with | The reference you search by | Where in the code | The test that fails the connection |
| --- | --- | --- | --- | --- |
| createOrder | replay `createOrder` with the **same** `PayPal-Request-Id`. [VERIFIED Oct 20: replay returned the same order `72M03063VF805480U`] | claim `request_id` | `flow.ts` `createHold` → spec `reread` | `tests/flow.test.ts` "createHold › connection drop replays with the same PayPal-Request-Id" |
| authorizeOrder | `getOrder` | `paypal_order_id` → `purchaseUnits[0].payments.authorizations[0]` | `flow.ts` `authorizeHold` → `readAuthorization` | "authorizeHold › connection drop re-reads the order and records the authorization"; "a re-read that finds nothing leaves the outcome unknown, never failed" |
| captureAuthorizedPayment | `getOrder` | `paypal_order_id` → `purchaseUnits[0].payments.captures[0]` | `flow.ts` `releaseFunds` → spec `reread` | "releaseFunds › a capture timeout re-reads the order to find the capture" |
| voidPayment | `getAuthorizedPayment` | `paypal_authorization_id` → `status === "VOIDED"` | `flow.ts` `cancelHold` → spec `reread` | "cancelHold › a void connection drop re-reads the authorization" |
| reauthorizePayment | `getOrder` | `paypal_order_id` → newest authorization ≠ current id | `flow.ts` `refreshHold` → spec `reread` | none yet (shares `runWrite`/`settle`; add when the refreshHolds job lands) |
| payout (REST) | replay POST with the same `PayPal-Request-Id` / `sender_batch_id` | claim `request_id` (= `sender_batch_id`) | `src/lib/paypal/payouts.ts` `createPayout`; `flow.ts` `payoutFreelancer` | "releaseFunds › a payout connection drop replays the batch with the same request id" |

Never-sent failures (`auth`, `encode`): claim released (`failed`), no re-read. Test: "authorizeHold › AuthError releases the claim and makes no re-read".
A re-read that itself fails leaves the claim `unknown`; the milestone shows "PayPal outcome unknown, retry sync", and `POST /api/milestones/:id/sync` (`syncMilestone` → `resumeAction`) re-runs the action, which finds its own `unknown` claim and settles it.

## 1b.2 CROSS-OPERATION INVARIANTS

| Invariant | Where the legal set comes from | Enforced where | The test that proves it |
| --- | --- | --- | --- |
| The order / authorization / capture id passed to a write is the one stored on **this** milestone, never a caller-supplied id | `milestones` row (money rule 4) | route handlers take only `milestoneId`; `flow.ts` loads ids from the row | "authorizeHold › a return token that isn't this milestone's order is rejected with no PayPal call" |
| Capture amount ≤ authorized amount (money rule 3) | `milestones.authorized_cents` | `flow.ts` `releaseFunds` before the claim | "releaseFunds › refuses to capture above the authorized amount, before any call" |
| Payout = captured − fee | `milestones.captured_cents`, `PLATFORM_FEE_BPS` | `src/lib/money/amounts.ts` `payoutCents` | `tests/amounts.test.ts` |
| Each write is only legal from its source state | `src/lib/milestones/states.ts` transition table | `flow.ts` before the claim | "cancelHold › is refused once work is submitted, with no PayPal call" |

## 1b.3 OPTIONAL FIELDS

| Op | Field | What requires it | Set it? |
| --- | --- | --- | --- |
| all writes | `payPalRequestId` | DUPLICATE CLAIMS / UNKNOWN OUTCOMES rows; money rule 2 | ✅ |
| all writes | `prefer` | "record the result" (minimal omits authorization ids) | ✅ `return=representation` |
| all | `payPalMockResponse` | task: forced-error demo (CLAUDE.md) | ✅ only when a mock code is passed in |
| all | `payPalAuthAssertion`, `payPalPartnerAttributionId`, `payPalClientMetadataId` | nothing | ❌ |
| getOrder | `fields` | nothing | ❌ |
| OrderRequest | `purchaseUnits[0].customId` | webhook mapping back to the milestone (step 3) + money rule 4 | ✅ milestone id |
| OrderRequest | `purchaseUnits[0].description` | YOUR CALL: client sees what the hold is for on the approval page | ✅ milestone title (≤127 chars) |
| OrderRequest | `applicationContext.returnUrl/cancelUrl` | the approve → authorize step (plan step 7–8) | ✅ |
| OrderRequest | `applicationContext.shippingPreference` | YOUR CALL: a service has no shipping; without it the approval page asks for an address | ✅ `NO_SHIPPING` |
| OrderRequest | `payer`, `paymentSource`, `processingInstruction`, `items`, `invoiceId`, `brandName`, `userAction`, `locale` | nothing | ❌ |
| CaptureRequest | `amount` | money rule 3 (explicit, checked ≤ authorized) | ✅ |
| CaptureRequest | `finalCapture` | single release per milestone (frees the remainder) | ✅ `true` |
| CaptureRequest | `invoiceId`, `noteToPayer`, `softDescriptor`, `paymentInstruction` | nothing | ❌ |
| ReauthorizeRequest | `amount` | nothing (full amount) | ❌ (send `body: {}` with no members) |

Test: "createHold › sends the claim's PayPal-Request-Id, return=representation, and only headers we own" asserts the request carries no `PayPal-Auth-Assertion`, `PayPal-Partner-Attribution-Id`, `PayPal-Client-Metadata-Id`, and no `fields` query.

## 1b.4 WHEN THE API SAYS NO

Applies to every op above (all use data from the milestone row). One mapper, `toHttp()` in `src/lib/paypal/errors.ts`:

| status | your app answers | the caller reads | test |
| --- | --- | --- | --- |
| 4xx other than 401/403/429 | same 4xx | PayPal's `details[0].description ?? message` + `debugId` | "authorizeHold › a 422 refusal releases the claim and its reason reaches the caller" |
| 401 / 403 | 502 | "PayPal rejected our credentials" | "authorizeHold › a 401 from PayPal maps to 502 with a fixed message" |
| 429 | 503 | "PayPal is rate-limiting us, try again shortly" | — |
| 5xx | 502 | "PayPal error, try again" | — |
| no response, write | 202 + milestone shows `unknown` | "Outcome unknown, checking with PayPal" | per UNKNOWN OUTCOMES |
| no response, read | 502 | "PayPal unreachable" | — |

## Payouts REST (not in the SDK)

`POST /v1/payments/payouts` with `PayPal-Request-Id` = claim id; body
`{ sender_batch_header: { sender_batch_id: <claim id>, recipient_type: "EMAIL", email_subject }, items: [{ recipient_type: "EMAIL", receiver: freelancer email, amount: { value, currency: "USD" }, sender_item_id: milestoneId }] }`.
201 → `batch_header.payout_batch_id`, `batch_status`. Status: `GET /v1/payments/payouts/{batch_id}` → `items[0].payout_item_id`, `items[0].transaction_status` (SUCCESS → milestone `PAID_OUT`). Token: own client-credentials fetch with cache in `src/lib/paypal/token.ts`. [VERIFIED Oct 20: $1 payouts reached SUCCESS in about 15 s.]

## Assumptions & Blockers

- Minor: platform fee defaults to 5% (`PLATFORM_FEE_BPS=500`), overridable by env.
- Minor: objection window, AI review and webhooks are later steps. Until then a dev-only route (`ALLOW_DEV_ACTIONS=1`) moves SUBMITTED → PASSED so the release can be tested.
- No blockers.

## REQUIRED READING

- Client construction → MUST load `typescript-client-initialization` (loaded)
- Error boundary → MUST load `typescript-error-handling` (loaded)
- `prefer` default is sent even when omitted; flat request object → MUST load `typescript-calling-endpoints`
- Retry policy and per-attempt timeout → MUST load `typescript-configuration-resilience`
- Faked `fetch` tests for the unknown-outcome rows → MUST load `typescript-testing`
