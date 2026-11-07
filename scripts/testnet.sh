#!/usr/bin/env bash
# Testnet operations for the workflow (v2: channels, subscriptions, signals). Usage: scripts/testnet.sh <action>
#   accounts : main account via faucet (+ a faucet funder) and member sub-accounts
#   wipe-app : delete app.<main> (its NEAR goes back to <main>) so a fresh contract can be deployed
#   deploy   : create app.<main> if needed and deploy (fresh: init with a daily period) or upgrade
#   e2e      : the full v2 loop on a throwaway contract with a 20-minute period, then deletes it:
#              channel -> subscribe -> sealed BTC signal -> member reads -> drand reveal ->
#              settle via OutLayer -> release or refund claim. ~35 minutes.
#   settle   : reveal sealed signals of channel $CH (default 0) on app.<main> from drand, then settle
#   status   : balances, config and channels on app.<main>
# Env: MAIN, PUBKEY, SK (private key), SCORER_URL, SCORER_HASH
set -uo pipefail
cd "$(dirname "$0")"
APP="app.$MAIN"; M1="m1.$MAIN"; M2="m2.$MAIN"
# near-cli-rs (Nov 2026): the private key is positional; --signer-public-key was removed.
SIGN=(sign-with-plaintext-private-key "$SK" send)
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
exists() { near account view-account-summary "$1" network-config testnet now >/dev/null 2>&1; }
bal() { near account view-account-summary "$1" network-config testnet now 2>&1 | grep -oE "Native account balance[^│]*" | head -1; }
call() { # signer contract method json deposit [gas Tgas, default 100]
  near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas "${6:-100}.0 Tgas" attached-deposit "$5" sign-as "$1" network-config testnet "${SIGN[@]}" 2>&1 \
    | grep -iE "Transaction ID|EVENT_JSON|error|panicked|return value" | head -12 | sed 's/^/    /'
}
view() { node sc.mjs view "$C" "$1" "$2"; }
wait_until() { local t=$1; while [ "$(date +%s)" -lt "$t" ]; do sleep 10; done; }
js() { node -e "$1" "${@:2}"; }
WASM=../contract/target/near/sealed_calls.wasm
build() { (cd ../contract && cargo near build non-reproducible-wasm --no-embed-abi 2>&1 | tail -2); log "wasm sha256 $(sha256sum "$WASM" | cut -d' ' -f1)"; }
config_json() { # period_minutes
  echo "{\"config\":{\"owner\":\"$MAIN\",\"period_minutes\":$1,\"grace_min\":30,\"min_signals\":1,\"max_signals_per_day\":10,\"scorer_wasm_url\":\"$SCORER_URL\",\"scorer_wasm_hash\":\"$SCORER_HASH\",\"outlayer\":\"outlayer.testnet\",\"reference_usd\":500,\"liquidity_floor_usd\":100000}}"
}

