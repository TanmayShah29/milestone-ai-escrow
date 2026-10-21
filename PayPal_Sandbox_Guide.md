# PayPal Sandbox: How It Works (verified against your account)

Written: Oct 20, 2026
Method: PayPal docs, the agent-toolkit source (v1.11.0), and live calls against your sandbox through the MCP server and curl.
Tags: **[VERIFIED]** = I ran it on your sandbox today. **[DOCS]** = from PayPal docs, not run. **[KNOWLEDGE]** = general PayPal knowledge, not re-checked this session.

---

## 0. Account status: ✅ EVERYTHING WE NEED WORKS

**Current app: "hackathon2" (`APP-8H366052M49310022`)**, linked to the US business account. Verified Oct 20, 20:52 IST with `./scripts/sandbox-check.sh --deep`. **[VERIFIED]**

| Capability | Status |
|---|---|
| Orders (CAPTURE and AUTHORIZE intent) | ✅ |
| Card payments + test declines | ✅ |
| Payouts | ✅ |
| Invoicing (incl. partial payments, tips) | ✅ |
| Transaction search | ✅ |
| Subscriptions | ✅ |
| Refunds | ✅ (scope present) |
| Disputes | ✅ |
| Webhooks API | ✅ |
| Vault: save a card | ✅ |
| Vault: save a PayPal wallet | ❌ limited release. Not needed for Milestone |
| Merchant insights | ❌ not needed |

**Sandbox accounts (all US, all verified with a $1 payout reaching SUCCESS):**

| Role | Email |
|---|---|
| Platform (business, linked to hackathon2) | `sb-47hvxh49451990@business.example.com` |
| Client (pays, approves holds) | `sb-eg47t53461254@personal.example.com` |
| Freelancer (receives payouts) | `sb-puo47p53461265@personal.example.com` |

Payouts in the sandbox take about 15 seconds to go from PENDING to PROCESSING to SUCCESS. **[VERIFIED]**

Re-check any time with `./scripts/sandbox-check.sh` (read-only) or `--deep` (creates $1 test objects). This is also the `sandbox-check` skill.

The rest of section 0 is history, kept for the README's troubleshooting notes.

### History: first US app "hackathon" (`APP-69342774CD058583K`, retired)

| Capability | Status on that app |
|---|---|
| Payouts | ✅ batch created, status PENDING |
| Card payments | ✅ $12 captured (order `5CN90105HT5889111`, capture `9XP256065L393884F`). `CCREJECT-IF` returns DECLINED with code 5120 |
| Vault: save a card | ✅ setup token returned APPROVED |
| Vault: save a PayPal wallet | ❌ `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`. This is a limited-release feature. Use saved cards, authorize-then-capture, or subscriptions instead |
| Subscriptions, refunds, disputes, auth/capture | ✅ the token has these scopes |
| Invoicing | ✅ since about 20:30 IST: invoice with partial payment + tip created (`INV2-G8WG-8EHR-PANU-E88C`). It took over an hour after saving the feature to apply |
| Transaction search (reporting) | ✅ since about 20:30 IST |
| Merchant insights | ❌ 403 (not needed) |

Re-check any time with `./scripts/sandbox-check.sh` (read-only) or `--deep` (creates $1 test objects). This is also the `sandbox-check` skill.

### Original findings on the old (India) account

Three calls failed with country or setup errors:

| Call | Error | Meaning |
|---|---|---|
| Create invoice with `allow_partial_payment` | `Partial payments are not available in your country.` | PayPal lists India, Brazil and Israel as countries without this feature |
| `POST /v1/payments/payouts` | `PAYOUT_NOT_AVAILABLE: You live in a country that is not allowed to send this payout.` | Payouts are blocked, so "pay a contractor or gig worker" flows won't work |
| Order paid directly with a test card | `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` | Card fields (ACDC) aren't enabled on this account |

The account is almost certainly an India-based business account (the default for an Indian developer login). **[VERIFIED errors, inferred country]**

**Fix (about 10 minutes):**
1. Go to developer.paypal.com, then Sandbox, then Accounts, then **Create account**. Choose **Business** and **Country: United States**.
2. Create a second account: **Personal**, **United States**. This is your test buyer.
3. Go to Apps & Credentials (Sandbox), **Create App**, and link it to the new US business account.
4. Put the new Client ID and Secret in `/Users/tanmay/Paypal/.env`. `scripts/paypal-mcp.sh` will pick them up the next time it starts.
5. Re-run the payouts and card checks in section 12 to confirm.

