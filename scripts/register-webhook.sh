#!/usr/bin/env bash
# Registers (or finds) the PayPal sandbox webhook for a URL and prints its id (not a secret).
# Usage: ./scripts/register-webhook.sh https://milestone-ai-escrow.onrender.com/api/paypal/webhook
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
URL="${1:?webhook URL required}"
TOKEN="$("$DIR/scripts/paypal-token.sh")"
BASE="https://api-m.sandbox.paypal.com"

EXISTING="$(curl -s "$BASE/v1/notifications/webhooks" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import sys,json; u=sys.argv[1]; print(next((w["id"] for w in json.load(sys.stdin).get("webhooks",[]) if w["url"]==u),""))' "$URL")"
if [ -n "$EXISTING" ]; then echo "$EXISTING"; exit 0; fi

EVENTS='CHECKOUT.ORDER.APPROVED PAYMENT.AUTHORIZATION.CREATED PAYMENT.AUTHORIZATION.VOIDED PAYMENT.CAPTURE.COMPLETED PAYMENT.CAPTURE.PENDING PAYMENT.CAPTURE.DECLINED PAYMENT.CAPTURE.REFUNDED PAYMENT.CAPTURE.REVERSED PAYMENT.PAYOUTS-ITEM.SUCCEEDED PAYMENT.PAYOUTS-ITEM.FAILED PAYMENT.PAYOUTS-ITEM.UNCLAIMED PAYMENT.PAYOUTS-ITEM.RETURNED PAYMENT.PAYOUTSBATCH.SUCCESS PAYMENT.PAYOUTSBATCH.DENIED CUSTOMER.DISPUTE.CREATED CUSTOMER.DISPUTE.UPDATED CUSTOMER.DISPUTE.RESOLVED'
BODY="$(python3 -c 'import sys,json; print(json.dumps({"url":sys.argv[1],"event_types":[{"name":e} for e in sys.argv[2].split()]}))' "$URL" "$EVENTS")"
curl -s "$BASE/v1/notifications/webhooks" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$BODY" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["id"]) if "id" in d else sys.exit("Webhook error: "+json.dumps(d))'
