// Mirrors the contract's JSON views (contract/src/lib.rs, v2).
export type Config = {
  owner: string;
  period_minutes: number;
  grace_min: number;
  min_signals: number;
  max_signals_per_day: number;
  scorer_wasm_url: string;
  scorer_wasm_hash: string;
  outlayer: string;
  reference_usd: number;
  liquidity_floor_usd: number;
};
export type Plan = { days: number; price: string };
export type Stats = {
  signals: number;
  scored: number;
  wins: number;
  filled: number;
  sum_bps: number;
  periods_released: number;
  periods_refunded: number;
  earned: string;
  refundable: string;
};
export type Channel = {
  id: number;
  creator: string;
  name: string;
  about: string;
  plans: Plan[];
  max_members: number;
  created_at_ms: number;
  member_list: string[];
  signal_count: number;
  next_period: number;
  level: number | string;
  stats: Stats;
};
export type Sub = { start_ms: number; end_ms: number; held: string };
export type Member = { until_ms: number; pubkey: string | null; subs: Sub[] };
export type Market = { venue: "hyperliquid" | "gecko"; network?: string | null; address: string; symbol: string };
export type SignalBody = {
  market: Market;
  side: "long" | "short";
  leverage: number;
  entry_low: string;
  entry_high: string;
  tps: string[];
  sl: string;
  msg: string;
};
export type SignalStatus = "Sealed" | { Revealed: { by: string; at_ms: number } } | { Unrevealed: { at_ms: number } };
export type Signal = {
  id: number;
  channel: number;
  creator: string;
  period: number;
  posted_at_ms: number;
  valid_min: number;
  commit: string;
  reveal_round: number;
  tlock_ct: string;
  member_ct: string;
  wrapped_keys: { member: string; key: string }[];
  status: SignalStatus;
  body: SignalBody | null;
  r_bps: number | null;
  outcome: string | null;
  fill_price: string | null;
  exit_price: string | null;
  cost_bps: number | null;
};
export type PeriodResult = {
  status: "Settling" | "Settled";
  signals: number;
  sum_bps: number;
  score_bps: number;
  released: boolean;
  held: string;
  settled_at_ms: number;
};

export const opensAt = (s: Signal) => s.posted_at_ms + s.valid_min * 60_000;
export const isSealed = (s: Signal) => s.status === "Sealed";
export const isUnrevealed = (s: Signal) => typeof s.status === "object" && "Unrevealed" in s.status;
