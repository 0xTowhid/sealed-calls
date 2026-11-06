// Gate (d): can the scorer get everything the locked MVP needs for Solana memecoins, free and keyless?
// Run: node fetch-candles.mjs [tokenMint ...]     (Node 18+, no install)
// Defaults to BONK and WIF. PASS = checks 1–3 OK for at least one token. 4 and 5 are informational.
const tokens = process.argv.slice(2).length ? process.argv.slice(2) : [
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
];
const GT = "https://api.geckoterminal.com/api/v2";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const H = { headers: { accept: "application/json" } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // free tier: 30 calls/min
const get = async (url) => { await sleep(2100); const r = await fetch(url, H); if (!r.ok) throw new Error(`http ${r.status} ${url}`); return r.json(); };

let anyPass = false;
for (const mint of tokens) {
  console.log(`\n=== token ${mint}`);
  try {
    // 1. Pool selection inputs: quote token, liquidity, creation time (rule R3.1 needs pool_created_at).
    const pools = (await get(`${GT}/networks/solana/tokens/${mint}/pools`)).data ?? [];
    const quoteOf = (p) => p.relationships?.quote_token?.data?.id?.replace("solana_", "");
    const baseOf = (p) => p.relationships?.base_token?.data?.id?.replace("solana_", "");
    const eligible = pools
      .filter((p) => [SOL, USDC].includes(quoteOf(p)) || [SOL, USDC].includes(baseOf(p)))
      .sort((a, b) => Number(b.attributes.reserve_in_usd) - Number(a.attributes.reserve_in_usd));
    console.log(`1. pools listed: ${pools.length}, paired with SOL/USDC: ${eligible.length}`);
    for (const p of eligible.slice(0, 3)) {
      const a = p.attributes;
      console.log(`   ${a.address}  liq $${Math.round(Number(a.reserve_in_usd)).toLocaleString()}  created ${a.pool_created_at ?? "MISSING"}  dex ${p.relationships?.dex?.data?.id}`);
    }
    const top = eligible[0];
    if (!top) throw new Error("no SOL/USDC pool");
    const hasCreated = eligible.every((p) => p.attributes.pool_created_at);
    console.log(`   pool_created_at present on all eligible pools: ${hasCreated ? "OK" : "FAIL (R3.1 needs another source)"}`);

    // 2. Minute candles in USD and gap behaviour (R3.4: forward-fill if minutes are omitted).
    const ohlcv = await get(`${GT}/networks/solana/pools/${top.attributes.address}/ohlcv/minute?aggregate=1&limit=120&currency=usd&token=${mint}`);
    const list = ohlcv?.data?.attributes?.ohlcv_list ?? [];
    if (!list.length) throw new Error("empty ohlcv_list");
    const ts = list.map((c) => c[0]).sort((x, y) => x - y);
    let gaps = 0, zeroVol = 0;
    for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > 60) gaps += (ts[i] - ts[i - 1]) / 60 - 1;
    for (const c of list) if (Number(c[5]) === 0) zeroVol++;
    console.log(`2. ${list.length} 1m candles over ${Math.round((ts.at(-1) - ts[0]) / 60)} min; missing minutes: ${gaps}; zero-volume candles: ${zeroVol}`);
    console.log(`   => empty minutes are ${gaps > 0 ? "OMITTED (scorer must forward-fill)" : zeroVol > 0 ? "ZERO-FILLED" : "not observed in this window (try a thinner token)"}`);
    console.log(`   newest close $${list[0][4]} at ${new Date(list[0][0] * 1000).toISOString()}`);

    // 3. Can we read history at a past time? (entry may be up to 72 h before reveal)
    const before = Math.floor(Date.now() / 1000) - 72 * 3600;
    const old = await get(`${GT}/networks/solana/pools/${top.attributes.address}/ohlcv/minute?aggregate=1&limit=5&before_timestamp=${before}&currency=usd&token=${mint}`);
    const oldList = old?.data?.attributes?.ohlcv_list ?? [];
    console.log(`3. candles 72 h back via before_timestamp: ${oldList.length ? "OK" : "FAIL"} ${oldList[0] ? new Date(oldList[0][0] * 1000).toISOString() : ""}`);

    // 4. Free trade list (informational: R2 says history beyond 24 h / 300 trades is paid).
    try {
      const tr = await get(`${GT}/networks/solana/pools/${top.attributes.address}/trades?trade_volume_in_usd_greater_than=100`);
      const d = tr?.data ?? [];
      const span = d.length ? (Date.parse(d[0].attributes.block_timestamp) - Date.parse(d.at(-1).attributes.block_timestamp)) / 60000 : 0;
      console.log(`4. free trades endpoint: ${d.length} trades over ${Math.round(span)} min (info only)`);
    } catch (e) { console.log(`4. free trades endpoint: ${e.message.slice(0, 80)} (info only)`); }

    // 5. Jupiter live quote for selling ~$500 of the token (optional exit check, R2).
    try {
      const price = Number(list[0][4]);
      const dec = (await get(`${GT}/networks/solana/tokens/${mint}`))?.data?.attributes?.decimals;
      const amount = BigInt(Math.floor((500 / price) * 10 ** dec));
      const q = await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${USDC}&amount=${amount}&slippageBps=100`)).json();
      console.log(`5. Jupiter sell ~$500: out ${Number(q.outAmount) / 1e6} USDC, price impact ${q.priceImpactPct}% (optional)`);
    } catch (e) { console.log(`5. Jupiter quote: ${String(e.message).slice(0, 80)} (optional)`); }

    if (hasCreated && list.length && oldList.length) anyPass = true;
  } catch (e) {
    console.log(`FAIL: ${String(e.message).slice(0, 160)}`);
  }
}
console.log(anyPass
  ? "\nGATE (d) PASS — pool selection, minute candles and 72 h history work. Note the gap behaviour above."
  : "\nGATE (d) FAIL — try DexScreener (pools) and Birdeye with a free key (candles), or demo on a fixed token list.");