Judges will run your repo with their own sandbox credentials. Your README should tell them to use a **US** business account.

---

## 1. Mental model

```
 developer.paypal.com (your dev login)
   ├── Sandbox accounts (fake people)
   │     ├── Business account  = the MERCHANT (receives money; API credentials live here)
   │     └── Personal account  = the BUYER (logs in at sandbox.paypal.com to approve or pay)
   ├── REST App = Client ID + Secret, linked to ONE business account
   │     └── Webhooks (up to 10 listener URLs per app)
   └── Notifications / Event logs (sandbox "emails" and webhook deliveries appear here)

 www.sandbox.paypal.com  = fake paypal.com. Log in as either account to see balances,
                           approve payments, pay invoices, open disputes.
 api-m.sandbox.paypal.com = REST API (api.sandbox.paypal.com also works; the toolkit uses it)
 mcp.sandbox.paypal.com   = PayPal's hosted MCP server (/sse or /http)
```

- Sandbox money is fake, but behavior matches production. Same API feature set, except account closure, monthly statements, shipping preferences and PayPal Shops. **[DOCS]**
- Default accounts: registering creates `sb-xxxx@business.example.com` and `sb-xxxx@personal.example.com`. Neither can be deleted. **[DOCS]**
- Buyer approval always happens in a browser, as the personal account at sandbox.paypal.com. An API can't approve on the buyer's behalf for wallet payments. This is the main design constraint for "agentic" payments (see section 10). **[VERIFIED]**

---

## 2. Authentication

```
POST https://api-m.sandbox.paypal.com/v1/oauth2/token
Basic auth: CLIENT_ID:SECRET    body: grant_type=client_credentials
→ { access_token, expires_in (~32400s ≈ 9h) }
```
- `scripts/paypal-token.sh` does this. `scripts/paypal-mcp.sh` gets a fresh token every time the MCP server starts. **[VERIFIED]**
- Send `Authorization: Bearer <token>` on every call. **[VERIFIED]**
- `PayPal-Request-Id: <uuid>` makes a POST idempotent: retrying with the same ID returns the original result. Use it on create order, capture and refund. **[VERIFIED accepted; KNOWLEDGE for semantics]**
- A browser-safe client token, valid 15 minutes, is only needed for JS SDK v6 Fastlane. Normal buttons just use the Client ID. **[DOCS]**

---

## 3. Orders v2: one-time checkout (the core flow)

### State machine
```
                   create (no payment_source)          create (payment_source.paypal + experience_context)
                          │                                       │
                       CREATED ──(links: approve, authorize,     PAYER_ACTION_REQUIRED
                          │        update, self)                  │ (links: payer-action, self)
                          └──────────── buyer opens link, logs in as personal account, clicks Pay ────┘
                                                  │
                                              APPROVED
                                  ┌───────────────┴────────────────┐
                        intent=CAPTURE                     intent=AUTHORIZE
                     POST /orders/{id}/capture          POST /orders/{id}/authorize
                             │                                   │
                         COMPLETED                     authorization (hold on buyer funds)
                    (captures[0].id = CAPTURE_ID)       ├─ POST /v2/payments/authorizations/{id}/capture
                             │                          └─ POST /v2/payments/authorizations/{id}/void
                  POST /v2/payments/captures/{CAPTURE_ID}/refund   (full, or partial with an amount)
```
- **[VERIFIED]** A plain create returned `CREATED` with links `approve, authorize, update`.
- **[VERIFIED]** A create with `payment_source.paypal.experience_context` returned `PAYER_ACTION_REQUIRED` with a `payer-action` link: `https://www.sandbox.paypal.com/checkoutnow?token=<ORDER_ID>`.
- **[VERIFIED]** Capturing before approval fails with HTTP 422: *"Payer has not yet approved the Order for payment."*
- **[KNOWLEDGE]** An authorization's honor period is 3 days and it stays valid up to 29 days. An unapproved order expires after about 3 hours (sandbox may differ).
- **[DOCS]** `PATCH /orders/{id}` works while the order is CREATED or APPROVED, for example to change the amount after the buyer picks shipping.
- **[DOCS]** `POST /orders/{id}/track` adds shipment tracking to an order.

