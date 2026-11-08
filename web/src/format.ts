import type { Signal } from "./types";

export const pct = (bps: number | null | undefined, sign = true) =>
  bps == null ? "—" : `${sign && bps > 0 ? "+" : bps < 0 ? "−" : ""}${Math.abs(bps / 100).toFixed(1)}%`;

export const yocto = (y: string | bigint | number) => BigInt(typeof y === "number" ? Math.max(0, Math.trunc(y)) : y);
export const nearNum = (y: string | bigint | number) => {
  const v = yocto(y);
  return Number(v / 10n ** 18n) / 1e6;
};
export const near = (y: string | bigint | number, digits = 2) => `${nearNum(y).toFixed(digits).replace(/\.?0+$/, "") || "0"} NEAR`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
export const day = (ms: number) => { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
export const when = (ms: number) => { const d = new Date(ms); return `${day(ms)} ${two(d.getHours())}:${two(d.getMinutes())}`; };

/** Countdown "71:57:12" (hours can exceed 24). */
export const countdown = (ms: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  return `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
};

/** Minutes -> "45m", "4h", "1d 6h", "3d". */
export const dur = (min: number) => {
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ") || "0m";
};
export const planName = (days: number) =>
  days % 365 === 0 ? `${days / 365 > 1 ? days / 365 + " years" : "12 months"}` :
  days % 30 === 0 ? `${days / 30} month${days > 30 ? "s" : ""}` :
  days % 7 === 0 ? `${days / 7} week${days > 7 ? "s" : ""}` : `${days} day${days > 1 ? "s" : ""}`;

/** "3041.5" -> "3,041.5"; keeps the decimals the creator typed. */
export const price = (s: string | number | null | undefined) => {
  if (s == null || s === "") return "—";
  const str = typeof s === "number" ? sig(s) : s;
  const [i, f] = str.split(".");
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? `.${f}` : "");
};
/** Number with 6 significant digits as a plain string. */
export const sig = (x: number) => {
  if (!(x > 0 && isFinite(x))) return "0";
  const dec = Math.min(18, Math.max(0, 5 - Math.floor(Math.log10(x))));
  return x.toFixed(dec).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
};

export const periodWord = (minutes: number) => (minutes === 10080 ? "week" : minutes === 1440 ? "day" : "period");

const OUTCOMES: Record<string, string> = {
  not_filled: "not filled",
  expired: "expired",
  sl: "SL",
  liquidated: "liquidated",
  invalid: "invalid signal",
  unrevealed: "never opened",
  no_market: "no market",
  below_floor: "pool under the liquidity floor",
  no_pool_at_post: "no pool at posting",
  no_data: "no price data",
  no_trades: "no trades",
};
/** "tp1+sl (15m)" -> "TP1 + SL (15m candles)". */
export const outcomeText = (o: string | null) => {
  if (!o) return "";
  const m = o.match(/^([^ ]+)(?: \((\w+)\))?$/);
  const core = (m?.[1] ?? o).split("+").map((p) => (p.startsWith("tp") ? p.toUpperCase() : OUTCOMES[p] ?? p)).join(" + ");
  return m?.[2] ? `${core} (${m[2]} candles)` : core;
};
export const outcomeKind = (s: Signal): "w" | "l" | "n" | "s" =>
  s.r_bps == null ? "s" : s.r_bps > 0 ? "w" : s.r_bps === 0 ? "n" : "l";

/** Costs in basis points -> "0.09%", "1.2%". */
export const costPct = (bps: number) => `${(bps / 100).toFixed(bps < 100 ? 2 : 1)}%`;

/** URL name of a channel: "Kopi Perps" -> "kopi-perps". */
export const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "channel";
/** Channel URL: /#/@creator/slug (the id when two channels of a creator share a name). */
export const channelPath = (ch: { id: number; creator: string; name: string }, all: { id: number; creator: string; name: string }[]) => {
  const same = all.filter((c) => c.creator === ch.creator && slug(c.name) === slug(ch.name));
  return `#/@${ch.creator}/${same.length > 1 ? ch.id : slug(ch.name)}`;
};