# Refuse to sign anything unless the secret's key really is a full-access key of $MAIN on testnet.
preflight() {
  local r
  r=$(curl -s https://rpc.testnet.near.org -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key\",\"finality\":\"final\",\"account_id\":\"$MAIN\",\"public_key\":\"$PUBKEY\"}}")
  if echo "$r" | grep -q '"FullAccess"'; then log "key check OK: $PUBKEY is a full-access key of $MAIN"; return 0; fi
  log "STOP: $PUBKEY is not a full-access key of $MAIN on testnet. Put $MAIN's testnet private key in NEAR_PRIVATE_KEY."
  echo "$r" | head -c 300; echo; exit 1
}
preflight
npm install --silent >/dev/null 2>&1

# Reveal every sealed signal of channel $2 on contract $1 that drand can open (waits up to 25 min for one).
reveal_all() {
  local C=$1 CH=$2
  view list_signals "{\"channel\":$CH,\"limit\":100}" > /tmp/sigs.json
  for ID in $(js "for (const s of require('/tmp/sigs.json')) if (s.status==='Sealed') console.log(s.id)"); do
    js "require('fs').writeFileSync('/tmp/s.json',JSON.stringify(require('/tmp/sigs.json').find(s=>s.id==$ID)))"
    RT=$(js "const s=require('/tmp/s.json');console.log(1692803367+(s.reveal_round-1)*3+10)")
    if [ "$RT" -gt "$(date +%s)" ] && [ $((RT - $(date +%s))) -lt 1500 ]; then log "signal $ID: waiting $(( RT - $(date +%s) ))s for drand"; wait_until "$RT"; fi
    if OPENED=$(node sc.mjs tlock-open /tmp/s.json 2>/dev/null); then
      log "signal $ID opened from drand: $OPENED"
      PT=$(js "console.log(JSON.stringify(JSON.parse(process.argv[1]).plaintext))" "$OPENED")
      call "$M2" "$C" reveal "{\"signal_id\":$ID,\"plaintext\":$PT}" '0 NEAR'
    else
      log "signal $ID cannot be opened yet; trying mark_unrevealed"
      call "$M2" "$C" mark_unrevealed "{\"signal_id\":$ID}" '0 NEAR'
    fi
  done
}

# Settle periods of channel $2 on $1 until none is ready; prints results.
settle_ready() {
  local C=$1 CH=$2
  for k in 1 2 3 4 5 6; do
    local NP; NP=$(view get_channel "{\"channel\":$CH}" | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).next_period))")
    local CUR; CUR=$(view current_period "{\"channel\":$CH}")
    [ "$NP" -lt "$CUR" ] || { log "period $NP has not ended yet (current $CUR)"; break; }
    log "settle channel $CH period $NP (held $(view period_held "{\"channel\":$CH,\"period\":$NP}"))"
    call "$MAIN" "$C" settle "{\"channel\":$CH}" '0.5 NEAR' 300
    local R=null
    for i in $(seq 1 30); do
      R=$(view get_period "{\"channel\":$CH,\"period\":$NP}")
      echo "$R" | grep -q '"Settled"' && break
      [ "$R" = "null" ] && [ "$i" -gt 2 ] && { log "   scoring failed; period reopened"; break; }
      sleep 10
    done
    log "   period $NP: $R"
    echo "$R" | grep -q '"Settled"' || return 1
  done
}

ARG="${1#*=}"
case "${1%%=*}" in
accounts)
  exists "$MAIN" || near account create-account sponsor-by-faucet-service "$MAIN" use-manually-provided-public-key "$PUBKEY" network-config testnet create
  FUND="scfund-${MAIN%%.*}-$(date +%j%H).testnet"   # one funder per hour; the faucet gives some NEAR each
  exists "$FUND" || near account create-account sponsor-by-faucet-service "$FUND" use-manually-provided-public-key "$PUBKEY" network-config testnet create >/dev/null 2>&1 || log "funder faucet unavailable"
  if exists "$FUND" && bal "$FUND" | grep -qE "balance +[1-9][0-9]*(\.[0-9]+)? NEAR"; then
    sleep 3; near tokens "$FUND" send-near "$MAIN" '9.5 NEAR' network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "Transaction ID|error" | head -3
  fi
  for spec in "$M1:0.5" "$M2:0.5"; do
    a="${spec%%:*}"; amt="${spec##*:} NEAR"
    if exists "$a"; then log "$a exists"; continue; fi
    near account create-account fund-myself "$a" "$amt" use-manually-provided-public-key "$PUBKEY" sign-as "$MAIN" network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "Transaction ID|error|created" | head -5
  done
  for a in "$MAIN" "$APP" "$M1" "$M2"; do log "$a: $(bal "$a")"; done
  ;;

delete)  # delete=<account> (a sub-account of MAIN); its NEAR goes back to MAIN
  near account delete-account "$ARG" beneficiary "$MAIN" network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "error|deleted" | head -3
  ;;