### Key request fields
```json
{
  "intent": "CAPTURE",                       // or AUTHORIZE (hold now, charge later)
  "purchase_units": [{
    "reference_id": "your-id",
    "amount": { "currency_code": "USD", "value": "25.00",
                "breakdown": { "item_total": {...}, "shipping": {...}, "tax_total": {...} } },
    "items": [ ... ],
    "payee": { "email_address": "seller@..." } // marketplaces: pay a different merchant
  }],
  "payment_source": { "paypal": { "experience_context": {
      "user_action": "PAY_NOW", "return_url": "...", "cancel_url": "...",
      "shipping_preference": "NO_SHIPPING | GET_FROM_FILE | SET_PROVIDED_ADDRESS",
      "brand_name": "..."
  }}}
}
```
After approval, PayPal redirects the buyer to `return_url?token=<ORDER_ID>&PayerID=...`. Your server then calls capture. **[KNOWLEDGE]**

### Cards (when enabled on a US account)
- Test cards **[DOCS]**: Visa `4005519200000004`, `4012000033330026`; Mastercard `2223000048400011`; Amex `371449635398431`. Use any future expiry and any CVV.
- To force a decline, put one of these in the cardholder name field **[DOCS]**: `CCREJECT-REFUSED`, `CCREJECT-IF` (insufficient funds), `CCREJECT-SF` (suspected fraud), `CCREJECT-EC` (expired), `CCREJECT-CVV_F`, `CCREJECT-BANK_ERROR`.
- There's a card generator in the dashboard (Sandbox, then Card testing).

---

### Authorize → capture → payout, end to end (Oct 20, 22:20 IST) [VERIFIED]
Milestone app, $30 hold, client approved with the Visa on the sandbox client account:
- Order `72M03063VF805480U` (intent AUTHORIZE) → authorization `1RE57454U10427202`, status CREATED, `expiration_time` 29 days out
- Capture `3FR566719V476415N` ($30.00, `final_capture: true`) came back **COMPLETED immediately**
- Payout batch `Q34XCPS6MF7GQ` ($28.50) → item `C5RNBFPAGJ8VL` **SUCCESS within ~15 s**

**Card-funded hold with no buyer login (Oct 21)** [VERIFIED]: `POST /v2/checkout/orders` with `intent: AUTHORIZE` and `payment_source.card` (test Visa `4005519200000004`, expiry `2030-12`, CVV `123`, US billing address) returned **COMPLETED in one call** with authorization `44524611HK036190R` (CREATED, expires in 29 days). No approve link, no browser. Voided it afterwards (204). This is the judge-friendly "Fund with test card" path.

