#!/usr/bin/env bash
# Local copy of the runner workflow's container step: worker and tests in separate containers, no network.
set -euo pipefail
cd "$(dirname "$0")"
FIXTURE="$1"; NONCE="local-$(date +%s)"
IMG=node:22-alpine
VOL="msock-$FIXTURE-$$"
rm -rf "out-$FIXTURE" && mkdir -p "out-$FIXTURE" && chmod 777 "out-$FIXTURE"
docker volume create "$VOL" >/dev/null
docker run --rm -v "$VOL:/sock" "$IMG" chmod 777 /sock
docker run -d --name "worker-$VOL" --network none --read-only --tmpfs /tmp --user 1000:1000 \
  -v "$PWD/fixtures/$FIXTURE:/work:ro" -v "$PWD/harness:/harness:ro" -v "$VOL:/sock" \
  "$IMG" node /harness/shim.mjs /work/index.mjs /sock/rpc.sock >/dev/null
sleep 3
docker run --rm --network none --read-only --user 1000:1000 -e RPC_SOCK=/sock/rpc.sock \
  -v "$PWD/fixtures/tests:/tests:ro" -v "$PWD/harness:/harness:ro" -v "$VOL:/sock" -v "$PWD/out-$FIXTURE:/out" \
  "$IMG" node --test --test-reporter=junit --test-reporter-destination=/out/junit.xml "/tests/*.test.mjs" || true
echo "--- worker log"; docker logs "worker-$VOL" 2>&1 || true
docker rm -f "worker-$VOL" >/dev/null; docker volume rm -f "$VOL" >/dev/null
IMAGE=$(docker image inspect "$IMG" --format '{{index .RepoDigests 0}}')
node harness/results.mjs "out-$FIXTURE/junit.xml" "$NONCE" "$FIXTURE" local "$IMAGE" > "out-$FIXTURE/results.json"
echo "--- results"; cat "out-$FIXTURE/results.json"
