import { setupWalletSelector, actionCreators, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import { CONTRACT, NETWORK, RPCS, GAS_50 } from "./config";
import type { Channel, Config, Member, PeriodResult, Signal } from "./types";

const enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export async function view<T>(method: string, args: object = {}): Promise<T> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: { request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: method, args_base64: enc(JSON.stringify(args)) },
  };
  let last = "";
  for (let round = 0; round < 2; round++) for (const url of RPCS) {
    if (round) await new Promise((r) => setTimeout(r, 700));
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      const err = j.error ?? j.result?.error;
      if (err) { last = typeof err === "string" ? err : JSON.stringify(err); continue; }
      return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
    } catch (e) { last = String(e); }
  }
  throw new Error(`Couldn't read ${method} from ${CONTRACT}: ${last.slice(0, 200)}`);
}

/** Spendable NEAR of an account (yocto string), or null. */
export async function balanceOf(account: string): Promise<string | null> {
  for (const url of RPCS) {
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: account } }) })).json();
      if (j.result?.amount) return j.result.amount as string;
    } catch { /* next */ }
  }
  return null;
}
export const getConfig = () => view<Config>("get_config");
export const listChannels = () => view<Channel[]>("list_channels", { limit: 100 });
/** Declared kinds per channel ("perps" | "dex" | "micro"); empty = all kinds. Older contract → all empty. */
export const channelTags = (channels: number[]) =>
  channels.length ? view<string[][]>("channel_tags", { channels }).catch(() => channels.map(() => [] as string[])) : Promise.resolve([] as string[][]);
export const getChannel = (channel: number) => view<Channel | null>("get_channel", { channel });
export const getMember = (channel: number, account: string) => view<Member | null>("get_member", { channel, account });
export const subscribers = (channel: number) => view<[string, number, boolean][]>("subscribers", { channel });
export const readersNow = (channel: number) => view<[string, string][]>("readers_now", { channel });
export const currentPeriod = (channel: number) => view<number>("current_period", { channel });
export const getPeriod = (channel: number, period: number) => view<PeriodResult | null>("get_period", { channel, period });
export const periodHeld = (channel: number, period: number) => view<string>("period_held", { channel, period });
export const claimable = (channel: number, account: string) => view<[string, number[]]>("claimable", { channel, account });
export const storageCredit = (account: string) => view<string>("storage_credit", { account }).catch(() => "0");
export const owedTo = (account: string) => view<string>("owed", { account }).catch(() => "0");
export const pendingConfig = () => view<{ config: Config; eta_ms: number } | null>("pending_config").catch(() => null);

/** Every signal in a channel, newest first (the contract pages by 100). */
export async function allSignals(channel: number, total: number): Promise<Signal[]> {
  const out: Signal[] = [];
  for (let from = total; from > 0; from -= 100) out.push(...(await view<Signal[]>("list_signals", { channel, from_index: from, limit: 100 })));
  return out;
}

// ------------------------------------------------------------- wallet
let selector: Promise<WalletSelector> | null = null;
let modal: WalletSelectorModal | null = null;

export function wallet(): Promise<WalletSelector> {
  selector ??= setupWalletSelector({
    network: NETWORK,
    modules: [setupMyNearWallet(), setupMeteorWallet(), setupIntearWallet()],
  }).then((s) => {
    modal = setupModal(s, { contractId: CONTRACT });
    return s;
  });
  return selector;
}

export async function signIn() {
  await wallet();
  modal?.show();
}

export async function signOut() {
  const s = await wallet();
  if (s.isSignedIn()) await (await s.wallet()).signOut();
}

export async function accountId(): Promise<string | null> {
  const s = await wallet();
  return s.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
}

/** Calls a contract method from the signed-in account. Returns the transaction hash when the wallet gives one. */
export async function call(method: string, args: object, deposit = "0", gas = GAS_50): Promise<string | null> {
  const s = await wallet();
  if (!s.isSignedIn()) throw new Error("Connect a wallet first.");
  const w = await s.wallet();
  const res = await w.signAndSendTransaction({
    receiverId: CONTRACT,
    // wallet-selector v10 takes near-api-js actions
    actions: [actionCreators.functionCall(method, args, BigInt(gas), BigInt(deposit))],
  });
  const failure = (res as { status?: { Failure?: unknown } } | undefined)?.status?.Failure;
  if (failure) throw new Error(`Transaction failed: ${JSON.stringify(failure).slice(0, 300)}`);
  return (res as { transaction?: { hash?: string } } | undefined)?.transaction?.hash ?? null;
}
