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

const MAJORS = new Set(["SOL", "WSOL", "USDC", "USDT", "ETH", "WETH", "BNB", "WBNB", "BTC", "WBTC", "CBBTC", "AVAX", "WAVAX", "POL", "WPOL", "MATIC", "WMATIC", "ARB", "S", "WS", "SUI", "TON", "TRX", "USDE", "DAI", "USDC.E", "USDBC", "FDUSD", "PYUSD"]);
const NETWORK_NAMES: Record<string, string> = { solana: "Solana", eth: "Ethereum", base: "Base", bsc: "BNB Chain", arbitrum: "Arbitrum", polygon_pos: "Polygon", avax: "Avalanche", sonic: "Sonic", ton: "TON", sui: "Sui" };
export const networkName = (n?: string | null) => (n ? NETWORK_NAMES[n] ?? n : "");

export function venueLabel(m: Market) {
  return m.venue === "hyperliquid" ? "Hyperliquid perp" : `${networkName(m.network)} DEX`;
}

/** Hyperliquid perps first (exact, then prefix), then DEX tokens grouped by token, deepest pool first. */
export async function searchMarkets(q: string): Promise<Found[]> {
  const query = q.trim();
  if (!query) return [];
  const up = query.toUpperCase();
  const out: Found[] = [];
  try {
    const h = await hl();
    const hits = h.names.filter((n) => n.toUpperCase() === up || (up.length >= 2 && n.toUpperCase().startsWith(up)));
    hits.sort((a, b) => (a.toUpperCase() === up ? -1 : b.toUpperCase() === up ? 1 : a.length - b.length));
    for (const n of hits.slice(0, 3)) {
      out.push({ market: { venue: "hyperliquid", address: n, symbol: n }, label: "perp · Hyperliquid", price: Number(h.mids[n]) || null, liquidity: null, maxLeverage: h.maxLev.get(n) ?? 20 });
    }
  } catch { /* Hyperliquid unreachable: DEX results only */ }
  try {
    const j = await (await fetch(`${GT}/search/pools?query=${encodeURIComponent(query)}&include=base_token,quote_token`)).json();
    const inc = new Map<string, { symbol: string; address: string }>();
    for (const t of j.included ?? []) inc.set(t.id, { symbol: String(t.attributes?.symbol ?? ""), address: String(t.attributes?.address ?? "") });
    const best = new Map<string, Found>();
    for (const p of j.data ?? []) {
      const net = p.relationships?.network?.data?.id as string;
      const base = inc.get(p.relationships?.base_token?.data?.id);
      const quote = inc.get(p.relationships?.quote_token?.data?.id);
      if (!net || !base || !quote || !MAJORS.has(quote.symbol.toUpperCase())) continue;
      const isAddr = query.length > 25;
      if (!(isAddr ? base.address.toLowerCase() === query.toLowerCase() : base.symbol.toUpperCase().startsWith(up))) continue;
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
  } catch { /* GeckoTerminal unreachable or rate-limited */ }
  return out;
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
