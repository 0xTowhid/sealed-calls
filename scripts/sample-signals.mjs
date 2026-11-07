// Builds a scorer input with a few live-market signals (wide ranges around current prices), for CI.
const hl = await (await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) })).json();
const gt = await (await fetch("https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")).json();
const bonk = Number(Object.values(gt.data.attributes.token_prices)[0]);
const btc = Number(hl.BTC), eth = Number(hl.ETH);
const now = Date.now(), H = 3600_000;
const f = (x) => x.toPrecision(6).replace(/\.?0+$/, "");
const sig = (id, venue, network, address, side, leverage, lo, hi, tps, sl, postedAgoH, validH) => ({
  id, venue, network, address, side, leverage, entry_low: f(lo), entry_high: f(hi), tps: tps.map(f), sl: f(sl),
  posted_at_ms: now - postedAgoH * H, valid_min: validH * 60,
});
const input = {
  signals: [
    sig(1, "hyperliquid", null, "BTC", "long", 5, btc * 0.97, btc * 1.03, [btc * 1.06, btc * 1.1], btc * 0.9, 6, 5),
    sig(2, "hyperliquid", null, "ETH", "short", 3, eth * 0.97, eth * 1.03, [eth * 0.94], eth * 1.12, 6, 5),
    sig(3, "gecko", "solana", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "long", 1, bonk * 0.9, bonk * 1.1, [bonk * 1.3], bonk * 0.7, 6, 5),
    sig(4, "hyperliquid", null, "BTC", "long", 2, btc * 0.9, btc * 1.1, [btc * 1.5], btc * 0.5, 5 * 24, 24),
    sig(5, "hyperliquid", null, "NOTACOIN", "long", 1, 1, 2, [3], 0.5, 6, 5),
    sig(6, "gecko", "solana", "DzXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "long", 1, 1, 2, [3], 0.5, 6, 5),
  ],
  reference_usd: 500,
  liquidity_floor_usd: 100000,
};
console.log(JSON.stringify(input));
