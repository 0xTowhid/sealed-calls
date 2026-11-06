// Gate (d): can we get candles for every kind of asset we plan to score, free and without keys?
// Run: node fetch-candles.mjs      (Node 18+, no install needed)
// PASS = Hyperliquid OK, and GeckoTerminal OK for Solana and Base. Robinhood Chain is informational.
const now = Date.now();
const results = [];

async function check(label, fn) {
  try { const r = await fn(); results.push([label, "OK", r]); }
  catch (e) { results.push([label, "FAIL", String(e.message || e).slice(0, 160)]); }
}

// 1. Hyperliquid perps (the scorer's main source)
await check("hyperliquid ETH 1m", async () => {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin: "ETH", interval: "1m", startTime: now - 600_000, endTime: now } }),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const c = await res.json();
  return `${c.length} candles, last close ${c.at(-1)?.c}`;
});

// 2. GeckoTerminal: find the top pool for a token, then its 1m candles and liquidity.
async function gecko(network, token, label) {
  const base = "https://api.geckoterminal.com/api/v2";
  const pools = await (await fetch(`${base}/networks/${network}/tokens/${token}/pools?page=1`, { headers: { accept: "application/json" } })).json();
  const pool = pools?.data?.[0];
  if (!pool) throw new Error(`no pools: ${JSON.stringify(pools).slice(0, 120)}`);
  const addr = pool.attributes.address;
  const liq = Number(pool.attributes.reserve_in_usd);
  const res = await fetch(`${base}/networks/${network}/pools/${addr}/ohlcv/minute?aggregate=1&limit=5`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`ohlcv http ${res.status}`);
  const list = (await res.json())?.data?.attributes?.ohlcv_list;
  if (!list?.length) throw new Error("empty ohlcv_list");
  return `${label} pool ${addr} liquidity $${Math.round(liq).toLocaleString()} (floor $100k: ${liq >= 100_000 ? "pass" : "fail"}), newest close ${list[0][4]} at ${new Date(list[0][0] * 1000).toISOString()}`;
}
await check("geckoterminal solana (SOL)", () => gecko("solana", "So11111111111111111111111111111111111111112", "SOL"));
await check("geckoterminal base (WETH)", () => gecko("base", "0x4200000000000000000000000000000000000006", "WETH"));

// 3. Is Robinhood Chain indexed by GeckoTerminal? (informational: decides whether stock tokens make the MVP)
await check("geckoterminal networks: robinhood?", async () => {
  let page = 1, hits = [];
  while (page <= 10) {
    const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks?page=${page}`, { headers: { accept: "application/json" } })).json();
    if (!j?.data?.length) break;
    hits.push(...j.data.filter((n) => /robinhood/i.test(n.id + n.attributes?.name)).map((n) => n.id));
    page++;
  }
  return hits.length ? `found: ${hits.join(", ")}` : "not listed (score stock tokens on the underlying stock, or defer)";
});

for (const [label, status, detail] of results) console.log(`${status.padEnd(4)} ${label}: ${detail}`);
const pass = results.slice(0, 3).every((r) => r[1] === "OK");
console.log(pass ? "\nGATE (d) PASS — print the Solana pool address above; run-probe.sh call-gt uses it." : "\nGATE (d) FAIL — fall back to DexScreener or Hyperliquid-only for the MVP.");
