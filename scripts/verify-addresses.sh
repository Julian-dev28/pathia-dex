#!/usr/bin/env bash
# Asserts every hardcoded address in src/lib/chain.ts has bytecode on Base.
# A wrong address is the cheapest way to ship a router that quotes zero, and
# the cheapest thing to test for. Run before any deploy.
set -euo pipefail
RPC="${RPC_URL:-https://mainnet.base.org}"
fail=0

check() {
  local name="$1" addr="$2"
  local code
  code=$(curl -s -m 10 -X POST "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$addr\",\"latest\"]}" \
    | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')
  if [ "$code" = "0x" ] || [ -z "$code" ]; then
    printf '  FAIL  %-16s %s (no bytecode)\n' "$name" "$addr"; fail=1
  else
    printf '  ok    %-16s %s (%d bytes)\n' "$name" "$addr" $(( (${#code} - 2) / 2 ))
  fi
}

echo "Verifying Base mainnet addresses against $RPC"
grep -oE "^export const [A-Z0-9_]+ = '0x[a-fA-F0-9]{40}'" src/lib/chain.ts |
  sed -E "s/export const ([A-Z0-9_]+) = '(0x[a-fA-F0-9]{40})'/\1 \2/" |
  while read -r name addr; do check "$name" "$addr"; done

grep -oE "address: '0x[a-fA-F0-9]{40}', decimals" src/lib/chain.ts |
  grep -oE "0x[a-fA-F0-9]{40}" | while read -r addr; do check "token" "$addr"; done

grep -oE "factory: '0x[a-fA-F0-9]{40}'" src/lib/chain.ts |
  grep -oE "0x[a-fA-F0-9]{40}" | while read -r addr; do check "factory" "$addr"; done

exit $fail
