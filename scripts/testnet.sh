#!/usr/bin/env bash
# Testnet operations for the workflow (v2: channels, subscriptions, signals). Usage: scripts/testnet.sh <action>
#   accounts : main account via faucet (+ a faucet funder) and member sub-accounts
#   wipe-app : delete app.<main> (its NEAR goes back to <main>) so a fresh contract can be deployed
#   deploy   : create app.<main> if needed and deploy (fresh: init with a daily period) or upgrade
#   e2e      : the full v2 loop on a throwaway contract with a 20-minute period, then deletes it:
#              channel -> subscribe -> sealed BTC signal -> member reads -> drand reveal ->
#              settle via OutLayer -> release or refund claim. ~35 minutes.
#   settle   : reveal sealed signals of channel $CH (default 0) on app.<main> from drand, then settle
#   keep     : hourly keeper: reveal ended signals, mark unopened ones after grace, settle ended periods
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
  echo "{\"config\":{\"owner\":\"$MAIN\",\"period_minutes\":$1,\"grace_min\":1440,\"min_signals\":1,\"max_signals_per_day\":10,\"scorer_wasm_url\":\"$SCORER_URL\",\"scorer_wasm_hash\":\"$SCORER_HASH\",\"outlayer\":\"outlayer.testnet\",\"reference_usd\":500,\"liquidity_floor_usd\":100000}}"
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
      call "$M2" "$C" reveal "{\"signal_id\":$ID,\"plaintext\":$PT}" '0.02 NEAR'
    else
      log "signal $ID cannot be opened yet; trying mark_unrevealed"
      call "$M2" "$C" mark_unrevealed "{\"signal_id\":$ID}" '0.01 NEAR'
    fi
  done
}

# Every signal of channel $2 on $1 (newest first), paged by 100, into file $3.
all_sigs() {
  local C=$1 CH=$2 OUT=$3 N FROM
  N=$(view get_channel "{\"channel\":$CH}" | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).signal_count))")
  echo "[]" > "$OUT"
  for ((FROM=N; FROM>0; FROM-=100)); do
    view list_signals "{\"channel\":$CH,\"from_index\":$FROM,\"limit\":100}" > /tmp/page.json
    js "const fs=require('fs');fs.writeFileSync('$OUT',JSON.stringify(JSON.parse(fs.readFileSync('$OUT','utf8')).concat(JSON.parse(fs.readFileSync('/tmp/page.json','utf8')))))"
  done
}

# Official scores as soon as signals end (no waiting for the period): score_signals on OutLayer.
score_ended() {
  local C=$1 CH=$2 IDS LEFT
  all_sigs "$C" "$CH" /tmp/sigs.json
  # A random batch each run (so one signal that keeps failing can't block the others), with at most
  # 3 DEX signals (GeckoTerminal is rate-limited and paced inside the job).
  IDS=$(js "const now=Date.now();const c=require('/tmp/sigs.json').filter(s=>s.body&&s.r_bps==null&&typeof s.status==='object'&&s.status.Revealed&&now>=s.posted_at_ms+s.valid_min*60000).sort(()=>Math.random()-0.5);const dex=c.filter(s=>s.body.market.venue!=='hyperliquid').slice(0,3);const ids=c.filter(s=>s.body.market.venue==='hyperliquid').slice(0,10-dex.length).concat(dex).map(s=>s.id);console.log(ids.join(','))")
  if [ -n "$IDS" ]; then
    log "channel $CH: scoring signals [$IDS] on OutLayer"
    call "$MAIN" "$C" score_signals "{\"ids\":[$IDS]}" '0.3 NEAR' 300 | grep -E "EVENT_JSON|rror" | sed -E 's/"code_source":\{[^}]*\}\}?,?//' | cut -c1-1500
    for i in $(seq 1 12); do
      sleep 10
      LEFT=$(view list_signals "{\"channel\":$CH,\"limit\":100}" | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const want=[$IDS];console.log(JSON.parse(s).filter(x=>want.includes(x.id)&&x.r_bps==null).length)})")
      [ "$LEFT" = 0 ] && break
    done
    view list_signals "{\"channel\":$CH,\"limit\":100}" | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const want=[$IDS];for(const x of JSON.parse(s).filter(x=>want.includes(x.id)))console.log('    signal',x.id,x.body.market.symbol,x.r_bps==null?'not scored yet':(x.r_bps/100)+'% '+x.outcome)})"
  fi
}

