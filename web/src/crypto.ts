// Client-side sealing, identical to scripts/sc.mjs (tested end to end there).
import { timelockEncrypt, timelockDecrypt, mainnetClient, Buffer } from "tlock-js";
import sodium from "libsodium-wrappers";
import { CONTRACT } from "./config";
import type { Call } from "./types";

const QUICKNET_GENESIS_S = 1692803367;
const PERIOD_S = 3;
const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** First drand round whose time is >= t_s (matches the contract's check_round). */
export const roundFor = (t_s: number) => Math.ceil((t_s - QUICKNET_GENESIS_S) / PERIOD_S) + 1;
export const roundTimeMs = (round: number) => (QUICKNET_GENESIS_S + (round - 1) * PERIOD_S) * 1000;

export type MemberPub = { member: string; pubkey: string };

export async function seal(p: { club: number; caller: string; mint: string; horizonMin: number; members: MemberPub[]; latencyS?: number }) {
  await sodium.ready;
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  // Key order is fixed: the commitment covers these exact bytes.
  const plaintext = JSON.stringify({ v: 1, club: p.club, caller: p.caller, mint: p.mint, horizon_min: p.horizonMin, salt });
  const commit = await sha256hex(plaintext);
  const endS = Math.floor(Date.now() / 1000) + p.horizonMin * 60 + (p.latencyS ?? 60);
  const reveal_round = roundFor(endS);
  const tlock_ct = await timelockEncrypt(reveal_round, Buffer.from(plaintext), mainnetClient());
  const callKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, callKey);
  const member_ct = b64(new Uint8Array([...nonce, ...box]));
  const wrapped_keys = p.members.map((m) => ({ member: m.member, key: b64(sodium.crypto_box_seal(callKey, unb64(m.pubkey))) }));
  return { args: { club: p.club, horizon_min: p.horizonMin, commit, reveal_round, tlock_ct, member_ct, wrapped_keys }, plaintext };
}

export type Opened = { plaintext: string; mint: string; matches: boolean };

async function opened(plaintext: string, commit: string): Promise<Opened> {
  const mint = (JSON.parse(plaintext) as { mint: string }).mint;
  return { plaintext, mint, matches: (await sha256hex(plaintext)) === commit };
}

export async function memberOpen(call: Call, member: string, key: MemberKey): Promise<Opened> {
  await sodium.ready;
  const w = call.wrapped_keys.find((k) => k.member === member);
  if (!w) throw new Error("This call was posted before your key was registered.");
  const callKey = sodium.crypto_box_seal_open(unb64(w.key), unb64(key.publicKey), unb64(key.privateKey));
  const raw = unb64(call.member_ct);
  const nb = sodium.crypto_secretbox_NONCEBYTES;
  const plaintext = sodium.to_string(sodium.crypto_secretbox_open_easy(raw.slice(nb), raw.slice(0, nb), callKey));
  return opened(plaintext, call.commit);
}

export async function tlockOpen(call: Call): Promise<Opened> {
  const plaintext = (await timelockDecrypt(call.tlock_ct, mainnetClient())).toString();
  return opened(plaintext, call.commit);
}

// ------------------------------------------------------------- member keys (kept in this browser)
export type MemberKey = { publicKey: string; privateKey: string };
const slot = (club: number, account: string) => `sc:member-key:${CONTRACT}:${club}:${account}`;

export function loadMemberKey(club: number, account: string): MemberKey | null {
  try {
    const raw = localStorage.getItem(slot(club, account));
    return raw ? (JSON.parse(raw) as MemberKey) : null;
  } catch {
    return null;
  }
}

export async function newMemberKey(club: number, account: string): Promise<MemberKey> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  const key = { publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) };
  try {
    localStorage.setItem(slot(club, account), JSON.stringify(key));
  } catch {
    /* private window: the key lives only for this session */
  }
  return key;
}
