// Market search and live prices from public, keyless APIs (Hyperliquid, GeckoTerminal).
import { GT, HL } from "./config";
import type { Market } from "./types";

export type Found = { market: Market; label: string; price: number | null; liquidity: number | null; maxLeverage: number };

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
  const r = await fetch(`${GT}/networks/${net}/tokens/${addr}/pools?include=base_token,quote_token`);
  if (r.status === 429) return "limited";
  if (!r.ok) return "none";
  const j = await r.json();
  const inc = new Map<string, { symbol: string; address: string }>();
  for (const t of j.included ?? []) inc.set(t.id, { symbol: String(t.attributes?.symbol ?? ""), address: String(t.attributes?.address ?? "") });
  let best: Found | null = null;
  for (const p of j.data ?? []) {
    const b = inc.get(p.relationships?.base_token?.data?.id);
    const q = inc.get(p.relationships?.quote_token?.data?.id);
    if (!b || !q) continue;
    const mine = b.address.toLowerCase() === addr.toLowerCase() ? b : q.address.toLowerCase() === addr.toLowerCase() ? q : null;
    const other = mine === b ? q : b;
    if (!mine || !MAJORS.has(other.symbol.toUpperCase())) continue;
    const liq = Number(p.attributes?.reserve_in_usd) || 0;
    if (best && (best.liquidity ?? 0) >= liq) continue;
    const priceUsd = Number(mine === b ? p.attributes?.base_token_price_usd : p.attributes?.quote_token_price_usd) || null;
    best = { market: { venue: "gecko", network: net, address: mine.address, symbol: mine.symbol }, label: `${networkName(net)} DEX`, price: priceUsd, liquidity: liq, maxLeverage: 1 };
  }
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
    for (const net of isSolAddr(query) ? ["solana"] : EVM_NETS) {
      try {
        const f = await tokenOnNetwork(net, query);
        if (f === "limited") limited = true;
        else if (f !== "none") out.push(f);
      } catch { limited = true; }
    }
    const note = out.length ? null : limited
      ? "GeckoTerminal is rate-limiting this browser. Wait a minute and try again."
      : "No pool for this token paired with SOL, ETH, USDC, USDT or USDG was found (checked Solana, Ethereum, Base, BNB Chain, Arbitrum and Robinhood Chain). Sealed Calls only scores tokens with such a pool.";
    return { results: out, note };
  }

  const up = query.toUpperCase();
  try {
    const h = await hl();
    const hits = h.names.filter((n) => n.toUpperCase() === up || (up.length >= 2 && n.toUpperCase().startsWith(up)));
    hits.sort((a, b) => (a.toUpperCase() === up ? -1 : b.toUpperCase() === up ? 1 : a.length - b.length));
    for (const n of hits.slice(0, 3)) {
      out.push({ market: { venue: "hyperliquid", address: n, symbol: n }, label: "perp · Hyperliquid", price: Number(h.mids[n]) || null, liquidity: null, maxLeverage: h.maxLev.get(n) ?? 20 });
    }
  } catch { /* Hyperliquid unreachable: DEX results only */ }
  try {
    const r = await fetch(`${GT}/search/pools?query=${encodeURIComponent(query)}&include=base_token,quote_token`);
    if (r.status === 429) limited = true;
    const j = r.ok ? await r.json() : {};
    const inc = new Map<string, { symbol: string; address: string }>();
    for (const t of j.included ?? []) inc.set(t.id, { symbol: String(t.attributes?.symbol ?? ""), address: String(t.attributes?.address ?? "") });
    const best = new Map<string, Found>();
    for (const p of j.data ?? []) {
      const net = p.relationships?.network?.data?.id as string;
      const base = inc.get(p.relationships?.base_token?.data?.id);
      const quote = inc.get(p.relationships?.quote_token?.data?.id);
      if (!net || !base || !quote || !MAJORS.has(quote.symbol.toUpperCase())) continue;
      if (!base.symbol.toUpperCase().startsWith(up)) continue;
      const liq = Number(p.attributes?.reserve_in_usd) || 0;
      const key = `${net}:${base.address}`;
      if ((best.get(key)?.liquidity ?? -1) >= liq) continue;
      best.set(key, {
        market: { venue: "gecko", network: net, address: base.address, symbol: base.symbol },
        label: `${networkName(net)} DEX`,
        price: Number(p.attributes?.base_token_price_usd) || null,
        liquidity: liq,
        maxLeverage: 1,
      });
    }
    out.push(...[...best.values()].sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0)).slice(0, 5));
  } catch { limited = true; }
  const note = out.length ? null : limited ? "GeckoTerminal is rate-limiting this browser. Wait a minute and try again." : `Nothing found for “${query}”. Try the ticker of a Hyperliquid perp, or paste the token's address.`;
  return { results: out, note };
}

/** Current USD price of a market, or null. */
export async function priceOf(m: Market): Promise<number | null> {
  try {
    if (m.venue === "hyperliquid") return Number((await hl()).mids[m.address]) || null;
    const j = await (await fetch(`${GT}/simple/networks/${m.network}/token_price/${m.address}`)).json();
    const v = Object.values(j?.data?.attributes?.token_prices ?? {})[0];
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function chartUrl(m: Market) {
  return m.venue === "hyperliquid" ? `https://app.hyperliquid.xyz/trade/${m.address}` : `https://www.geckoterminal.com/${m.network}/tokens/${m.address}`;
}
