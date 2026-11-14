#!/usr/bin/env bash
# Records demo footage of a real subscriber (m1.$MAIN) opening a live sealed call on the live site.
#   1. m1 subscribes to the creator's channel (cheapest plan) and registers a fresh reading key
#   2. waits until the creator's desk shares the live call with m1 (late access, up to 45 min)
#   3. records the live site as m1 in a real browser (Xvfb + ffmpeg)
#   4. encrypts the recording to .github/demo.pub.pem (the live call must not go public)
# Usage: CHNAME="No calls" bash demo.sh     (env: SK, PUBKEY, MAIN)
set -u
cd "$(dirname "$0")"
C="app.$MAIN"; M1="m1.$MAIN"
SIGN=(sign-with-plaintext-private-key "$SK" send)
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
call() { near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas "100.0 Tgas" attached-deposit "$5" sign-as "$1" network-config testnet "${SIGN[@]}" 2>&1 \
    | grep -iE "Transaction ID|error|panicked" | head -6 | sed 's/^/    /'; }
view() { node sc.mjs view "$C" "$1" "$2"; }
js() { node -e "$1" "${@:2}"; }

view list_channels '{"limit":200}' > /tmp/chs.json
CH=$(js "const c=require('/tmp/chs.json').filter(c=>c.creator===process.argv[1]&&c.name===process.argv[2]);console.log(c.length?c[c.length-1].id:'')" "$MAIN" "${CHNAME:-No calls}")
[ -n "$CH" ] || { log "no channel named '${CHNAME:-No calls}' by $MAIN"; exit 1; }
view list_signals "{\"channel\":$CH,\"limit\":100}" > /tmp/sigs.json
SIG=$(js "const s=require('/tmp/sigs.json').filter(s=>s.status==='Sealed');console.log(s.length?s[s.length-1].id:'')")
[ -n "$SIG" ] || { log "channel $CH has no sealed call"; exit 1; }
log "channel $CH, live sealed call $SIG"

MEM=$(view get_member "{\"channel\":$CH,\"account\":\"$M1\"}")
NOW=$(date +%s%3N)
ACTIVE=$(js "const m=JSON.parse(process.argv[1]);console.log(m&&Number(m.until_ms)>Number(process.argv[2])?1:0)" "$MEM" "$NOW")
if [ "$ACTIVE" != 1 ]; then
  read -r PLAN DAYS PRICE < <(js "const c=require('/tmp/chs.json').find(c=>c.id==$CH);let b=0;c.plans.forEach((p,i)=>{if(BigInt(p.price)<BigInt(c.plans[b].price))b=i});const p=c.plans[b];console.log(b,p.days,p.price)")
  DEP=$(js "console.log((Number(BigInt(process.argv[1])+30000000000000000000000n)/1e24).toFixed(4))" "$PRICE")
  log "$M1 subscribes: plan $PLAN ($DAYS days, $PRICE yocto), attaching $DEP NEAR"
  call "$M1" "$C" subscribe "{\"channel\":$CH,\"plan\":$PLAN,\"expect_days\":$DAYS,\"max_price\":\"$PRICE\"}" "$DEP NEAR"
fi
PUB=$(node sc.mjs member-keygen /tmp/m1.key)
log "$M1 registers a fresh reading key"
call "$M1" "$C" register_key "{\"channel\":$CH,\"pubkey\":\"$PUB\"}" '0.01 NEAR'

log "waiting for the creator's desk to share call $SIG with $M1 (open the desk, storage credit > 0)"
for i in $(seq 1 90); do
  view get_signal "{\"signal_id\":$SIG}" > /tmp/sig.json
  if js "process.exit(require('/tmp/sig.json').wrapped_keys.some(w=>w.member===process.argv[1])?0:1)" "$M1"; then log "shared"; break; fi
  [ "$i" = 90 ] && { log "not shared after 45 min; stopping"; exit 1; }
  sleep 30
done
node sc.mjs member-open /tmp/sig.json "$M1" /tmp/m1.key >/dev/null && log "member key opens it (hash checked)" || log "WARNING: member key could not open it"

log "recording"
Xvfb :99 -screen 0 1920x1080x24 >/dev/null 2>&1 & XV=$!
sleep 2; export DISPLAY=:99
ffmpeg -loglevel error -y -f x11grab -draw_mouse 0 -framerate 30 -video_size 1920x1080 -i :99 -c:v libx264 -preset ultrafast -crf 8 -pix_fmt yuv444p /tmp/sub.mkv & FF=$!
echo "ffmpeg_start $(date +%s%3N)" > /tmp/marks.txt
node rec.cjs /tmp/m1.key "$CH" >> /tmp/marks.txt 2>&1
kill -INT $FF; wait $FF; kill $XV
cat /tmp/marks.txt
ls -la /tmp/sub.mkv

mkdir -p ../out/demo
head -c 32 /dev/urandom | base64 > /tmp/k
openssl enc -aes-256-cbc -pbkdf2 -salt -in /tmp/sub.mkv -out ../out/demo/sub.mkv.enc -pass file:/tmp/k
openssl pkeyutl -encrypt -pubin -inkey ../.github/demo.pub.pem -pkeyopt rsa_padding_mode:oaep -in /tmp/k -out ../out/demo/k.enc
cp /tmp/marks.txt ../out/demo/marks.txt
rm -f /tmp/k /tmp/m1.key
log "encrypted recording ready"