Gotchas found on the way:
- **`POST /v2/checkout/orders/{id}/authorize` with no `Content-Type` returns 415** `UNSUPPORTED_MEDIA_TYPE`. Send `Content-Type: application/json` and `{}`. With the TypeScript SDK, pass `body: {}` (it omits the header when there's no body). [VERIFIED]
- `POST /v2/payments/authorizations/{id}/void` does **not** need a Content-Type (404 for a fake id with or without it, no 415). [VERIFIED]
- Replaying `POST /v2/checkout/orders` with the **same `PayPal-Request-Id`** returns the **same order id**, not a new order. [VERIFIED]
- The SDK's `prefer` header defaults to `return=minimal`, which omits `purchase_units[].payments` (the authorization id). Send `Prefer: return=representation`. [DOCS + SDK map]
- After an approve, PayPal redirects to the return URL with `?token=<order id>&PayerID=...`.

## 4. Invoicing v2: bill someone, they pay through a link

```
create (DRAFT) ──send──▶ SENT ──buyer pays at recipient_view_url──▶ PAID / PARTIALLY_PAID / MARKED_AS_PAID
     │                    │──remind (manual or auto-reminders)
     │                    └──cancel──▶ CANCELLED
     └──delete (draft only)                               PAID ──refund──▶ REFUNDED / PARTIALLY_REFUNDED
```
- **[VERIFIED]** Create returned `INV2-2KLU-VXVH-MXA2-ELF7` with status DRAFT and a total of $120 (3 hours × $40).
- **[VERIFIED]** Send returned HTTP 200 and the status became SENT. The pay page is `https://www.sandbox.paypal.com/invoice/p/#2KLUVXVHMXA2ELF7`.
- **[VERIFIED]** The `create_invoice` MCP tool returns only a `self` link, so call `get_invoice` afterwards for status and the pay URL.
- The invoicer details came back empty `{}`. PayPal fills them from the business account if you don't set them. **[VERIFIED]**
- **[KNOWLEDGE]** Sandbox doesn't email real inboxes. "Sent" emails appear under Dashboard, then Sandbox, then Notifications. To pay, open the `recipient_view_url` and log in as the sandbox buyer.
- Extras:
  - QR code for in-person payment (`generate-qr-code`) **[DOCS]**
  - Record an off-PayPal cash payment (`/payments`) **[DOCS]**
  - Recurring invoice series **[DOCS]**
  - Auto-reminders: toolkit 1.11 only, not in the MCP server **[DOCS]**
  - Tips **[DOCS]**
  - Partial payments: blocked on your account **[VERIFIED]**

---

## 5. Subscriptions (Billing v1): recurring payments

```
Catalog product (PROD-...)  ──▶  Plan (P-..., ACTIVE)  ──▶  Subscription (I-...)
                                    billing_cycles:            APPROVAL_PENDING ──buyer approves──▶ ACTIVE
                                     1. TRIAL (optional,         ACTIVE ⇄ SUSPENDED ; ─▶ CANCELLED / EXPIRED
                                        must come first)        each cycle: PAYMENT.SALE.COMPLETED webhook
                                     2. REGULAR (total_cycles 0 = forever)
```
- **[VERIFIED]** Product `PROD-2LC59693TK899394T` was created.
- **[VERIFIED]** Plan `P-5TE02765PU5646126NLLPY6Y` (7-day free trial, then $9.99/month) was created and came back ACTIVE straight away.
- **[VERIFIED]** Subscription `I-3DVGM873YMGJ` came back APPROVAL_PENDING with an approve link at `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-...`.
- **[DOCS]** Payment preferences:
  - `payment_failure_threshold`: how many failures before the subscription is suspended
  - `auto_bill_outstanding`
  - `setup_fee`
- **[KNOWLEDGE]** Sandbox bills on real calendar time. You can't fast-forward, so for a demo use `interval_unit: DAY`.

---

## 6. Refunds
- `POST /v2/payments/captures/{capture_id}/refund` with an empty body refunds in full. Add `{amount:{value,currency_code}}` for a partial refund. **[DOCS / toolkit source]**
- Refund status is COMPLETED or PENDING. Webhook: `PAYMENT.CAPTURE.REFUNDED`. **[DOCS]**
- You need the **capture ID** (from the capture response), not the order ID.

## 7. Disputes
- Disputes only exist on **completed** transactions. **[DOCS]**
- To create one, log in to sandbox.paypal.com as the buyer, open Activity, choose the payment, then Report a problem. Handle it as the seller in another browser session. **[DOCS]**
- States: `OPEN_INQUIRIES` → `REQUIRED_ACTION` / `REQUIRED_OTHER_PARTY_ACTION` → `UNDER_PAYPAL_REVIEW` → `RESOLVED` (`APPEALABLE`).
- API: list, get and accept-claim are in the MCP. Provide-evidence, make-offer, escalate and send-message are REST only (`/v1/customer/disputes/{id}/...`). **[DOCS]**
- **[DOCS]** A sandbox-only `adjudicate` action simulates PayPal's decision. It works when the dispute is UNDER_REVIEW.
- **[VERIFIED]** Your dispute list is currently empty.

## 8. Shipment tracking
- Needs the capture or **transaction ID**. Endpoints: `POST /v1/shipping/trackers-batch` and `GET /v1/shipping/trackers?transaction_id=`. **[toolkit source]**
- Adding tracking helps the seller win "item not received" disputes. **[KNOWLEDGE]**

## 9. Reporting: list transactions
- `GET /v1/reporting/transactions`. Each query covers at most 31 days. Status filter: S (success), P (pending), D (denied), V (reversed). **[toolkit source]**
- **[KNOWLEDGE]** New transactions can take up to about 3 hours to appear. Don't depend on this endpoint for real-time UI; use the order or capture responses and webhooks instead.

## 10. Payouts (send money to many people)
- `POST /v1/payments/payouts`. Recipient types: EMAIL, PHONE, PAYPAL_ID. Webhooks: `PAYMENT.PAYOUTSBATCH.*` and `PAYMENT.PAYOUTS-ITEM.*`.
- **[VERIFIED BLOCKED]** Doesn't work on your current account (see section 0). Neither the MCP nor the toolkit has a payouts tool, so you'd write a raw REST call.

---

## 11. Webhooks: how your app learns things happened

- Set them up under Dashboard, then your App, then Webhooks, or with `POST /v1/notifications/webhooks` (URL plus event types, or `*`). **[DOCS]**
- **[VERIFIED Oct 20]** Webhook `2JC020923H9067634` registered for `https://milestone-ai-escrow.onrender.com/api/paypal/webhook` (17 event types) with `./scripts/register-webhook.sh <url>`, which is idempotent: it returns the existing id for the same URL.
- The URL must be **public HTTPS**: a Vercel deployment, or ngrok or cloudflared for local development.
- PayPal expects a 2xx response. Otherwise it retries up to 25 times over 3 days. **[DOCS]**
- **Always verify the signature**: `POST /v1/notifications/verify-webhook-signature` with the headers (`paypal-transmission-id`, `-time`, `-sig`, `paypal-cert-url`, `paypal-auth-algo`), your `webhook_id` and the raw body. **[DOCS]**
- The dashboard Webhooks simulator sends fake events to your URL, useful before the real flows work. Note that simulated events can't be signature-verified. **[KNOWLEDGE]**

Events worth handling:

| Flow | Events |
|---|---|
| Checkout | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED / PENDING / DECLINED / REFUNDED / REVERSED` |
| Auth | `PAYMENT.AUTHORIZATION.CREATED / VOIDED` |
| Invoices | `INVOICING.INVOICE.PAID / CANCELLED / REFUNDED` |
| Subscriptions | `BILLING.SUBSCRIPTION.ACTIVATED / CANCELLED / SUSPENDED / PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED` |
| Disputes | `CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED` |
| Payouts | `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED / FAILED / UNCLAIMED` |
| Vault | `VAULT.PAYMENT-TOKEN.CREATED / DELETED` |

---

## 12. Negative testing (forcing errors on purpose)
- Header: `PayPal-Mock-Response: {"mock_application_codes":"<ERROR_NAME>"}`
- **[VERIFIED]** Sending `INSTRUMENT_DECLINED` on order create returned 422 `INSTRUMENT_DECLINED`. It worked without turning on the account's "Negative Testing" setting.
- Useful codes **[KNOWLEDGE]**:
  - `INSTRUMENT_DECLINED`: the buyer's card or bank fails. Recover by sending them back to the approve link.
  - `ORDER_NOT_APPROVED`
  - `DUPLICATE_INVOICE_ID`
  - `TRANSACTION_REFUSED`
  - `PAYER_ACTION_REQUIRED`
  - `MAX_NUMBER_OF_REFUNDS_EXCEEDED`
  - `REFUND_AMOUNT_EXCEEDED`
- Use these in the demo to show the agent handling failures, for example recovering from a declined payment. Judges reward non-trivial handling.

Commands to re-run checks (after fixing section 0):
```bash
TOKEN=$(./scripts/paypal-token.sh); B=https://api-m.sandbox.paypal.com
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -X POST $B/v1/payments/payouts \
  -d '{"sender_batch_header":{"sender_batch_id":"t-'$(date +%s)'"},"items":[{"recipient_type":"EMAIL","amount":{"value":"1.00","currency":"USD"},"receiver":"<sandbox personal email>"}]}'
```

---

## 13. Your AI tooling and what each piece covers

| Layer | What it is | Notes |
|---|---|---|
| **Local MCP** `@paypal/mcp` **v1.8.1** (your `.mcp.json`) | 28 tools for Claude Code and Desktop | Good for exploring and for the demo "agent brain" |
| **Agent Toolkit** `@paypal/agent-toolkit` **v1.11.0** (`agent-toolkit/`) | **43 tools**, with adapters for Vercel AI SDK, OpenAI Agents, LangChain, Bedrock, MCP | Use this inside your app. It has more tools than the MCP server |
| **Remote MCP** `https://mcp.sandbox.paypal.com/http` (or `/sse`) | Hosted by PayPal; auth is a Bearer token or a browser login | Avoids running npx in production |

**Tools in both** (28): orders (`create_order`, `get_order`, `pay_order` = capture), invoices (create, get, list, send, remind, cancel, QR), products, plans, subscriptions (create, show, cancel), refunds, shipment tracking, disputes (list, get, accept), `list_transactions`.

**Toolkit 1.11 only** (+15):
- recurring invoice series (create, activate, get, cancel, delete)
- invoice auto-reminders (setup, update, cancel)
- `search_invoicing`, `update_invoicing`, `delete_invoice`, `generate_invoice_number`
- `record_payment_for_invoice` / `record_refund_for_invoice`
- `create_conditional_rules_for_invoice`
- `update_subscription`, `update_plan`
- **`get_merchant_insights`** (`/v1/merchant/insights`, sales analytics)

**Not in either, so use raw REST**: payouts, webhooks (register and verify), authorize/void, order PATCH, vault (saved payment methods), dispute evidence, offers and escalation, Venmo, card processing.

**MCP `create_order` quirks** **[VERIFIED]**:
- USD only.
- It always sets `payment_source.paypal`, so the order starts as PAYER_ACTION_REQUIRED. The buyer link is `rel: payer-action`, not `approve`.
- `pay_order` is just capture, so it fails until a human approves.

---

## 14. "Agentic commerce": what's actually possible

1. **An agent can do everything except the buyer's consent click.** Creating orders, invoices, subscriptions, refunds and tracking, and answering disputes, are all API calls. Approving a wallet payment needs the buyer to log in. Common patterns:
   - **Human-in-the-loop checkout**: the agent builds the cart and order, the user taps the approve link, and the agent captures and follows up. This is honest and safe, and judges like it.
   - **Pre-authorized spend**: the user approves once with `intent: AUTHORIZE` (a hold), and the agent captures later, within 29 days, when a condition is met. Good for escrow and "pay when the job is done".
   - **Vaulted payment method** (saved PayPal or card through the Vault API): after one consent, the merchant can charge later without the buyer present. This is true autonomous agent payment. **[DOCS; vault not tested on your account. Test it on the US account.]**
   - **Subscriptions**: one approval, then automatic recurring charges.
2. **PayPal Agentic Commerce Services (Store Sync and Agent Ready)** need a request form and onboarding through partners like Wix and BigCommerce. Don't plan to use them in a 3-week hackathon. You can mention them in the pitch as where the product could go. **[DOCS]**
3. **PayPal checks AI agent integrations** for proper auth, idempotency (`PayPal-Request-Id`), webhook verification and graceful error handling. These are the "technical implementation" signals.

---

## 15. Frontend: JS SDK v6 (if you build a web checkout)
- Script: `https://www.sandbox.paypal.com/web-sdk/v6/core`. Use `paypal.createInstance({ clientId, components:["paypal-payments"] })`. **[DOCS]**
- `findEligibleMethods({currencyCode})` → `createPayPalOneTimePaymentSession({ onApprove, onCancel, onError })` → `<paypal-button>` → `session.start({presentationMode:"auto"}, createOrderPromise)`.
- `createOrder` must resolve to `{ orderId }`, which is new in v6. Your server needs `/orders/create` and `/orders/{id}/capture` endpoints.
- Supports PayPal, Pay Later, PayPal Credit, Venmo (US only), Apple Pay, Google Pay, Fastlane and cards.
- Example code: github.com/paypal-examples/docs-examples. Getting started: github.com/paypaldev/getting-started-with-paypal-sandbox.

---

## 16. Test objects currently in your sandbox (created Oct 20, 2026)

| Object | ID | State |
|---|---|---|
| Order (MCP, $10) | `5LV52993355238901` | PAYER_ACTION_REQUIRED |
| Order (curl, $25) | (no ID kept) | PAYER_ACTION_REQUIRED |
| Order (curl, AUTHORIZE $5) | (no ID kept) | CREATED |
| Product | `PROD-2LC59693TK899394T` | active |
| Plan | `P-5TE02765PU5646126NLLPY6Y` | ACTIVE (7-day trial, then $9.99/mo) |
| Subscription | `I-3DVGM873YMGJ` | APPROVAL_PENDING |
| Invoice ($120) | `INV2-2KLU-VXVH-MXA2-ELF7` | SENT |
| Webhooks | none | — |
| Disputes / transactions | none | — |

All of these are on the current (restricted) account. They'll be irrelevant once you switch to a US app.

---

## 17. Gotchas checklist
- [ ] Use a US business account. Payouts, cards and partial payments are blocked on the current one.
- [ ] Refund with the **capture ID**, not the order ID.
- [ ] Send a `PayPal-Request-Id` on every money-moving POST.
- [ ] Don't build real-time UI on `list_transactions` (it lags). Use webhooks and order responses.
- [ ] The webhook URL must be public HTTPS. Verify signatures.
- [ ] Sandbox emails don't arrive. Use the Dashboard Notifications page and the pay links.
- [ ] Subscriptions bill on real time, so use DAY intervals for demos.
- [ ] Tokens expire after about 9 hours. Refresh in code; don't hard-code tokens.
- [ ] The README must include sandbox setup steps and test buyer credentials so judges can run it.
