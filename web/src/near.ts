import { setupWalletSelector, actionCreators, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import { CONTRACT, NETWORK, RPCS } from "./config";
import type { Call, Club, EpochResult } from "./types";

const enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export async function view<T>(method: string, args: object = {}): Promise<T> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: { request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: method, args_base64: enc(JSON.stringify(args)) },
  };
  let last = "";
  for (const url of RPCS) {
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      const err = j.error ?? j.result?.error;
      if (err) { last = typeof err === "string" ? err : JSON.stringify(err); continue; }
      return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
    } catch (e) { last = String(e); }
  }
  throw new Error(`Couldn't read ${method} from ${CONTRACT}: ${last.slice(0, 200)}`);
}

export const getClub = (club: number) => view<Club | null>("get_club", { club });
export const getEpoch = (club: number, epoch: number) => view<EpochResult | null>("get_epoch", { club, epoch });
export const currentEpoch = (club: number) => view<number>("current_epoch", { club });

/** Every call in a club, newest first (the contract pages by 100). */
export async function allCalls(club: number, total: number): Promise<Call[]> {
  const out: Call[] = [];
  let from = total;
  while (from > 0) {
    const page = await view<Call[]>("list_calls", { club, from_index: from, limit: 100 });
    out.push(...page);
    from -= 100;
  }
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
export async function call(method: string, args: object, deposit = "0", gas = "300000000000000"): Promise<string | null> {
  const s = await wallet();
  if (!s.isSignedIn()) throw new Error("Sign in first.");
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
