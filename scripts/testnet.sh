#!/usr/bin/env bash
# Testnet operations for the workflow. Usage: scripts/testnet.sh <action>
#   accounts : main account via faucet (+ a faucet funder topping it up) and sub-accounts
#   deploy   : deploy/upgrade the contract at app.<main>
#   e2e      : the full loop on a fresh test club: post a sealed BONK call -> member decrypts ->
#              anyone reveals via drand -> settle via OutLayer -> payout. ~20 minutes.
#   status   : balances and club 0
# Env: MAIN, PUBKEY, SK (private key), SCORER_URL, SCORER_HASH (e2e)
set -uo pipefail
cd "$(dirname "$0")"
APP="app.$MAIN"; CALLER="$MAIN"; M1="m1.$MAIN"; M2="m2.$MAIN"   # calls are posted by the owner account itself
BONK="DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
# near-cli-rs (Nov 2026): the private key is positional; --signer-public-key was removed.
SIGN=(sign-with-plaintext-private-key "$SK" send)
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
exists() { near account view-account-summary "$1" network-config testnet now >/dev/null 2>&1; }
bal() { near account view-account-summary "$1" network-config testnet now 2>&1 | grep -oE "Native account balance[^│]*" | head -1; }
call() { # signer contract method json deposit
  near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas '300.0 Tgas' attached-deposit "$5" sign-as "$1" network-config testnet "${SIGN[@]}" 2>&1 \
    | grep -iE "Transaction ID|EVENT_JSON|error|panicked|return value" | head -12 | sed 's/^/    /'
}
view() { node sc.mjs view "$APP" "$1" "$2"; }
wait_until() { local t=$1; while [ "$(date +%s)" -lt "$t" ]; do sleep 10; done; }

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

case "$1" in
accounts)
  exists "$MAIN" || near account create-account sponsor-by-faucet-service "$MAIN" use-manually-provided-public-key "$PUBKEY" network-config testnet create
  FUND="scfund-${MAIN%%.*}-$(date +%j%H).testnet"   # one funder per hour; the faucet gives ~10 NEAR each
  exists "$FUND" || near account create-account sponsor-by-faucet-service "$FUND" use-manually-provided-public-key "$PUBKEY" network-config testnet create >/dev/null 2>&1 || log "funder faucet unavailable"
  for f in "$FUND"; do
    if exists "$f" && bal "$f" | grep -qE "balance +[1-9][0-9]*(\.[0-9]+)? NEAR"; then
      sleep 3; near tokens "$f" send-near "$MAIN" '9.5 NEAR' network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "Transaction ID|error" | head -3; log "moved 9.5 NEAR from $f"
    fi
  done
  sleep 5
  for spec in "$APP:5" "$M1:0.5" "$M2:0.5"; do
    a="${spec%%:*}"; amt="${spec##*:} NEAR"
    if exists "$a"; then log "$a exists"; continue; fi
    near account create-account fund-myself "$a" "$amt" use-manually-provided-public-key "$PUBKEY" sign-as "$MAIN" network-config testnet "${SIGN[@]}" 2>&1 | grep -iE "Transaction ID|error|created" | head -5
  done
  for a in "$MAIN" "$APP" "$M1" "$M2"; do log "$a: $(bal "$a")"; done
  ;;

deploy)
  WASM=../contract/target/near/sealed_calls.wasm
  (cd ../contract && cargo near build non-reproducible-wasm 2>&1 | tail -2)
  log "wasm sha256 $(sha256sum "$WASM" | cut -d' ' -f1)"
  if node sc.mjs view "$APP" get_club '{"club":0}' >/dev/null 2>&1; then   # code present -> upgrade
    log "upgrading existing contract (state kept)"
    near contract deploy "$APP" use-file "$WASM" without-init-call network-config testnet "${SIGN[@]}" 2>&1 | grep -E "Transaction ID|Error"
  else
    near contract deploy "$APP" use-file "$WASM" with-init-call new json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet "${SIGN[@]}" 2>&1 | grep -E "Transaction ID|Error"
  fi
  sleep 3; log "list_calls on club 0: $(node sc.mjs view "$APP" list_calls '{"club":0}' 2>&1 | head -c 200)"
  ;;

