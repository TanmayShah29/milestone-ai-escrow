#!/usr/bin/env bash
# Pings each configured OpenRouter model once (uses 3 of the 50 free requests/day).
# Reads OPENROUTER_API_KEY and AI_MODEL* from .env; never prints the key.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$DIR/.env"; set +a
[ -n "${OPENROUTER_API_KEY:-}" ] || { echo "OPENROUTER_API_KEY missing in .env"; exit 1; }

echo "Key: $(curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY" | python3 -c '
import sys, json
d = json.load(sys.stdin).get("data") or {}
print("valid" if d else "INVALID", "| free tier:", d.get("is_free_tier"), "| limit remaining:", d.get("limit_remaining"))')"

for M in "${AI_MODEL:-}" "${AI_MODEL_FALLBACK:-}" "${AI_MODEL_FALLBACK_2:-}"; do
  [ -n "$M" ] || continue
  START=$(date +%s)
  OUT=$(curl -s https://openrouter.ai/api/v1/chat/completions \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$M\",\"max_tokens\":1500,\"response_format\":{\"type\":\"json_object\"},\"messages\":[{\"role\":\"user\",\"content\":\"Reply with JSON only: {\\\"verdict\\\":\\\"pass\\\",\\\"confidence\\\":0.9}\"}]}")
  printf "%-45s %3ss  " "$M" "$(( $(date +%s) - START ))"
  printf '%s' "$OUT" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "error" in d:
    print("ERROR", d["error"].get("code"), str(d["error"].get("message"))[:90])
else:
    c = (d["choices"][0]["message"].get("content") or "").strip().replace("\n", " ")
    try:
        json.loads(c); ok = "valid JSON"
    except Exception:
        ok = "not JSON"
    print("OK", ok, "|", c[:70])'
done
