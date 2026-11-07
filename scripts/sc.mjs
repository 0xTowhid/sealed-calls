// Sealed Calls client helpers: the same crypto the web app will use.
//   node sc.mjs view <contract> <method> '<json args>'
//   node sc.mjs member-keygen <outfile>                       -> prints base64 X25519 public key
//   node sc.mjs seal <club> <caller> <mint> <horizon_min> <memberPubsJson> <outfile>
//        memberPubsJson: [{"member":"m1.x.testnet","pubkey":"<b64>"}]  -> writes post_call args (minus club) + secrets
//   node sc.mjs member-open <callJson> <member> <memberKeyFile>  -> prints plaintext, checks commitment
//   node sc.mjs tlock-open <callJson>                          -> prints plaintext once the drand round has passed
import { timelockEncrypt, timelockDecrypt, roundAt, mainnetClient, Buffer } from "tlock-js";
import sodium from "libsodium-wrappers";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const QUICKNET_GENESIS_S = 1692803367, PERIOD_S = 3;
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const b64 = (u8) => Buffer.from(u8).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

export async function view(contract, method, args = {}) {
  const body = { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } };
  let last;
  for (const url of RPCS) {
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      if (j.error || j.result?.error) { last = JSON.stringify(j.error ?? j.result.error).slice(0, 300); continue; }
      return JSON.parse(Buffer.from(j.result.result).toString());
    } catch (e) { last = e.message; }
  }
  throw new Error(`view ${method} failed: ${last}`);
}

/** First drand round whose time is >= t_s (matches the contract's check_round). */
export const roundFor = (t_s) => Math.ceil((t_s - QUICKNET_GENESIS_S) / PERIOD_S) + 1;

export async function seal({ club, caller, mint, horizonMin, members, latencyS = 60 }) {
  await sodium.ready;
  const salt = randomBytes(16).toString("hex");
  // Key order is fixed: the commitment covers these exact bytes.
  const plaintext = JSON.stringify({ v: 1, club, caller, mint, horizon_min: horizonMin, salt });
  const commit = sha256hex(plaintext);
  const endS = Math.floor(Date.now() / 1000) + horizonMin * 60 + latencyS;
  const round = roundFor(endS);
  const tlock_ct = await timelockEncrypt(round, Buffer.from(plaintext), mainnetClient());
  const callKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, callKey);
  const member_ct = b64(new Uint8Array([...nonce, ...box]));
  const wrapped_keys = members.map((m) => ({ member: m.member, key: b64(sodium.crypto_box_seal(callKey, unb64(m.pubkey))) }));
  return { args: { club, horizon_min: horizonMin, commit, reveal_round: round, tlock_ct, member_ct, wrapped_keys }, plaintext };
}

export async function memberOpen(call, member, keypair) {
  await sodium.ready;
  const w = call.wrapped_keys.find((k) => k.member === member);
  if (!w) throw new Error(`call ${call.id} was not wrapped to ${member}`);
  const callKey = sodium.crypto_box_seal_open(unb64(w.key), unb64(keypair.publicKey), unb64(keypair.privateKey));
  const raw = unb64(call.member_ct);
  const nb = sodium.crypto_secretbox_NONCEBYTES;
  const plaintext = sodium.to_string(sodium.crypto_secretbox_open_easy(raw.slice(nb), raw.slice(0, nb), callKey));
  return { plaintext, matches: sha256hex(plaintext) === call.commit };
}

export async function tlockOpen(call) {
  const plaintext = (await timelockDecrypt(call.tlock_ct, mainnetClient())).toString();
  return { plaintext, matches: sha256hex(plaintext) === call.commit };
}

// ------------------------------------------------------------------ CLI
const [cmd, ...a] = process.argv.slice(2);
// Libraries (tlock-js) log to stdout; keep stdout for our JSON only.
const realLog = console.log;
console.log = (...x) => console.error(...x);
const out = (x) => realLog(typeof x === "string" ? x : JSON.stringify(x));
try {
  if (cmd === "view") out(await view(a[0], a[1], JSON.parse(a[2] ?? "{}")));
  else if (cmd === "member-keygen") {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    writeFileSync(a[0], JSON.stringify({ publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) }));
    out(b64(kp.publicKey));
  } else if (cmd === "seal") {
    const r = await seal({ club: Number(a[0]), caller: a[1], mint: a[2], horizonMin: Number(a[3]), members: JSON.parse(a[4]) });
    writeFileSync(a[5], JSON.stringify(r.args));
    writeFileSync(a[5] + ".plaintext", r.plaintext);
    out({ commit: r.args.commit, reveal_round: r.args.reveal_round, tlock_bytes: r.args.tlock_ct.length, wrapped: r.args.wrapped_keys.length });
  } else if (cmd === "member-open") {
    out(await memberOpen(JSON.parse(readFileSync(a[0], "utf8")), a[1], JSON.parse(readFileSync(a[2], "utf8"))));
  } else if (cmd === "tlock-open") {
    out(await tlockOpen(JSON.parse(readFileSync(a[0], "utf8"))));
  } else if (cmd) {
    throw new Error(`unknown command ${cmd}`);
  }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
}
