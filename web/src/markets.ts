// Market search and live prices from public, keyless APIs: Hyperliquid for perps, DexScreener for
// finding DEX tokens and their prices (generous rate limit), GeckoTerminal for candles (the same
// source the scorer uses). GeckoTerminal's free API allows ~30 calls a minute per browser, so every
// call to it goes through one paced, cached queue.
import { GT, HL } from "./config";

const DS = "https://api.dexscreener.com/latest/dex";
/** DexScreener chain id -> GeckoTerminal network id (the scorer's). */
const DS_TO_GT: Record<string, string> = { ethereum: "eth", polygon: "polygon_pos", avalanche: "avax" };
const gtNet = (chain: string) => DS_TO_GT[chain] ?? chain;

const gtCache = new Map<string, { at: number; p: Promise<Response> }>();
let gtNext = 0;
/** GeckoTerminal fetch: one request every 2.2 s at most, cached for a minute, one retry after a 429. */
export function gtFetch(url: string): Promise<Response> {
  const hit = gtCache.get(url);
  if (hit && Date.now() - hit.at < 60_000) return hit.p.then((r) => r.clone());
  const run = async (): Promise<Response> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const wait = Math.max(0, gtNext - Date.now());
      gtNext = Math.max(gtNext, Date.now()) + 2_200;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const r = await fetch(url);
      if (r.status !== 429) return r;
      gtNext = Date.now() + 6_000;
    }
    return fetch(url);
  };
  const p = run();
  gtCache.set(url, { at: Date.now(), p });
  p.then((r) => { if (!r.ok) gtCache.delete(url); }).catch(() => gtCache.delete(url));
  return p.then((r) => r.clone());
}

type DsPair = { chainId: string; pairAddress: string; baseToken: { address: string; symbol: string }; quoteToken: { address: string; symbol: string }; priceUsd?: string; liquidity?: { usd?: number }; fdv?: number; marketCap?: number };

/** Best (deepest) DexScreener pair per token, paired with a major. Deeper pools paired with some
 *  other token (e.g. a memecoin/memecoin pair) are noted in `other` so the desk can explain. */
function dsFound(pairs: DsPair[], match: (p: DsPair) => boolean): Found[] {
  const best = new Map<string, Found>();
  const others = new Map<string, { symbol: string; liquidity: number }>();
  for (const p of pairs) {
    if (!match(p)) continue;
    const net = gtNet(p.chainId);
    const liq = p.liquidity?.usd ?? 0;
    const key = `${net}:${p.baseToken.address}`;
    if (!MAJORS.has((p.quoteToken?.symbol ?? "").toUpperCase())) {
      if ((others.get(key)?.liquidity ?? -1) < liq) others.set(key, { symbol: p.quoteToken?.symbol ?? "?", liquidity: liq });
      if (!best.has(key)) best.set(key, { market: { venue: "gecko", network: net, address: p.baseToken.address, symbol: p.baseToken.symbol }, label: `${networkName(net)} DEX`, price: Number(p.priceUsd) || null, liquidity: 0, mcap: p.marketCap || p.fdv || null, maxLeverage: 1, noMajor: true });
      continue;
    }
    const cur = best.get(key);
    if (cur && !cur.noMajor && (cur.liquidity ?? -1) >= liq) continue;
    best.set(key, {
      market: { venue: "gecko", network: net, address: p.baseToken.address, symbol: p.baseToken.symbol },
      label: `${networkName(net)} DEX`,
      price: Number(p.priceUsd) || null,
      liquidity: liq,
      mcap: p.marketCap || p.fdv || null,
      maxLeverage: 1,
    });
  }
  for (const [k, f] of best) { const o = others.get(k); if (o && o.liquidity > (f.liquidity ?? 0)) f.other = o; }
  return [...best.values()].sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
}
import type { Market } from "./types";

export type Found = {
  market: Market; label: string; price: number | null; liquidity: number | null; mcap: number | null; maxLeverage: number;
  /** Deepest pool paired with a non-major token, when it is deeper than the SOL/USDC/… pool we score on. */
  other?: { symbol: string; liquidity: number };
  /** No pool against SOL/USDC/ETH/… at all. */
  noMajor?: boolean;
};

type HlMeta = { names: string[]; maxLev: Map<string, number>; mids: Record<string, string>; at: number };
let hlCache: HlMeta | null = null;

