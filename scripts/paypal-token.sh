#!/usr/bin/env bash
# Prints a fresh PayPal sandbox access token using credentials from ../.env
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$DIR/.env"; set +a
BASE="https://api-m.sandbox.paypal.com"
[ "${PAYPAL_ENVIRONMENT:-SANDBOX}" = "PRODUCTION" ] && BASE="https://api-m.paypal.com"
curl -s "$BASE/v1/oauth2/token" -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
  -d grant_type=client_credentials \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["access_token"]) if "access_token" in d else sys.exit("Token error: "+json.dumps(d))'
