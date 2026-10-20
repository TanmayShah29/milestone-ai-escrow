#!/usr/bin/env bash
# Reports which PayPal sandbox capabilities work for the app in .env.
# Default mode is read-only. --deep also creates small test objects ($1 payout, $1 card capture, card vault token).
# Never prints the client secret or access token.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$DIR/.env"; set +a
B="https://api-m.sandbox.paypal.com"
DEEP="${1:-}"

RESP=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials "$B/v1/oauth2/token")
TOKEN=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))")
[ -n "$TOKEN" ] || { echo "AUTH FAILED: check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env"; exit 1; }
APP=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('app_id','?'))")
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
T=$(date +%s)

row() { printf "%-28s %-8s %s\n" "$1" "$2" "${3:-}"; }
code() { curl -s -o /dev/null -w "%{http_code}" "${H[@]}" "$@"; }
verdict() { case "$1" in 2*) echo OK;; 401|403) echo BLOCKED;; *) echo "HTTP $1";; esac; }

echo "App: $APP   ($(date '+%Y-%m-%d %H:%M'))"
SCOPES=$(printf '%s' "$RESP" | python3 -c '
import sys, json
s = json.load(sys.stdin)["scope"]
print(" ".join(k + "=" + ("y" if k in s else "n") for k in ["invoicing", "payouts", "subscriptions", "vault", "disputes", "reporting"]))')
echo "Scopes: $SCOPES"
echo
row "CAPABILITY" "STATUS" "DETAIL"

c=$(code -X POST "$B/v2/checkout/orders" -d '{"intent":"AUTHORIZE","purchase_units":[{"amount":{"currency_code":"USD","value":"1.00"}}]}')
row "Orders (AUTHORIZE intent)" "$(verdict "$c")" "creates an unapproved \$1 order; it expires unused"
row "Invoicing (list)" "$(verdict "$(code "$B/v2/invoicing/invoices?page_size=1")")"
row "Transaction search" "$(verdict "$(code "$B/v1/reporting/transactions?start_date=$(date -u -v-7d +%Y-%m-%dT00:00:00Z)&end_date=$(date -u +%Y-%m-%dT%H:%M:%SZ)")")"
row "Subscriptions (list plans)" "$(verdict "$(code "$B/v1/billing/plans?page_size=1")")"
row "Disputes (list)" "$(verdict "$(code "$B/v1/customer/disputes?page_size=1")")"
row "Webhooks (list)" "$(verdict "$(code "$B/v1/notifications/webhooks")")"

if [ "$DEEP" = "--deep" ]; then
  echo; echo "Deep checks (create sandbox test objects):"
  out=$(curl -s "${H[@]}" -X POST "$B/v1/payments/payouts" -d '{"sender_batch_header":{"sender_batch_id":"chk-'$T'"},"items":[{"recipient_type":"EMAIL","amount":{"value":"1.00","currency":"USD"},"receiver":"sandbox-check@example.com"}]}')
  row "Payouts" "$(printf '%s' "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print('OK' if d.get('batch_header') else 'BLOCKED')")" "$(printf '%s' "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('batch_header',{}).get('batch_status') or d.get('name'))")"
  out=$(curl -s "${H[@]}" -H "PayPal-Request-Id: card-$T" -X POST "$B/v2/checkout/orders" -d '{"intent":"CAPTURE","purchase_units":[{"amount":{"currency_code":"USD","value":"1.00"}}],"payment_source":{"card":{"number":"4005519200000004","expiry":"2030-12","security_code":"123","name":"Sandbox Check"}}}')
  row "Card capture" "$(printf '%s' "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print('OK' if d.get('status')=='COMPLETED' else 'BLOCKED')")" "$(printf '%s' "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status') or (d.get('details') or [{}])[0].get('issue'))")"
  out=$(curl -s "${H[@]}" -H "PayPal-Request-Id: vc-$T" -X POST "$B/v3/vault/setup-tokens" -d '{"payment_source":{"card":{"number":"4005519200000004","expiry":"2030-12","security_code":"123","name":"Sandbox Check"}}}')
  row "Vault: card" "$(printf '%s' "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print('OK' if d.get('status') else 'BLOCKED')")" "$(printf '%s' "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status') or (d.get('details') or [{}])[0].get('issue'))")"
  out=$(curl -s "${H[@]}" -H "PayPal-Request-Id: vp-$T" -X POST "$B/v3/vault/setup-tokens" -d '{"payment_source":{"paypal":{"usage_type":"MERCHANT","experience_context":{"return_url":"https://example.com/r","cancel_url":"https://example.com/c"}}}}')
  row "Vault: PayPal wallet" "$(printf '%s' "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print('OK' if d.get('status') else 'BLOCKED')")" "$(printf '%s' "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status') or (d.get('details') or [{}])[0].get('issue'))")"
fi
