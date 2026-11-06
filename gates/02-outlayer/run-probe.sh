#!/usr/bin/env bash
# Gate (b): a testnet contract calls OutLayer, yields, and receives the candle job's output.
# Prereqs: rustup target wasm32-wasip2 + wasm32-unknown-unknown, cargo-near, near-cli-rs, wasmtime (optional).
# Usage:
#   ME=yourname.testnet ./run-probe.sh build        # build both wasm files, print the job's sha256
#   (push gates/02-outlayer/candle-job.wasm to a PUBLIC GitHub repo, then:)
#   ME=yourname.testnet WASM_URL=https://raw.githubusercontent.com/<you>/<repo>/main/gates/02-outlayer/candle-job.wasm ./run-probe.sh deploy
#   ME=yourname.testnet ./run-probe.sh call         # request a Hyperliquid ETH candle through OutLayer
#   ME=yourname.testnet ./run-probe.sh result       # read what came back
# PASS = `result` shows "ok": true with a close price, and the explorer shows the callback receipt.
set -euo pipefail
cd "$(dirname "$0")"
: "${ME:?set ME=yourname.testnet}"
PROBE="probe.${ME}"
OUTLAYER="outlayer.testnet"

case "${1:-}" in
  build)
    (cd candle-job && cargo build --target wasm32-wasip2 --release)
    cp candle-job/target/wasm32-wasip2/release/candle-job.wasm ./candle-job.wasm
    sha256sum candle-job.wasm | cut -d' ' -f1 > candle-job.sha256
    echo "job sha256: $(cat candle-job.sha256)"
    if command -v wasmtime >/dev/null; then
      now=$(($(date +%s)*1000))
      echo "local run (needs network):"
      echo "{\"source\":\"hyperliquid\",\"coin\":\"ETH\",\"start_ms\":$((now-600000)),\"end_ms\":$now}" \
        | wasmtime run -S http candle-job.wasm; echo
    fi
    (cd probe-contract && cargo near build non-reproducible-wasm)
    ls -l probe-contract/target/near/*.wasm
    ;;
  deploy)
    : "${WASM_URL:?set WASM_URL to the https URL of candle-job.wasm}"
    HASH=$(cat candle-job.sha256)
    echo "checking the URL serves the same bytes..."
    [ "$(curl -sL "$WASM_URL" | sha256sum | cut -d' ' -f1)" = "$HASH" ] || { echo "URL bytes do not match candle-job.wasm"; exit 1; }
    near account create-account fund-myself "$PROBE" '3 NEAR' autogenerate-new-keypair save-to-keychain sign-as "$ME" network-config testnet sign-with-keychain send || true
    near contract deploy "$PROBE" use-file probe-contract/target/near/outlayer_probe.wasm \
      with-init-call new json-args "{\"outlayer\":\"$OUTLAYER\",\"wasm_url\":\"$WASM_URL\",\"wasm_hash\":\"$HASH\"}" \
      prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
    ;;
  call)
    echo "OutLayer's cost estimate for these limits (yoctoNEAR):"
    near contract call-function as-read-only "$OUTLAYER" estimate_execution_cost \
      json-args '{"resource_limits":{"max_instructions":2000000000,"max_memory_mb":128,"max_execution_seconds":60},"input_len":120}' \
      network-config testnet now || true
    near contract call-function as-transaction "$PROBE" request_hl_candle json-args '{"coin":"ETH"}' \
      prepaid-gas '300.0 Tgas' attached-deposit '0.05 NEAR' sign-as "$ME" network-config testnet sign-with-keychain send
    ;;
  call-gt)
    : "${POOL:?set POOL to a Solana pool address from gate (d)}"
    near contract call-function as-transaction "$PROBE" request_gt_candle json-args "{\"network\":\"solana\",\"pool\":\"$POOL\"}" \
      prepaid-gas '300.0 Tgas' attached-deposit '0.05 NEAR' sign-as "$ME" network-config testnet sign-with-keychain send
    ;;
  result)
    near contract call-function as-read-only "$PROBE" last_result empty-args network-config testnet now
    ;;
  *) echo "usage: ME=you.testnet $0 build|deploy|call|call-gt|result"; exit 1;;
esac
