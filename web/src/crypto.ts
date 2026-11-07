// Client-side sealing, identical to scripts/sc.mjs (tested end to end there).
import { timelockEncrypt, timelockDecrypt, mainnetClient, Buffer } from "tlock-js";
import sodium from "libsodium-wrappers";
import { CONTRACT } from "./config";
import type { Signal, SignalBody } from "./types";

const QUICKNET_GENESIS_S = 1692803367;
const PERIOD_S = 3;
const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hexOf = (u8: Uint8Array) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256hex(s: string) {
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

/** First drand round whose time is >= t_s (matches the contract's check_round). */
export const roundFor = (t_s: number) => Math.ceil((t_s - QUICKNET_GENESIS_S) / PERIOD_S) + 1;
export const roundTimeMs = (round: number) => (QUICKNET_GENESIS_S + (round - 1) * PERIOD_S) * 1000;

export type Reader = { member: string; pubkey: string };

export async function seal(p: { channel: number; creator: string; validMin: number; signal: SignalBody; readers: Reader[]; secret: Uint8Array; latencyS?: number }) {
  await sodium.ready;
  const salt = hexOf(crypto.getRandomValues(new Uint8Array(16)));
  const s = p.signal;
  const m = s.market;
  // Key order is fixed: the commitment covers these exact bytes.
  const plaintext = JSON.stringify({
    v: 2, channel: p.channel, creator: p.creator, valid_min: p.validMin,
    market: { venue: m.venue, network: m.network ?? null, address: m.address, symbol: m.symbol },
    side: s.side, leverage: s.leverage, entry_low: s.entry_low, entry_high: s.entry_high, tps: s.tps, sl: s.sl, msg: s.msg, salt,
  });
  const commit = await sha256hex(plaintext);
  const endS = Math.floor(Date.now() / 1000) + p.validMin * 60 + (p.latencyS ?? 60);
  const reveal_round = roundFor(endS);
  const tlock_ct = await timelockEncrypt(reveal_round, Buffer.from(plaintext), mainnetClient());
  // The per-signal key is derived from the creator's secret, so the creator can re-share a live
  // signal with subscribers who join later (late access) from any browser holding that secret.
  const key = await signalKey(p.secret, commit);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, key);
  const member_ct = b64(new Uint8Array([...nonce, ...box]));
  const wrapped_keys = p.readers.map((r) => ({ member: r.member, key: b64(sodium.crypto_box_seal(key, unb64(r.pubkey))) }));
  return { args: { channel: p.channel, valid_min: p.validMin, commit, reveal_round, tlock_ct, member_ct, wrapped_keys }, plaintext };
}

export type Opened = { plaintext: string; body: SignalBody | null; matches: boolean };

async function opened(plaintext: string, commit: string): Promise<Opened> {
  let body: SignalBody | null = null;
  try {
    const p = JSON.parse(plaintext);
    body = { market: p.market, side: p.side, leverage: p.leverage, entry_low: p.entry_low, entry_high: p.entry_high, tps: p.tps, sl: p.sl, msg: p.msg ?? "" };
  } catch { /* not a signal; the contract will score it −100% */ }
  return { plaintext, body, matches: (await sha256hex(plaintext)) === commit };
}

export async function memberOpen(s: Signal, member: string, key: MemberKey): Promise<Opened> {
  await sodium.ready;
  const w = s.wrapped_keys.find((k) => k.member === member);
  if (!w) throw new Error("This signal was posted before you subscribed or set up this browser.");
  const k = sodium.crypto_box_seal_open(unb64(w.key), unb64(key.publicKey), unb64(key.privateKey));
  const raw = unb64(s.member_ct);
  const nb = sodium.crypto_secretbox_NONCEBYTES;
  const plaintext = sodium.to_string(sodium.crypto_secretbox_open_easy(raw.slice(nb), raw.slice(0, nb), k));
  return opened(plaintext, s.commit);
}

export async function tlockOpen(s: Signal): Promise<Opened> {
  const plaintext = (await timelockDecrypt(s.tlock_ct, mainnetClient())).toString();
  return opened(plaintext, s.commit);
}

// ------------------------------------------------------------- reader keys (kept in this browser)
export type MemberKey = { publicKey: string; privateKey: string };
const slot = (channel: number, account: string) => `sc2:key:${CONTRACT}:${channel}:${account}`;

export function loadMemberKey(channel: number, account: string): MemberKey | null {
  try {
    const raw = localStorage.getItem(slot(channel, account));
    return raw ? (JSON.parse(raw) as MemberKey) : null;
  } catch {
    return null;
  }
}

export async function newMemberKey(channel: number, account: string): Promise<MemberKey> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const key = { publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) };
  try {
    localStorage.setItem(slot(channel, account), JSON.stringify(key));
  } catch {
    /* private window: the key lives only for this session */
  }
  return key;
}

// ------------------------------------------------------------- creator secret (late access)
const cslot = (account: string) => `sc2:creator-secret:${CONTRACT}:${account}`;

/** The creator's 32-byte secret in this browser; created on first use when `create` is set. */
export function creatorSecret(account: string, create = false): Uint8Array | null {
  try {
    const raw = localStorage.getItem(cslot(account));
    if (raw) return unb64(raw);
    if (!create) return null;
    const s = crypto.getRandomValues(new Uint8Array(32));
    localStorage.setItem(cslot(account), b64(s));
    return s;
  } catch {
    return null;
  }
}
export const exportSecret = (account: string) => { const s = creatorSecret(account); return s ? b64(s) : null; };
export function importSecret(account: string, code: string) {
  const s = unb64(code.trim());
  if (s.length !== 32) throw new Error("That isn't a creator key backup code.");
  localStorage.setItem(cslot(account), b64(s));
}

/** HMAC-SHA256(secret, "sealed-calls v2 signal|" + commit): the signal's 32-byte key. */
export async function signalKey(secret: Uint8Array, commit: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", new Uint8Array(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`sealed-calls v2 signal|${commit}`)));
}

/** Opens a signal with its own key (the creator's view); null if the key doesn't fit. */
export async function openWithKey(s: Signal, key: Uint8Array): Promise<Opened | null> {
  await sodium.ready;
  try {
    const raw = unb64(s.member_ct);
    const nb = sodium.crypto_secretbox_NONCEBYTES;
    const plaintext = sodium.to_string(sodium.crypto_secretbox_open_easy(raw.slice(nb), raw.slice(0, nb), key));
    return opened(plaintext, s.commit);
  } catch {
    return null;
  }
}

export async function wrapFor(key: Uint8Array, pubkey: string) {
  await sodium.ready;
  return b64(sodium.crypto_box_seal(key, unb64(pubkey)));
}