wipe-app)
  if exists "$APP"; then
    near account delete-account "$APP" beneficiary "$MAIN" network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "Transaction ID|error|deleted" | head -5
  fi
  sleep 3; log "$MAIN: $(bal "$MAIN")"
  ;;

deploy)
  : "${SCORER_URL:?}" "${SCORER_HASH:?}"
  exists "$APP" || near account create-account fund-myself "$APP" '3.4 NEAR' use-manually-provided-public-key "$PUBKEY" sign-as "$MAIN" network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "Transaction ID|error|created" | head -5
  build
  C=$APP
  NEED=$(js "console.log(Math.ceil(require('fs').statSync('$WASM').size/1e5*10+3)/10)")   # 1 NEAR per 100 kB of code + margin
  log "code needs about $NEED NEAR of storage"
  if ! view get_config '{}' >/dev/null 2>&1; then
    near tokens "$MAIN" send-near "$APP" '0.5 NEAR' network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "error" | head -2
  fi
  if view get_config '{}' >/dev/null 2>&1; then
    log "upgrading existing v2 contract (state kept); pointing it at the current scorer; +0.3 NEAR for late-access storage"
    near tokens "$MAIN" send-near "$APP" '0.3 NEAR' network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "error" | head -2
    near contract deploy "$APP" use-file "$WASM" without-init-call network-config testnet "${SIGN[@]}" 2>&1 | grep -E "Transaction ID|Error"
    sleep 3
    CFG=$(view get_config '{}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);c.scorer_wasm_url=process.argv[1];c.scorer_wasm_hash=process.argv[2];console.log(JSON.stringify({config:c}))})" "$SCORER_URL" "$SCORER_HASH")
    call "$MAIN" "$APP" set_config "$CFG" '0 NEAR'
  else
    near contract deploy "$APP" use-file "$WASM" with-init-call new json-args "$(config_json 1440)" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet "${SIGN[@]}" 2>&1 | grep -E "Transaction ID|Error"
  fi
  sleep 3; log "config: $(view get_config '{}' 2>&1 | head -c 400)"
  ;;

e2e)
  : "${SCORER_URL:?}" "${SCORER_HASH:?}"
  [ "$(curl -sL "$SCORER_URL" | sha256sum | cut -d' ' -f1)" = "$SCORER_HASH" ] || { log "FAIL scorer URL bytes do not match hash"; exit 1; }
  C="e2e$(date -u +%d%H%M).$MAIN"
  build
  NEED=$(js "console.log((Math.ceil(require('fs').statSync('$WASM').size/1e4)/10+0.25).toFixed(2))")
  log "0. throwaway contract $C with a 20-minute period ($NEED NEAR for storage; $MAIN has $(bal "$MAIN"))"
  near account create-account fund-myself "$C" "$NEED NEAR" use-manually-provided-public-key "$PUBKEY" sign-as "$MAIN" network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "error|created" | head -3
  near contract deploy "$C" use-file "$WASM" with-init-call new json-args "$(config_json 20)" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet "${SIGN[@]}" 2>&1 | grep -E "Error"
  sleep 3; view get_config '{}' >/dev/null || { log "FAIL deploy"; exit 1; }
  cleanup() { log "deleting $C (NEAR back to $MAIN)"; near account delete-account "$C" beneficiary "$MAIN" network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "error" | head -2; }
  trap cleanup EXIT

  log "1. $MAIN creates a channel: 1 day for 0.2 NEAR, 7 days for 1 NEAR"
  call "$MAIN" "$C" create_channel '{"name":"E2E desk","about":"test","plans":[{"days":1,"price":"200000000000000000000000"},{"days":7,"price":"1000000000000000000000000"}],"max_members":25}' '0.05 NEAR'
  log "2. $M1 subscribes (1 day) and registers a key; $M2 subscribes without a key"
  call "$M1" "$C" subscribe '{"channel":0,"plan":0}' '0.25 NEAR'
  PUB=$(node sc.mjs member-keygen /tmp/m1.key)
  call "$M1" "$C" register_key "{\"channel\":0,\"pubkey\":\"$PUB\"}" '0 NEAR'
  call "$M2" "$C" subscribe '{"channel":0,"plan":0}' '0.25 NEAR'
  log "   subscribers: $(view subscribers '{"channel":0}')"
  log "   held for period 0: $(view period_held '{"channel":0,"period":0}')  (half of 0.4 NEAR, spread over each day)"

  BTC=$(curl -s https://api.hyperliquid.xyz/info -H 'content-type: application/json' -d '{"type":"allMids"}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).BTC))")
  SIG=$(js "const p=Number(process.argv[1]);const f=x=>x.toFixed(0);console.log(JSON.stringify({market:{venue:'hyperliquid',address:'BTC',symbol:'BTC'},side:'long',leverage:5,entry_low:f(p*0.995),entry_high:f(p*1.005),tps:[f(p*1.004+p*0.002),f(p*1.02)],sl:f(p*0.98),msg:'E2E: BTC long around '+f(p)}))" "$BTC")
  READERS=$(view readers_now '{"channel":0}')
  log "3. seal + post a BTC long (valid 15 min) for readers $READERS: $SIG"
  node sc.mjs seal 0 "$MAIN" "$SIG" 15 "$READERS" /tmp/post.json
  call "$MAIN" "$C" post_signal "$(cat /tmp/post.json)" '0.1 NEAR' 200
  sleep 3; view get_signal '{"signal_id":0}' > /tmp/s0.json || { log "FAIL no signal"; exit 1; }
  log "4. member reads it now: $(node sc.mjs member-open /tmp/s0.json "$M1" /tmp/m1.key)"
  log "   public tlock-open now (must fail): $(node sc.mjs tlock-open /tmp/s0.json 2>&1 | head -c 120)"
  log "   early reveal (must fail):"; call "$M2" "$C" reveal "{\"signal_id\":0,\"plaintext\":$(js "console.log(JSON.stringify(require('fs').readFileSync('/tmp/post.json.plaintext','utf8')))")}" '0 NEAR'

  log "5. after validity, anyone reveals from drand"
  reveal_all "$C" 0
  log "   revealed: $(view get_signal '{"signal_id":0}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);console.log(JSON.stringify({status:x.status,body:x.body}))})")"

  PEND=$(view get_channel '{"channel":0}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);console.log(Math.ceil(c.created_at_ms/1000)+20*60+15)})")
  log "6. wait for period 0 to end ($(( PEND - $(date +%s) ))s), then settle via OutLayer"; wait_until "$PEND"
  settle_ready "$C" 0 || { log "E2E FAIL at settle"; exit 1; }
  log "   signal after scoring: $(view get_signal '{"signal_id":0}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);console.log(JSON.stringify({r_bps:x.r_bps,outcome:x.outcome,fill:x.fill_price,exit:x.exit_price,cost_bps:x.cost_bps}))})")"
  log "   channel stats: $(view get_channel '{"channel":0}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).stats)))")"
  CL=$(view claimable "{\"channel\":0,\"account\":\"$M1\"}")
  log "7. $M1 can claim back: $CL"
  if echo "$CL" | grep -qE '^\["[1-9]'; then call "$M1" "$C" claim_refund '{"channel":0}' '0 NEAR'; fi
  log "E2E PASS"
  ;;

settle)
  C=$APP; CH=${CH:-0}
  reveal_all "$C" "$CH"
  settle_ready "$C" "$CH" && log "SETTLE PASS" || log "SETTLE FAIL"
  ;;

status)
  C=$APP
  for a in "$MAIN" "$APP" "$M1" "$M2"; do log "$a: $(bal "$a")"; done
  view get_config '{}'; echo
  view list_channels '{}' | head -c 2000; echo
  ;;
*) echo "unknown action $1"; exit 1;;
esac