# Keeper pass for channel $2 on $1: reveal every ended signal drand can open (no waiting), mark
# signals still unopened after the grace period, then settle every ended period.
keep_channel() {
  local C=$1 CH=$2 NOW GRACE
  NOW=$(date +%s); GRACE=$(view get_config '{}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).grace_min*60))")
  all_sigs "$C" "$CH" /tmp/sigs.json
  for ID in $(js "const now=$NOW*1000;for (const s of require('/tmp/sigs.json')) if (s.status==='Sealed' && now>=s.posted_at_ms+s.valid_min*60000 && now>=(1692803367+(s.reveal_round-1)*3+5)*1000) console.log(s.id)"); do
    js "require('fs').writeFileSync('/tmp/s.json',JSON.stringify(require('/tmp/sigs.json').find(s=>s.id==$ID)))"
    if OPENED=$(node sc.mjs tlock-open /tmp/s.json 2>/dev/null) && echo "$OPENED" | grep -q '"matches":true'; then
      log "channel $CH signal $ID: revealing from drand"
      PT=$(js "console.log(JSON.stringify(JSON.parse(process.argv[1]).plaintext))" "$OPENED")
      call "$MAIN" "$C" reveal "{\"signal_id\":$ID,\"plaintext\":$PT}" '0.02 NEAR' | grep -E "EVENT_JSON|rror" | cut -c1-240
    elif [ "$NOW" -ge "$(js "const s=require('/tmp/s.json');console.log(Math.ceil((s.posted_at_ms+s.valid_min*60000)/1000)+$GRACE)")" ]; then
      log "channel $CH signal $ID: drand copy doesn't open and grace is over -> mark_unrevealed"
      call "$MAIN" "$C" mark_unrevealed "{\"signal_id\":$ID}" '0.01 NEAR' | grep -E "EVENT_JSON|rror" | cut -c1-240
    else
      log "channel $CH signal $ID: ended but its drand copy doesn't open; waiting for the grace period"
    fi
  done
  score_ended "$C" "$CH"
  settle_ready "$C" "$CH" || log "channel $CH: settlement not finished this round"
}

# Settle periods of channel $2 on $1 until none is ready; prints results.
settle_ready() {
  local C=$1 CH=$2
  for k in 1 2 3 4 5 6; do
    local NP; NP=$(view get_channel "{\"channel\":$CH}" | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).next_period))")
    local CUR; CUR=$(view current_period "{\"channel\":$CH}")
    [ "$NP" -lt "$CUR" ] || { log "period $NP has not ended yet (current $CUR)"; break; }
    # A period settles only when every signal posted in it has ended and been revealed.
    all_sigs "$C" "$CH" /tmp/allsigs.json
    local WAIT; WAIT=$(cat /tmp/allsigs.json | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const w=JSON.parse(s).filter(x=>x.period==$NP&&x.status==='Sealed');console.log(w.map(x=>x.id+' (opens '+new Date(x.posted_at_ms+x.valid_min*60000).toISOString().slice(0,16)+'Z)').join(', '))})")
    [ -z "$WAIT" ] || { log "period $NP waits for sealed signal(s): $WAIT"; return 0; }
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

