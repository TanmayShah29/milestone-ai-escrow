---
name: sandbox-check
description: Check which PayPal sandbox capabilities (orders, invoicing, transaction search, subscriptions, disputes, webhooks, and with --deep also payouts, card capture, vault) work for the app configured in .env. Use when the user asks whether invoicing, payouts or another PayPal feature works yet, after switching PayPal apps or keys, or before relying on a PayPal API in code.
---

Run the check script from the project root and report the table to the user:

```bash
./scripts/sandbox-check.sh          # read-only (creates one unapproved $1 order that expires)
./scripts/sandbox-check.sh --deep   # also creates a $1 payout, a $1 card capture and vault setup tokens
```

Use the default mode unless the user asks to prove money movement, or a read-only check can't answer the question (payouts, cards, vault).

After running it:
1. Summarise in a short table: what works, what's blocked, and what changed since the last result in section 0 of `PayPal_Sandbox_Guide.md`.
2. If anything changed, update section 0 of `PayPal_Sandbox_Guide.md` (date it, tag it [VERIFIED]) and the sandbox facts in `CLAUDE.md`.
3. For BLOCKED results, give the matching fix:
   - invoicing / transaction search: tick the feature in the app, or create a fresh app linked to the same US business account
   - payouts / partial payments "not available in your country": the app is linked to a non-US business account
   - card `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`: enable Expanded checkout / Advanced Credit and Debit Card Payments
   - wallet vault `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE`: limited release; use card vault or authorize-then-capture instead

Never print `.env` contents, the client secret or access tokens.