e2e)
  npm install --silent >/dev/null 2>&1
  : "${SCORER_URL:?}" "${SCORER_HASH:?}"
  [ "$(curl -sL "$SCORER_URL" | sha256sum | cut -d' ' -f1)" = "$SCORER_HASH" ] || { log "FAIL scorer URL bytes do not match hash"; exit 1; }
  # 1. A fresh test club. Governor = MAIN here; gate (c) repeats this through a Sputnik DAO.
  CFG=$(cat <<J
{"config":{"name":"E2E $(date -u +%m%d-%H%M)","epoch_minutes":15,"epoch_budget":"1000000000000000000000000","min_record":1,"horizons_min":[10],"grace_min":10,"max_calls_per_day":5,"scorer_wasm_url":"$SCORER_URL","scorer_wasm_hash":"$SCORER_HASH","outlayer":"outlayer.testnet"},"callers":["$CALLER"],"members":["$M1"]}
J
)
  log "1. create_club (escrow 2 NEAR, budget 1 NEAR, epoch 15 min, horizon 10 min)"
  call "$MAIN" "$APP" create_club "$CFG" '2 NEAR'
  CLUB=$(node -e "import('./sc.mjs').then(async m=>{for(let i=0;;i++){const c=await m.view('$APP','get_club',{club:i});if(!c){console.log(i-1);break}}})")
  [[ "$CLUB" =~ ^[0-9]+$ ]] || { log "FAIL create_club did not create a club"; exit 1; }
  log "   club id: $CLUB"; START=$(date +%s)
  # 2. Member registers an X25519 key.
  PUB=$(node sc.mjs member-keygen /tmp/m1.key)
  log "2. $M1 registers key $PUB"
  call "$M1" "$APP" register_key "{\"club\":$CLUB,\"pubkey\":\"$PUB\"}" '0 NEAR'
  # 3. Caller seals and posts a real BONK call.
  MEMBERS=$(node -e "import('./sc.mjs').then(async m=>{const c=await m.view('$APP','get_club',{club:$CLUB});console.log(JSON.stringify(c.members.filter(x=>x.pubkey).map(x=>({member:x.account,pubkey:x.pubkey}))))})")
  log "3. seal + post_call (members: $MEMBERS)"
  node sc.mjs seal "$CLUB" "$CALLER" "$BONK" 10 "$MEMBERS" /tmp/post.json
  call "$CALLER" "$APP" post_call "$(cat /tmp/post.json)" '0.1 NEAR'
  sleep 3
  CALLS=$(view list_calls "{\"club\":$CLUB}"); echo "$CALLS" > /tmp/calls.json
  ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/calls.json'))[0]?.id ?? '')")
  [ -n "$ID" ] || { log "FAIL no call posted"; exit 1; }
  view get_call "{\"call_id\":$ID}" > /tmp/call.json
  log "   call $ID: status $(node -e "console.log(JSON.stringify(require('/tmp/call.json').status))"), opens at $(node -e "const c=require('/tmp/call.json');console.log(new Date(c.posted_at_ms+c.horizon_min*60000).toISOString())")"
  # 4. Member reads it immediately; the public cannot.
  log "4. member decrypts now: $(node sc.mjs member-open /tmp/call.json "$M1" /tmp/m1.key)"
  log "   public tlock-open now (must fail): $(node sc.mjs tlock-open /tmp/call.json 2>&1 | head -c 140)"
  log "   early reveal attempt (must fail):"; call "$M2" "$APP" reveal "{\"call_id\":$ID,\"plaintext\":$(node -e "console.log(JSON.stringify(require('fs').readFileSync('/tmp/post.json.plaintext','utf8')))")}" '0 NEAR'
  # 5. After the horizon, a stranger (m2) opens it from drand and reveals.
  OPEN=$(node -e "const c=require('/tmp/call.json');console.log(Math.ceil((c.posted_at_ms+c.horizon_min*60000)/1000)+75)")
  log "5. waiting for the horizon and drand round (~$(( (OPEN - $(date +%s)) / 60 )) min)"; wait_until "$OPEN"
  OPENED=$(node sc.mjs tlock-open /tmp/call.json); log "   tlock-open: $OPENED"
  PT=$(node -e "console.log(JSON.stringify(JSON.parse(process.argv[1]).plaintext))" "$OPENED")
  call "$M2" "$APP" reveal "{\"call_id\":$ID,\"plaintext\":$PT}" '0 NEAR'
  sleep 3; log "   status after reveal: $(view get_call "{\"call_id\":$ID}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(JSON.parse(s).status)))")"
  # 6. After the epoch ends, anyone settles: contract -> OutLayer scorer -> callback -> payout.
  wait_until $((START + 15*60 + 20))
  log "6. settle epoch 0 via OutLayer (caller balance before: $(bal "$CALLER"))"
  call "$MAIN" "$APP" settle "{\"club\":$CLUB,\"epoch\":0}" '0.5 NEAR'
  for i in $(seq 1 30); do
    E=$(view get_epoch "{\"club\":$CLUB,\"epoch\":0}")
    echo "$E" | grep -q '"Settled"' && break
    [ "$E" = "null" ] && [ "$i" -gt 2 ] && { log "   epoch reset: scoring failed (see settle_failed event above)"; break; }
    sleep 10
  done
  log "   epoch result: $E"
  log "   call after scoring: $(view get_call "{\"call_id\":$ID}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s);console.log(JSON.stringify({score_bps:c.score_bps,note:c.note}))})")"
  log "   caller balance after: $(bal "$CALLER")"
  echo "$E" | grep -q '"Settled"' && log "E2E PASS" || log "E2E FAIL at settle"
  ;;

status)
  for a in "$MAIN" "$APP" "$M1" "$M2"; do log "$a: $(bal "$a")"; done
  view get_club '{"club":0}'
  ;;
*) echo "unknown action $1"; exit 1;;
esac
