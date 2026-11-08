// Live, unofficial replay of a signal in the browser: the same rules as the OutLayer scorer
// (scorer/src/lib.rs), on the same public candles. The official result is the one OutLayer writes
// to the contract at settlement; this only lets people follow a signal while it runs.
import { GT, HL, HL_TAKER_FEE } from "./config";
import { gtFetch } from "./markets";
import type { SignalBody } from "./types";

type Candle = { t: number; high: number; low: number; close: number }; // t in ms

export type Live = {
  state: "waiting" | "open" | "closed";
  outcome: string; // "not filled", "TP1", "TP1 + SL", "SL", "liquidated", "open"
  fill: number | null;
  fillAt: number | null;
  last: number | null;
  r: number | null; // fraction, after costs (open positions marked at the last close)
};

async function hlCandles(coin: string, from: number, to: number): Promise<Candle[]> {
  const r = await fetch(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: "1m", startTime: from, endTime: to } }) });
  const j = (await r.json()) as { t: number; h: string; l: string; c: string }[];
  return (Array.isArray(j) ? j : []).map((c) => ({ t: c.t, high: +c.h, low: +c.l, close: +c.c }));
}

const pools = new Map<string, { pool: string; liq: number; fee: number }>();
async function gtCandles(network: string, token: string, from: number, to: number): Promise<{ candles: Candle[]; liq: number; fee: number }> {
  const key = `${network}:${token}`;
  if (!pools.has(key)) {
    const j = await (await gtFetch(`${GT}/networks/${network}/tokens/${token}/pools`)).json();
    const best = (j.data ?? []).map((p: { attributes: Record<string, string> }) => ({ pool: p.attributes.address, liq: Number(p.attributes.reserve_in_usd) || 0, fee: Number(p.attributes.pool_fee_percentage) / 100 || 0.0025 }))
      .sort((a: { liq: number }, b: { liq: number }) => b.liq - a.liq)[0];
    if (!best) throw new Error("no pool");
    pools.set(key, best);
  }
  const p = pools.get(key)!;
  const minutes = Math.ceil((to - from) / 60_000);
  const [tf, agg] = minutes <= 1000 ? ["minute", 1] : minutes <= 5000 ? ["minute", 5] : ["minute", 15];
  const j = await (await gtFetch(`${GT}/networks/${network}/pools/${p.pool}/ohlcv/${tf}?aggregate=${agg}&limit=1000&before_timestamp=${Math.floor(to / 1000)}&currency=usd&token=${token}`)).json();
  const list = (j?.data?.attributes?.ohlcv_list ?? []) as number[][];
  return { candles: list.map((c) => ({ t: c[0] * 1000, high: +c[2], low: +c[3], close: +c[4] })), liq: p.liq, fee: p.fee };
}

/** Replays a signal from its posting to min(now, end of validity). */
export async function replay(b: SignalBody, postedMs: number, validMin: number, now = Date.now()): Promise<Live> {
  const micro = b.market.venue === "gecko_micro";
  const end = Math.min(now, postedMs + validMin * 60_000);
  let candles: Candle[];
  let cIn: number, cOut: number;
  if (b.market.venue === "hyperliquid") {
    candles = await hlCandles(b.market.address, postedMs, end);
    cIn = cOut = HL_TAKER_FEE;
  } else {
    const g = await gtCandles(b.market.network ?? "", b.market.address, postedMs, end);
    candles = g.candles;
    cIn = cOut = Math.min(0.99, g.fee + 500 / (0.5 * Math.max(1, g.liq)));
  }
  const step = candles.length > 1 ? candles[1].t - candles[0].t : 60_000;
  const w = candles.filter((c) => c.t >= postedMs && c.t + step <= end && c.close > 0).sort((a, c) => a.t - c.t);
  const lo = +b.entry_low, hi = +b.entry_high, sl = +b.sl, tps = b.tps.map(Number), lev = Math.max(1, b.leverage), long = b.side === "long";
  const last = w.length ? w[w.length - 1].close : null;
  const fi = w.findIndex((c) => c.close >= lo && c.close <= hi);
  if (fi < 0) return { state: "waiting", outcome: "not filled", fill: null, fillAt: null, last, r: 0 };
  const fill = w[fi].close;
  const liq = long ? fill * (1 - 1 / lev) : fill * (1 + 1 / lev);
  const part = (exit: number) => (Number.isNaN(exit) ? -1 : Math.max(-1, lev * (long ? exit / fill - 1 : 1 - exit / fill) - lev * (cIn + cOut)));
  const exits: number[] = [];
  let hit = 0;
  let streak = 0; // micro-caps: a TP needs two closes in a row beyond it
  const done = (outcome: string): Live => ({ state: "closed", outcome, fill, fillAt: w[fi].t, last, r: exits.map(part).reduce((a, x) => a + x, 0) / exits.length });
  for (const c of w.slice(fi + 1)) {
    if (long ? lev > 1 && c.low <= liq : c.high >= liq) {
      while (exits.length < tps.length) exits.push(NaN);
      return done(hit ? `TP${hit} + liquidated` : "liquidated");
    }
    if (long ? c.close <= sl : c.close >= sl) {
      while (exits.length < tps.length) exits.push(c.close);
      return done(hit ? `TP${hit} + SL` : "SL");
    }
    const beyond = (tp: number) => (long ? c.close >= tp : c.close <= tp);
    streak = hit < tps.length && beyond(tps[hit]) ? streak + 1 : 0;
    if (streak >= (micro ? 2 : 1)) { while (hit < tps.length && beyond(tps[hit])) { exits.push(tps[hit]); hit++; } streak = 0; }
    if (hit === tps.length) return done(`TP${hit}`);
  }
  // still open: mark the rest at the last close (micro-caps at expiry: median of the last 30 minutes, or the lowest close)
  let mark = last ?? fill;
  if (micro && now >= postedMs + validMin * 60_000 && w.length) {
    const from = w[w.length - 1].t - 1_800_000;
    const tail = w.filter((c) => c.t >= from).map((c) => c.close).sort((a, c) => a - c);
    mark = tail.length >= 10 ? (tail.length % 2 ? tail[(tail.length - 1) / 2] : (tail[tail.length / 2 - 1] + tail[tail.length / 2]) / 2) : tail[0] ?? mark;
  }
  while (exits.length < tps.length) exits.push(mark);
  const r = exits.map(part).reduce((a, x) => a + x, 0) / exits.length;
  const ended = now >= postedMs + validMin * 60_000;
  return { state: ended ? "closed" : "open", outcome: ended ? (hit ? `TP${hit} + expired` : "expired") : hit ? `TP${hit} hit, rest open` : "open", fill, fillAt: w[fi].t, last, r };
}
