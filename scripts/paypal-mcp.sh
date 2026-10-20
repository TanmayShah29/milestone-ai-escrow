#!/usr/bin/env bash
# Starts the PayPal MCP server with a freshly generated access token (avoids 3-8h token expiry)
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$DIR/.env"; set +a
export PAYPAL_ACCESS_TOKEN="$("$DIR/scripts/paypal-token.sh")"
export PAYPAL_ENVIRONMENT="${PAYPAL_ENVIRONMENT:-SANDBOX}"
exec npx -y @paypal/mcp --tools=all