floor)  # floor=<usd>: set the DEX liquidity floor in the contract config (no upgrade)
  C=$APP
  CFG=$(view get_config '{}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);c.liquidity_floor_usd=Number(process.argv[1]);console.log(JSON.stringify({config:c}))})" "$ARG")
  call "$MAIN" "$APP" set_config "$CFG" '0 NEAR'
  sleep 2; log "liquidity floor now: $(view get_config '{}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).liquidity_floor_usd))")"
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
    log "upgrading existing v2 contract (state kept); pointing it at the current scorer (TOPUP=<n> also sends n NEAR for storage)"
    # Larger code is staked from the contract's balance, which holds subscribers' escrow: top it up
    # by the growth (default 0.3 NEAR) so the upgrade never eats escrow.
    near tokens "$MAIN" send-near "$APP" "${TOPUP:-0.3} NEAR" network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "error" | head -2
    log "free balance before: $(view free_balance '{}' 2>/dev/null)"
    # New code + its config in one transaction (migrate keeps all state). Config changes after this
    # go through set_config, which waits a day once channels exist.
    CFG=$(view get_config '{}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);c.scorer_wasm_url=process.argv[1];c.scorer_wasm_hash=process.argv[2];c.grace_min=Math.max(c.grace_min,1440);console.log(JSON.stringify({config:c}))})" "$SCORER_URL" "$SCORER_HASH")
    near contract deploy "$APP" use-file "$WASM" with-init-call migrate json-args "$CFG" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet "${SIGN[@]}" 2>&1 | grep -E "Transaction ID|Error|rror"
  else
    near contract deploy "$APP" use-file "$WASM" with-init-call new json-args "$(config_json 1440)" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet "${SIGN[@]}" 2>&1 | grep -E "Transaction ID|Error"
  fi
  sleep 3; log "config: $(view get_config '{}' 2>&1 | head -c 600)"
  log "free balance after: $(view free_balance '{}' 2>&1 | head -c 100)"
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

  for a in "$M1" "$M2"; do   # members need ~0.6 NEAR for a 0.25 NEAR subscription plus gas reserve
    if ! bal "$a" | grep -qE "balance +([1-9]|0\.[6-9])"; then near tokens "$MAIN" send-near "$a" '0.5 NEAR' network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "error" | head -2; fi
  done
  log "1. $MAIN creates a channel: 1 day for 0.2 NEAR, 7 days for 1 NEAR"
  call "$MAIN" "$C" create_channel '{"name":"E2E desk","about":"test","plans":[{"days":1,"price":"200000000000000000000000"},{"days":7,"price":"1000000000000000000000000"}],"max_members":25}' '0.05 NEAR'
  log "2. $M1 subscribes (1 day) and registers a key; $M2 subscribes without a key"
  call "$M1" "$C" subscribe '{"channel":0,"plan":0}' '0.25 NEAR'
  PUB=$(node sc.mjs member-keygen /tmp/m1.key)
  call "$M1" "$C" register_key "{\"channel\":0,\"pubkey\":\"$PUB\"}" '0.01 NEAR'
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
  log "4b. late access: $M2 sets up a key only now; the creator shares the live signal with them"
  PUB2=$(node sc.mjs member-keygen /tmp/m2.key)
  call "$M2" "$C" register_key "{\"channel\":0,\"pubkey\":\"$PUB2\"}" '0.01 NEAR'
  W2=$(node sc.mjs wrap /tmp/post.json.key "$PUB2")
  call "$MAIN" "$C" deposit_storage '{}' '0.05 NEAR' | grep -E "rror" | cut -c1-200   # late access pays storage from the creator's credit
  call "$MAIN" "$C" share_signals "{\"items\":[[0,[{\"member\":\"$M2\",\"key\":\"$W2\"}]]]}" '0 NEAR' | grep -E "EVENT_JSON|rror" | cut -c1-200
  sleep 3; view get_signal '{"signal_id":0}' > /tmp/s0.json
  LATE=$(node sc.mjs member-open /tmp/s0.json "$M2" /tmp/m2.key)
  log "   late subscriber reads it: $LATE"
  echo "$LATE" | grep -q '"matches":true' || { log "E2E FAIL late access"; exit 1; }
  log "   early reveal (must fail):"; call "$M2" "$C" reveal "{\"signal_id\":0,\"plaintext\":$(js "console.log(JSON.stringify(require('fs').readFileSync('/tmp/post.json.plaintext','utf8')))")}" '0 NEAR'

  log "5. after validity, anyone reveals from drand"
  reveal_all "$C" 0
  log "   revealed: $(view get_signal '{"signal_id":0}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);console.log(JSON.stringify({status:x.status,body:x.body}))})")"

  log "5b. official score right after the end (score_signals on OutLayer)"
  score_ended "$C" 0
  view get_signal '{"signal_id":0}' | grep -q '"r_bps":null' && { log "E2E FAIL: not scored after the end"; exit 1; }

  PEND=$(view get_channel '{"channel":0}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);console.log(Math.ceil(c.created_at_ms/1000)+20*60+15)})")
  log "6. wait for period 0 to end ($(( PEND - $(date +%s) ))s), then settle (scores already on-chain: no OutLayer call)"; wait_until "$PEND"
  settle_ready "$C" 0 || { log "E2E FAIL at settle"; exit 1; }
  log "   signal after scoring: $(view get_signal '{"signal_id":0}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const x=JSON.parse(s);console.log(JSON.stringify({r_bps:x.r_bps,outcome:x.outcome,fill:x.fill_price,exit:x.exit_price,cost_bps:x.cost_bps}))})")"
  log "   channel stats: $(view get_channel '{"channel":0}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).stats)))")"
  CL=$(view claimable "{\"channel\":0,\"account\":\"$M1\"}")
  log "7. $M1 can claim back: $CL"
  if echo "$CL" | grep -qE '^\["[1-9]'; then call "$M1" "$C" claim_refund '{"channel":0}' '0 NEAR'; fi
  log "E2E PASS"
  ;;

keep)  # hourly keeper (scheduled workflow): every channel on app.<main>
  C=$APP
  N=$(view list_channels '{"limit":100}' | js "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))")
  log "keeper: $N channel(s) on $C; $MAIN: $(bal "$MAIN")"
  for CH in $(seq 0 $((N - 1))); do keep_channel "$C" "$CH"; done
  log "keeper done"
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
