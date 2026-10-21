#!/usr/bin/env bash
# PayPal Multiparty feasibility spike (sandbox only).
# Tests whether this app can create orders where the money lands with a third-party payee
# (purchase_units[].payee) with a platform cut (payment_instruction.platform_fees), and whether
# delayed disbursement (disbursement_mode DELAYED + /v1/payments/referenced-payouts-items) works.
# Funds with PayPal's sandbox test Visa, the same way src/lib/money/flow.ts fundWithTestCard does.
# Every amount is <= $1.00. Every hold it creates is voided; every capture is refunded where possible.
# Never prints the client secret or access token. Usage: ./scripts/multiparty-check.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$DIR/.env"; set +a
B="https://api-m.sandbox.paypal.com"   # sandbox only, never live

FREELANCER="sb-puo47p53461265@personal.example.com"   # personal account
CLIENT="sb-eg47t53461254@personal.example.com"        # personal account
PLATFORM="sb-47hvxh49451990@business.example.com"     # the app's own business account

RESP=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" -d grant_type=client_credentials "$B/v1/oauth2/token")
TOKEN=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))")
[ -n "$TOKEN" ] || { echo "AUTH FAILED: check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env"; exit 1; }
printf '%s' "$RESP" | python3 -c '
import sys, json
d = json.load(sys.stdin); s = d.get("scope", "")
print("App:", d.get("app_id"), " date:", __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M"))
for k in ["referenced-payouts", "partnerreferral", "payments/payouts", "seller-onboarding", "payment/authcapture"]:
    print(f"  scope contains {k!r}:", "yes" if k in s else "no")'

T=$(date +%s)
CARD='{"card":{"name":"Milestone Demo Client","number":"4005519200000004","expiry":"2030-12","security_code":"123"}}'
OUT="${TMPDIR:-/tmp}/mp-$T"; mkdir -p "$OUT"

# post <label> <path> <request-id> <json-body>: POSTs, saves body to $OUT/<label>.json, prints a summary.
post() {
  local label="$1" path="$2" rid="$3" body="$4"
  local code
  code=$(curl -s -o "$OUT/$label.json" -w "%{http_code}" -X POST "$B$path" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -H "Prefer: return=representation" -H "PayPal-Request-Id: $rid" -d "$body")
  echo; echo "== $label  POST $path  -> HTTP $code"
  python3 - "$OUT/$label.json" <<'PY'
import sys, json
try: d = json.load(open(sys.argv[1]))
except Exception: print("  (no JSON body)"); sys.exit()
def p(k, v):
    if v not in (None, "", [], {}): print(f"  {k}: {v}")
p("status", d.get("status")); p("id", d.get("id"))
p("name", d.get("name")); p("message", d.get("message")); p("debug_id", d.get("debug_id"))
for x in d.get("details") or []:
    print(f"  issue: {x.get('issue')}  field: {x.get('field')}  -- {x.get('description')}")
for pu in d.get("purchase_units") or []:
    p("payee", pu.get("payee")); p("payment_instruction", pu.get("payment_instruction"))
    pay = pu.get("payments") or {}
    for kind in ("authorizations", "captures"):
        for a in pay.get(kind) or []:
            print(f"  {kind[:-1]}: {a.get('id')} {a.get('status')} {a.get('status_details') or ''}")
            p("    seller_receivable_breakdown", a.get("seller_receivable_breakdown"))
p("seller_receivable_breakdown", d.get("seller_receivable_breakdown"))
p("payee(top)", d.get("payee"))
if "processing_state" in d: p("processing_state", d.get("processing_state"))
for k in ("item", "reference_id", "reference_type", "payout_destination", "payout_transaction_id"):
    p(k, d.get(k))
PY
}
# jget <label> <python-expr on d>: extract a value from a saved response.
jget() { python3 -c "import json,sys;d=json.load(open('$OUT/$1.json'))
try: print($2)
except Exception: print('')"; }
AUTH_ID='d["purchase_units"][0]["payments"]["authorizations"][0]["id"]'
CAP_ID='d["purchase_units"][0]["payments"]["captures"][0]["id"]'

order() {  # order <intent> <purchase_unit-extras-json>
  echo "{\"intent\":\"$1\",\"purchase_units\":[{\"amount\":{\"currency_code\":\"USD\",\"value\":\"1.00\"},\"custom_id\":\"mp-spike-$T\"$2}],\"payment_source\":$CARD}"
}

echo; echo "################ 1. AUTHORIZE, payee = freelancer (PERSONAL account) ################"
post 1-order /v2/checkout/orders "mp1-$T" "$(order AUTHORIZE ",\"payee\":{\"email_address\":\"$FREELANCER\"}")"
A1=$(jget 1-order "$AUTH_ID")
if [ -n "$A1" ]; then
  post 1-capture "/v2/payments/authorizations/$A1/capture" "mp1c-$T" '{"amount":{"currency_code":"USD","value":"1.00"},"final_capture":true}'
  C1=$(jget 1-capture 'd["id"]')
  [ -n "$C1" ] && post 1-refund "/v2/payments/captures/$C1/refund" "mp1r-$T" '{}'
  [ -z "$C1" ] && post 1-void "/v2/payments/authorizations/$A1/void" "mp1v-$T" '{}'
fi

echo; echo "################ 1b. AUTHORIZE, payee = client (PERSONAL, different person) ################"
post 1b-order /v2/checkout/orders "mp1b-$T" "$(order AUTHORIZE ",\"payee\":{\"email_address\":\"$CLIENT\"}")"
A1b=$(jget 1b-order "$AUTH_ID"); [ -n "$A1b" ] && post 1b-void "/v2/payments/authorizations/$A1b/void" "mp1bv-$T" '{}'

