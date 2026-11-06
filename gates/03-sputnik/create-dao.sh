#!/usr/bin/env bash
# Gate (c): create a Sputnik DAO on testnet through the factory, then prove it can make a
# FunctionCall proposal to another contract (the exact thing that will fund a club on Nov 12).
# Usage: ME=yourname.testnet ./create-dao.sh
# PASS = get_policy prints your account in the council, and get_proposal 0 shows a FunctionCall kind.
set -euo pipefail
: "${ME:?set ME=yourname.testnet}"
FACTORY="sputnik-v2.testnet"
NAME="${DAO_NAME:-sealedcalls-gate}"
DAO="${NAME}.${FACTORY}"

ARGS=$(printf '{"config":{"name":"%s","purpose":"Sealed Calls gate test","metadata":""},"policy":["%s"]}' "$NAME" "$ME" | base64 | tr -d '\n')

# The factory README shows 5–10 NEAR attached; 6 covers storage for the DAO code today.
# If it fails with an insufficient-deposit error, rerun with DEPOSIT='10 NEAR'.
near contract call-function as-transaction "$FACTORY" create \
  json-args "{\"name\":\"$NAME\",\"args\":\"$ARGS\"}" \
  prepaid-gas '150.0 Tgas' attached-deposit "${DEPOSIT:-6 NEAR}" sign-as "$ME" network-config testnet sign-with-keychain send

echo "--- policy"
near contract call-function as-read-only "$DAO" get_policy empty-args network-config testnet now

# A FunctionCall proposal that calls the probe contract's read method (harmless).
# Proposal bond: read it from the policy above ("proposal_bond"); 0.1 NEAR is the usual default.
PROBE="probe.${ME}"
CALLARGS=$(printf '{}' | base64 | tr -d '\n')
near contract call-function as-transaction "$DAO" add_proposal \
  json-args "{\"proposal\":{\"description\":\"gate: FunctionCall proposal\",\"kind\":{\"FunctionCall\":{\"receiver_id\":\"$PROBE\",\"actions\":[{\"method_name\":\"config\",\"args\":\"$CALLARGS\",\"deposit\":\"0\",\"gas\":\"10000000000000\"}]}}}}" \
  prepaid-gas '100.0 Tgas' attached-deposit "${BOND:-0.1 NEAR}" sign-as "$ME" network-config testnet sign-with-keychain send

echo "--- proposal 0"
near contract call-function as-read-only "$DAO" get_proposal json-args '{"id":0}' network-config testnet now
echo "Optional: approve it with"
echo "  near contract call-function as-transaction $DAO act_proposal json-args '{\"id\":0,\"action\":\"VoteApprove\",\"proposal\":<kind from get_proposal>}' prepaid-gas '150 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send"