async function hl(): Promise<HlMeta> {
  if (hlCache && Date.now() - hlCache.at < 30_000) return hlCache;
  const post = (body: object) => fetch(HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const [meta, mids] = await Promise.all([post({ type: "meta" }), post({ type: "allMids" })]);
  const universe = (meta?.universe ?? []) as { name: string; maxLeverage: number; isDelisted?: boolean }[];
  const live = universe.filter((u) => !u.isDelisted);
  hlCache = { names: live.map((u) => u.name), maxLev: new Map(live.map((u) => [u.name, u.maxLeverage])), mids, at: Date.now() };
  return hlCache;
}

const MAJORS = new Set(["SOL", "WSOL", "USDC", "USDT", "ETH", "WETH", "BNB", "WBNB", "BTC", "WBTC", "CBBTC", "AVAX", "WAVAX", "POL", "WPOL", "MATIC", "WMATIC", "ARB", "S", "WS", "SUI", "TON", "TRX", "USDE", "DAI", "USDC.E", "USDBC", "FDUSD", "PYUSD", "USDG"]);
const NETWORK_NAMES: Record<string, string> = { robinhood: "Robinhood Chain", solana: "Solana", eth: "Ethereum", base: "Base", bsc: "BNB Chain", arbitrum: "Arbitrum", polygon_pos: "Polygon", avax: "Avalanche", sonic: "Sonic", ton: "TON", sui: "Sui" };
export const networkName = (n?: string | null) => (n ? NETWORK_NAMES[n] ?? n : "");

export function venueLabel(m: Market) {
  return m.venue === "hyperliquid" ? "Hyperliquid perp" : `${networkName(m.network)} DEX`;
}

export type Search = { results: Found[]; note: string | null };

const isSolAddr = (q: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
const isEvmAddr = (q: string) => /^0x[0-9a-fA-F]{40}$/.test(q);
const EVM_NETS = ["eth", "base", "bsc", "arbitrum", "robinhood"];

/** Pools of one token on one network, paired with a major; best (deepest) as a Found. */
async function tokenOnNetwork(net: string, addr: string): Promise<Found | "none" | "limited"> {
  const r = await gtFetch(`${GT}/networks/${net}/tokens/${addr}/pools?include=base_token,quote_token`);
  if (r.status === 429) return "limited";
  if (!r.ok) return "none";
  const j = await r.json();
  const inc = new Map<string, { symbol: string; address: string }>();
  for (const t of j.included ?? []) inc.set(t.id, { symbol: String(t.attributes?.symbol ?? ""), address: String(t.attributes?.address ?? "") });
  let best: Found | null = null;
  let other: { symbol: string; liquidity: number } | null = null;
  let sym = "";
  for (const p of j.data ?? []) {
    const b = inc.get(p.relationships?.base_token?.data?.id);
    const q = inc.get(p.relationships?.quote_token?.data?.id);
    if (!b || !q) continue;
    const mine = b.address.toLowerCase() === addr.toLowerCase() ? b : q.address.toLowerCase() === addr.toLowerCase() ? q : null;
    const otherTok = mine === b ? q : b;
    if (!mine) continue;
    sym = mine.symbol;
    const liq = Number(p.attributes?.reserve_in_usd) || 0;
    if (!MAJORS.has(otherTok.symbol.toUpperCase())) {
      if ((other?.liquidity ?? -1) < liq) other = { symbol: otherTok.symbol, liquidity: liq };
      continue;
    }
    if (best && (best.liquidity ?? 0) >= liq) continue;
    const priceUsd = Number(mine === b ? p.attributes?.base_token_price_usd : p.attributes?.quote_token_price_usd) || null;
    const mc = Number(p.attributes?.market_cap_usd) || Number(p.attributes?.fdv_usd) || null;
    best = { market: { venue: "gecko", network: net, address: mine.address, symbol: mine.symbol }, label: `${networkName(net)} DEX`, price: priceUsd, liquidity: liq, mcap: mine === b ? mc : null, maxLeverage: 1 };
  }
  if (!best && other) best = { market: { venue: "gecko", network: net, address: addr, symbol: sym }, label: `${networkName(net)} DEX`, price: null, liquidity: 0, mcap: null, maxLeverage: 1, noMajor: true };
  if (best && other && other.liquidity > (best.liquidity ?? 0)) best.other = other;
  return best ?? "none";
}

/** Hyperliquid perps first (exact, then prefix), then DEX tokens grouped by token, deepest pool first. */
export async function searchMarkets(q: string): Promise<Search> {
  const query = q.trim();
  if (!query) return { results: [], note: null };
  const out: Found[] = [];
  let limited = false;

  // A token address: look it up directly (search doesn't always index new tokens).
  if (isSolAddr(query) || isEvmAddr(query)) {
    try {
      const j = await (await fetch(`${DS}/tokens/${query}`)).json();
      const f = dsFound((j.pairs ?? []) as DsPair[], (p) => p.baseToken.address.toLowerCase() === query.toLowerCase());
      if (f.length) return { results: f.slice(0, 3), note: null };
    } catch { /* fall back to GeckoTerminal */ }
    for (const net of isSolAddr(query) ? ["solana"] : EVM_NETS) {
      try {
        const f = await tokenOnNetwork(net, query);
        if (f === "limited") limited = true;
        else if (f !== "none") out.push(f);
      } catch { limited = true; }
    }
    const note = out.length ? null : limited
      ? "The price service is busy. Wait a minute and try again."
      : "No pool for this token paired with SOL, ETH, USDC, USDT or USDG was found (checked Solana, Ethereum, Base, BNB Chain, Arbitrum and Robinhood Chain). Sealed Calls only scores tokens with such a pool.";
    return { results: out, note };
  }

  const up = query.toUpperCase();
  try {
    const h = await hl();
    const hits = h.names.filter((n) => n.toUpperCase() === up || (up.length >= 2 && n.toUpperCase().startsWith(up)));
    hits.sort((a, b) => (a.toUpperCase() === up ? -1 : b.toUpperCase() === up ? 1 : a.length - b.length));
    for (const n of hits.slice(0, 3)) {
      out.push({ market: { venue: "hyperliquid", address: n, symbol: n }, label: "perp · Hyperliquid", price: Number(h.mids[n]) || null, liquidity: null, mcap: null, maxLeverage: h.maxLev.get(n) ?? 20 });
    }
  } catch { /* Hyperliquid unreachable: DEX results only */ }
  try {
    const j = await (await fetch(`${DS}/search?q=${encodeURIComponent(query)}`)).json();
    out.push(...dsFound((j.pairs ?? []) as DsPair[], (p) => p.baseToken.symbol.toUpperCase().startsWith(up)).slice(0, 5));
  } catch { limited = true; }
  const note = out.length ? null : limited ? "The price service is busy. Wait a minute and try again." : `Nothing found for “${query}”. Try the ticker of a Hyperliquid perp, or paste the token's address.`;
  return { results: out, note };
}

/** Current USD price of a market, or null. */
export async function priceOf(m: Market): Promise<number | null> {
  try {
    if (m.venue === "hyperliquid") return Number((await hl()).mids[m.address]) || null;
    const j = await (await fetch(`${DS}/tokens/${m.address}`)).json();
    const f = dsFound((j.pairs ?? []) as DsPair[], (p) => p.baseToken.address.toLowerCase() === m.address.toLowerCase() && gtNet(p.chainId) === m.network);
    return f[0]?.price ?? null;
  } catch {
    return null;
  }
}

export function chartUrl(m: Market) {
  return m.venue === "hyperliquid" ? `https://app.hyperliquid.xyz/trade/${m.address}` : `https://www.geckoterminal.com/${m.network}/tokens/${m.address}`;
}

// ------------------------------------------------------------- market cap at the call (DEX tokens)
const tokenInfo = new Map<string, Promise<{ price: number; fdv: number } | null>>();

/** ≈ market cap when the signal was called: today's FDV scaled by (price at the call ÷ price now). */
export async function mcapAtCall(m: Market, priceAtCall: number): Promise<number | null> {
  if (m.venue === "hyperliquid" || !(priceAtCall > 0)) return null;
  const key = `${m.network}:${m.address}`;
  if (!tokenInfo.has(key)) {
    tokenInfo.set(key, fetch(`${DS}/tokens/${m.address}`).then((r) => r.json()).then((j) => {
      const f = dsFound((j.pairs ?? []) as DsPair[], (p) => p.baseToken.address.toLowerCase() === m.address.toLowerCase() && gtNet(p.chainId) === m.network)[0];
      return f && f.price && f.mcap ? { price: f.price, fdv: f.mcap } : null;
    }).catch(() => null));
  }
  const info = await tokenInfo.get(key)!;
  return info ? (info.fdv * priceAtCall) / info.price : null;
}

export const usdShort = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x)}`);