echo; echo "################ 2. AUTHORIZE, payee = freelancer + platform_fees 0.25 ################"
PF='"payment_instruction":{"platform_fees":[{"amount":{"currency_code":"USD","value":"0.25"}}]}'
post 2-order /v2/checkout/orders "mp2-$T" "$(order AUTHORIZE ",\"payee\":{\"email_address\":\"$FREELANCER\"},$PF")"
A2=$(jget 2-order "$AUTH_ID")
if [ -n "$A2" ]; then
  post 2-capture "/v2/payments/authorizations/$A2/capture" "mp2c-$T" '{"final_capture":true}'
  C2=$(jget 2-capture 'd["id"]'); [ -n "$C2" ] && post 2-refund "/v2/payments/captures/$C2/refund" "mp2r-$T" '{}'
  [ -z "$C2" ] && post 2-void "/v2/payments/authorizations/$A2/void" "mp2v-$T" '{}'
fi

echo; echo "################ 2b. AUTHORIZE, no payee (platform is payee) + platform_fees 0.25 ################"
post 2b-order /v2/checkout/orders "mp2b-$T" "$(order AUTHORIZE ",$PF")"
A2b=$(jget 2b-order "$AUTH_ID"); [ -n "$A2b" ] && post 2b-void "/v2/payments/authorizations/$A2b/void" "mp2bv-$T" '{}'

echo; echo "################ 2c. AUTHORIZE with payee only, then platform_fees on the CAPTURE call ################"
post 2c-order /v2/checkout/orders "mp2c-$T" "$(order AUTHORIZE ",\"payee\":{\"email_address\":\"$FREELANCER\"}")"
A2c=$(jget 2c-order "$AUTH_ID")
if [ -n "$A2c" ]; then
  post 2c-capture "/v2/payments/authorizations/$A2c/capture" "mp2cc-$T" "{\"final_capture\":true,$PF}"
  C2c=$(jget 2c-capture 'd["id"]')
  if [ -n "$C2c" ]; then post 2c-refund "/v2/payments/captures/$C2c/refund" "mp2cr-$T" '{}'
  else post 2c-void "/v2/payments/authorizations/$A2c/void" "mp2cv-$T" '{}'; fi
fi

echo; echo "################ 3. CAPTURE + payee + disbursement_mode DELAYED, then referenced-payouts-items ################"
post 3-order /v2/checkout/orders "mp3-$T" "$(order CAPTURE ",\"payee\":{\"email_address\":\"$FREELANCER\"},\"payment_instruction\":{\"disbursement_mode\":\"DELAYED\"}")"
C3=$(jget 3-order "$CAP_ID")
if [ -n "$C3" ]; then
  post 3-release /v1/payments/referenced-payouts-items "mp3p-$T" "{\"reference_id\":\"$C3\",\"reference_type\":\"TRANSACTION_ID\"}"
  post 3-refund "/v2/payments/captures/$C3/refund" "mp3r-$T" '{}'
