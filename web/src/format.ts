import type { Call } from "./types";
import { isUnrevealed, revealedMint } from "./types";

export const pct = (bps: number | null | undefined, sign = true) =>
  bps == null ? "—" : `${sign && bps > 0 ? "+" : bps < 0 ? "−" : ""}${Math.abs(bps / 100).toFixed(1)}%`;

export const near = (yocto: string | bigint, digits = 2) => {
  const y = BigInt(yocto);
  const whole = y / 10n ** 24n;
  const frac = Number((y % 10n ** 24n) / 10n ** 18n) / 1e6;
  return `${(Number(whole) + frac).toFixed(digits)} NEAR`;
};

export const short = (s: string, a = 4, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const when = (ms: number) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const until = (ms: number, now = Date.now()) => {
  let s = Math.max(0, Math.round((ms - now) / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s - m * 60}s`;
  return `${s}s`;
};

export const horizon = (min: number) => (min % 60 === 0 ? `${min / 60}h` : `${min}m`);

const NOTES: Record<string, string> = {
  median: "median exit",
  thin_exit_lowest: "thin exit, lowest close",
  below_floor: "pool under $100k",
  no_sol_usdc_pool: "no SOL/USDC pool",
  no_pool_at_post: "no pool at posting",
  no_entry_trade: "no trade after posting",
  no_exit_trades: "no trades at exit",
  unrevealed: "never opened",
  duplicate: "duplicate call",
};
export const noteText = (c: Call) => (c.note ? (NOTES[c.note] ?? c.note) : "");

/** Ticker cache filled from GeckoTerminal; falls back to a shortened mint. */
const names = new Map<string, string>();
export const tokenLabel = (c: Call) => {
  if (isUnrevealed(c)) return "unrevealed";
  const m = revealedMint(c);
  if (!m) return "sealed";
  return names.get(m) ?? short(m);
};
export const rememberName = (mint: string, sym: string) => names.set(mint, sym);
