// Mirrors the contract's JSON views (contract/src/lib.rs).
export type ClubConfig = {
  name: string;
  epoch_minutes: number;
  epoch_budget: string;
  min_record: number;
  horizons_min: number[];
  grace_min: number;
  max_calls_per_day: number;
  scorer_wasm_url: string;
  scorer_wasm_hash: string;
  outlayer: string;
};
export type Member = { account: string; pubkey: string | null };
export type Club = {
  id: number;
  governor: string;
  config: ClubConfig;
  started_at_ms: number;
  escrow: string;
  callers: string[];
  members: Member[];
  call_count: number;
};
export type CallStatus =
  | "Sealed"
  | { Revealed: { mint: string; by: string; at_ms: number } }
  | { Unrevealed: { at_ms: number } };
export type Call = {
  id: number;
  club: number;
  caller: string;
  epoch: number;
  posted_at_ms: number;
  horizon_min: number;
  commit: string;
  reveal_round: number;
  tlock_ct: string;
  member_ct: string;
  wrapped_keys: { member: string; key: string }[];
  status: CallStatus;
  score_bps: number | null;
  note: string | null;
  entry_usd: string | null;
  exit_usd: string | null;
  cost_bps: number | null;
};
export type CallerResult = { caller: string; calls: number; sum_bps: number; score_bps: number; eligible: boolean; paid: string };
export type EpochResult = { status: "Settling" | "Settled"; budget: string; paid: string; callers: CallerResult[]; settled_at_ms: number };

export const opensAt = (c: Call) => c.posted_at_ms + c.horizon_min * 60_000;
export const isSealed = (c: Call) => c.status === "Sealed";
export const revealedMint = (c: Call) => (typeof c.status === "object" && "Revealed" in c.status ? c.status.Revealed.mint : null);
export const isUnrevealed = (c: Call) => typeof c.status === "object" && "Unrevealed" in c.status;