fi

echo; echo "################ 3b. CAPTURE, no payee, disbursement_mode DELAYED ################"
post 3b-order /v2/checkout/orders "mp3b-$T" "$(order CAPTURE ",\"payment_instruction\":{\"disbursement_mode\":\"DELAYED\"}")"
C3b=$(jget 3b-order "$CAP_ID")
if [ -n "$C3b" ]; then
  post 3b-release /v1/payments/referenced-payouts-items "mp3bp-$T" "{\"reference_id\":\"$C3b\",\"reference_type\":\"TRANSACTION_ID\"}"
  post 3b-refund "/v2/payments/captures/$C3b/refund" "mp3br-$T" '{}'
fi

echo; echo "################ 4. Partner Referrals API reachable? (seller onboarding link; creates nothing payable) ################"
post 4-referral /v2/customer/partner-referrals "mp4-$T" '{"tracking_id":"mp-spike-'$T'","operations":[{"operation":"API_INTEGRATION","api_integration_preference":{"rest_api_integration":{"integration_method":"PAYPAL","integration_type":"THIRD_PARTY","third_party_details":{"features":["PAYMENT","REFUND","PARTNER_FEE","DELAY_FUNDS_DISBURSEMENT"]}}}}],"products":["EXPRESS_CHECKOUT"],"legal_consents":[{"type":"SHARE_DATA_CONSENT","granted":true}]}'

echo; echo "################ 5. Isolate each blocker ################"
# 5a: card, payee = the platform's own business account (control: should behave like today's flow).
post 5a-order /v2/checkout/orders "mp5a-$T" "$(order AUTHORIZE ",\"payee\":{\"email_address\":\"$PLATFORM\"}")"
A5a=$(jget 5a-order "$AUTH_ID"); [ -n "$A5a" ] && post 5a-void "/v2/payments/authorizations/$A5a/void" "mp5av-$T" '{}'
# 5b: card, no payee, platform_fees on the authorization CAPTURE call (the documented AUTHORIZE path).
post 5b-order /v2/checkout/orders "mp5b-$T" "$(order AUTHORIZE "")"
A5b=$(jget 5b-order "$AUTH_ID")
if [ -n "$A5b" ]; then
  post 5b-capture "/v2/payments/authorizations/$A5b/capture" "mp5bc-$T" "{\"final_capture\":true,$PF}"
  C5b=$(jget 5b-capture 'd["id"]')
  if [ -n "$C5b" ]; then post 5b-refund "/v2/payments/captures/$C5b/refund" "mp5br-$T" '{}'
  else post 5b-void "/v2/payments/authorizations/$A5b/void" "mp5bv-$T" '{}'; fi
fi
# 5c: card, CAPTURE intent, no payee, platform_fees at order create.
post 5c-order /v2/checkout/orders "mp5c-$T" "$(order CAPTURE ",$PF")"
C5c=$(jget 5c-order "$CAP_ID"); [ -n "$C5c" ] && post 5c-refund "/v2/payments/captures/$C5c/refund" "mp5cr-$T" '{}'
# 5d/5e: PayPal-wallet orders (no payment_source, so nothing is charged; they expire unapproved).
# Shows whether a PERSONAL payee and platform_fees pass create-time validation without a card.
WALLET() { echo "{\"intent\":\"$1\",\"purchase_units\":[{\"amount\":{\"currency_code\":\"USD\",\"value\":\"1.00\"}$2}]}"; }
post 5d-order /v2/checkout/orders "mp5d-$T" "$(WALLET AUTHORIZE ",\"payee\":{\"email_address\":\"$FREELANCER\"}")"
post 5e-order /v2/checkout/orders "mp5e-$T" "$(WALLET CAPTURE ",\"payee\":{\"email_address\":\"$FREELANCER\"},$PF")"

echo; echo "Raw responses saved in $OUT (no tokens in them)."
