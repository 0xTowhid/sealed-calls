//! Pure scoring rules for Sealed Calls v2 signals (no network), unit-tested on any machine.
//! These implement the v2 rules in CLAUDE.md; change them only together with that file.
//!
//! A signal: market, long/short, leverage, entry range, 1–3 take-profits, stop loss, validity.
//! * Fill: the first candle close inside the entry range during validity. Never → "not_filled", 0%.
//! * After the fill, candle by candle: liquidation if the candle's low (long) / high (short) crosses
//!   the liquidation price ≈ fill·(1 ∓ 1/leverage); stop loss if the close crosses SL (exits at that
//!   close); take-profit i if the close crosses TP i (exits at TP i). TPs close equal parts.
//!   Anything still open exits at the last close of the validity window ("expired").
//! * Costs: Hyperliquid taker fee each side × leverage; DEX tokens pay pool fee + price impact of
//!   the reference trade each side. Result clipped to −100%…+300%.
//! * Micro-cap signals (venue "gecko_micro"): pools from $10k liquidity; a take-profit needs two
//!   consecutive closes beyond it; at expiry the open part exits at the median close of the last
//!   30 minutes (or the lowest close if fewer than 10 traded), so one pumped candle doesn't count.
//! * Candle size: the finest the source still has for the window (1-minute when the signal is
//!   recent; otherwise 5- or 15-minute, or 1-hour). The size used is reported.

use serde::{Deserialize, Serialize};

pub const LOSS_BPS: i32 = -10_000;
pub const MAX_GAIN_BPS: i32 = 30_000;
/// Hyperliquid base-tier taker fee.
pub const HL_TAKER_FEE: f64 = 0.00045;
/// Used when a DEX pool reports no fee.
pub const DEFAULT_POOL_FEE: f64 = 0.0025;
/// Hyperliquid serves at most this many of the most recent candles per interval.
pub const HL_MAX_CANDLES: u64 = 5_000;
/// Pages of 1000 candles we are willing to fetch from GeckoTerminal for one signal.
pub const GT_MAX_CANDLES: u64 = 3_000;
/// Quote assets a DEX pool must be paired with to count (wrapped natives and stablecoins).
pub const MAJORS: &[&str] = &[
    "SOL", "WSOL", "USDC", "USDT", "ETH", "WETH", "BNB", "WBNB", "BTC", "WBTC", "CBBTC", "AVAX", "WAVAX", "POL", "WPOL", "MATIC",
    "WMATIC", "ARB", "S", "WS", "SUI", "TON", "TRX", "USDE", "DAI", "USDC.E", "USDBC", "FDUSD", "PYUSD", "USDG",
];

#[derive(Deserialize, Debug, Clone)]
pub struct SignalIn {
    pub id: u64,
    pub venue: String,
    #[serde(default)]
    pub network: Option<String>,
    pub address: String,
    pub side: String,
    pub leverage: u32,
    pub entry_low: String,
    pub entry_high: String,
    pub tps: Vec<String>,
    pub sl: String,
    pub posted_at_ms: u64,
    pub valid_min: u32,
}

#[derive(Deserialize, Debug)]
pub struct JobIn {
    pub signals: Vec<SignalIn>,
    #[serde(default = "default_ref")]
    pub reference_usd: f64,
    #[serde(default = "default_floor")]
    pub liquidity_floor_usd: f64,
}
fn default_ref() -> f64 {
    500.0
}
fn default_floor() -> f64 {
    100_000.0
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SignalScore {
    pub id: u64,
    pub r_bps: i32,
    /// e.g. "tp2", "tp1+sl", "sl", "liquidated", "expired", "not_filled", "below_floor" — with the
    /// candle size appended when it is not 1 minute, e.g. "tp1 (15m)".
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill_price: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_price: Option<String>,
    /// Estimated round-trip cost, in basis points of the (leveraged) position.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_bps: Option<i32>,
}

#[derive(Serialize, Debug)]
pub struct JobOut {
    pub ok: bool,
    pub results: Vec<SignalScore>,
    pub error: Option<String>,
    /// Signals that could not be scored this time (source down, time budget); retried later.
    pub failed: Vec<u64>,
}

/// Quote tokens by address on the networks where we know them: a token merely *named* "USDC" or
/// "SOL" doesn't count there. Other networks fall back to the symbol list.
pub const MAJOR_ADDRESSES: &[(&str, &[&str])] = &[
    ("solana", &[
        "So11111111111111111111111111111111111111112", // wSOL
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    ]),
    ("eth", &[
        "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
        "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
        "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
        "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
        "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
    ]),
    ("base", &[
        "0x4200000000000000000000000000000000000006", // WETH
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
        "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", // cbBTC
    ]),
    ("bsc", &[
        "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
        "0x55d398326f99059ff775485246999027b3197955", // USDT
        "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
    ]),
    ("arbitrum", &[
        "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
        "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC
    ]),
];

/// Is `addr` / `symbol` an accepted quote token on `network`?
pub fn is_major(network: &str, addr: &str, symbol: &str) -> bool {
    match MAJOR_ADDRESSES.iter().find(|(n, _)| *n == network) {
        Some((_, list)) => list.iter().any(|a| a.eq_ignore_ascii_case(addr)),
        None => MAJORS.contains(&symbol),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pool {
    pub address: String,
    pub liquidity_usd: f64,
    pub created_at_s: Option<u64>,
    pub fee: Option<f64>,
}

/// One candle: start time (s), high, low, close (USD).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Candle {
    pub t: u64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
}

/// A parsed, checked signal.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub long: bool,
    pub leverage: f64,
    pub lo: f64,
    pub hi: f64,
    pub tps: Vec<f64>,
    pub sl: f64,
}

pub fn plan_of(s: &SignalIn) -> Option<Plan> {
    let p = |x: &str| x.parse::<f64>().ok().filter(|v| v.is_finite() && *v > 0.0);
    Some(Plan {
        long: match s.side.as_str() {
            "long" => true,
            "short" => false,
            _ => return None,
        },
        leverage: s.leverage.max(1) as f64,
        lo: p(&s.entry_low)?,
        hi: p(&s.entry_high)?,
        tps: s.tps.iter().map(|t| p(t)).collect::<Option<Vec<_>>>()?,
        sl: p(&s.sl)?,
    })
}

/// Candle sizes (seconds) to try, finest first.
pub const HL_INTERVALS: &[(u64, &str)] = &[(60, "1m"), (300, "5m"), (900, "15m"), (3600, "1h")];
pub const GT_INTERVALS: &[(u64, &str, u32)] = &[(60, "minute", 1), (300, "minute", 5), (900, "minute", 15), (3600, "hour", 1)];

/// Finest Hyperliquid interval that still covers `start_s` (it keeps only the newest 5000 candles).
pub fn hl_interval(now_s: u64, start_s: u64) -> (u64, &'static str) {
    let age = now_s.saturating_sub(start_s) + 120;
    *HL_INTERVALS.iter().find(|(sec, _)| age / sec < HL_MAX_CANDLES).unwrap_or(&HL_INTERVALS[3])
}

/// Finest GeckoTerminal interval that covers the window in at most GT_MAX_CANDLES candles.
pub fn gt_interval(start_s: u64, end_s: u64) -> (u64, &'static str, u32) {
    let len = end_s.saturating_sub(start_s);
    *GT_INTERVALS.iter().find(|(sec, _, _)| len / sec <= GT_MAX_CANDLES).unwrap_or(&GT_INTERVALS[3])
}

/// Candles that start at or after the post and end by the end of validity, oldest first.
pub fn window(candles: &[Candle], posted_s: u64, end_s: u64, interval_s: u64) -> Vec<Candle> {
    let mut w: Vec<Candle> = candles
        .iter()
        .filter(|c| c.t >= posted_s && c.t + interval_s <= end_s && c.close > 0.0)
        .copied()
        .collect();
    w.sort_by_key(|c| c.t);
    w.dedup_by_key(|c| c.t);
    w
}

/// Result of walking a signal through its candles, before costs.
#[derive(Debug, Clone, PartialEq)]
pub struct Walk {
    pub fill: Option<f64>,
    /// Exit price of each part (equal parts, one per TP); f64::NAN for a liquidated part.
    pub exits: Vec<f64>,
    pub outcome: String,
}

/// Extra rules for micro-cap signals (thin pools that a caller could push cheaply).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rules {
    /// A take-profit needs this many consecutive closes beyond it (1 normally, 2 for micro-caps).
    pub tp_confirm: usize,
    /// At expiry, exit at the median close of the last 30 minutes (≥ 10 trading candles), else the
    /// lowest close in them — so a last-minute pump doesn't count.
    pub median_exit: bool,
}
pub const NORMAL: Rules = Rules { tp_confirm: 1, median_exit: false };
pub const MICRO: Rules = Rules { tp_confirm: 2, median_exit: true };
/// Liquidity floor for micro-cap signals (normal DEX signals use the contract's floor).
pub const MICRO_FLOOR_USD: f64 = 10_000.0;

/// The exit at expiry for the open part: last close, or the micro-cap median rule.
pub fn expiry_exit(w: &[Candle], median: bool) -> f64 {
    let last = w.last().unwrap();
    if !median {
        return last.close;
    }
    let from = last.t.saturating_sub(1800);
    let mut tail: Vec<f64> = w.iter().filter(|c| c.t >= from).map(|c| c.close).collect();
    tail.sort_by(|a, b| a.total_cmp(b));
    if tail.len() >= 10 {
        let n = tail.len();
        if n % 2 == 1 { tail[n / 2] } else { (tail[n / 2 - 1] + tail[n / 2]) / 2.0 }
    } else {
        tail.first().copied().unwrap_or(last.close)
    }
}

pub fn walk(p: &Plan, w: &[Candle]) -> Walk {
    walk_with(p, w, NORMAL)
}

pub fn walk_with(p: &Plan, w: &[Candle], rules: Rules) -> Walk {
    let Some(fi) = w.iter().position(|c| c.close >= p.lo && c.close <= p.hi) else {
        return Walk { fill: None, exits: vec![], outcome: "not_filled".into() };
    };
    let fill = w[fi].close;
    let parts = p.tps.len().max(1);
    let liq = if p.long { fill * (1.0 - 1.0 / p.leverage) } else { fill * (1.0 + 1.0 / p.leverage) };
    let mut exits: Vec<f64> = vec![];
    let mut tps_hit = 0usize;
    let mut streak = 0usize; // consecutive closes beyond the next take-profit
    for c in &w[fi + 1..] {
        let liquidated = if p.long { p.leverage > 1.0 && c.low <= liq } else { c.high >= liq };
        if liquidated {
            exits.resize(parts, f64::NAN);
            let outcome = if tps_hit > 0 { format!("tp{tps_hit}+liquidated") } else { "liquidated".into() };
            return Walk { fill: Some(fill), exits, outcome };
        }
        let stopped = if p.long { c.close <= p.sl } else { c.close >= p.sl };
        if stopped {
            exits.resize(parts, c.close);
            let outcome = if tps_hit > 0 { format!("tp{tps_hit}+sl") } else { "sl".into() };
            return Walk { fill: Some(fill), exits, outcome };
        }
        let beyond = |tp: f64| if p.long { c.close >= tp } else { c.close <= tp };
        if tps_hit < p.tps.len() && beyond(p.tps[tps_hit]) {
            streak += 1;
        } else {
            streak = 0;
        }
        if streak >= rules.tp_confirm {
            while tps_hit < p.tps.len() && beyond(p.tps[tps_hit]) {
                exits.push(p.tps[tps_hit]);
                tps_hit += 1;
            }
            streak = 0;
        }
        if tps_hit == p.tps.len() {
            return Walk { fill: Some(fill), exits, outcome: format!("tp{tps_hit}") };
        }
    }
    let last = expiry_exit(w, rules.median_exit);
    exits.resize(parts, last);
    let outcome = if tps_hit > 0 { format!("tp{tps_hit}+expired") } else { "expired".into() };
    Walk { fill: Some(fill), exits, outcome }
}

/// Net result (fraction) of one part: leveraged move minus round-trip cost; a liquidated part is −1.
pub fn part_return(long: bool, leverage: f64, fill: f64, exit: f64, c_in: f64, c_out: f64) -> f64 {
    if exit.is_nan() {
        return -1.0;
    }
    let gross = if long { exit / fill - 1.0 } else { 1.0 - exit / fill };
    (leverage * gross - leverage * (c_in + c_out)).max(-1.0)
}

pub fn to_bps(r: f64) -> i32 {
    ((r * 10_000.0).round() as i64).clamp(LOSS_BPS as i64, MAX_GAIN_BPS as i64) as i32
}

/// Scores a walked signal given per-side costs (as fractions of notional).
pub fn finish(id: u64, p: &Plan, w: &Walk, c_in: f64, c_out: f64, interval_s: u64) -> SignalScore {
    let tag = |o: &str| if interval_s == 60 { o.to_string() } else { format!("{o} ({})", label(interval_s)) };
    let Some(fill) = w.fill else {
        return SignalScore { id, r_bps: 0, outcome: tag(&w.outcome), fill_price: None, exit_price: None, cost_bps: None };
    };
    let rs: Vec<f64> = w.exits.iter().map(|x| part_return(p.long, p.leverage, fill, *x, c_in, c_out)).collect();
    let r = rs.iter().sum::<f64>() / rs.len() as f64;
    let live: Vec<f64> = w.exits.iter().copied().filter(|x| !x.is_nan()).collect();
    let avg_exit = if live.is_empty() { None } else { Some(sig6(live.iter().sum::<f64>() / live.len() as f64)) };
    SignalScore {
        id,
        r_bps: to_bps(r),
        outcome: tag(&w.outcome),
        fill_price: Some(sig6(fill)),
        exit_price: avg_exit,
        cost_bps: Some(((c_in + c_out) * p.leverage * 10_000.0).round() as i32),
    }
}

pub fn label(interval_s: u64) -> &'static str {
    match interval_s {
        60 => "1m",
        300 => "5m",
        900 => "15m",
        _ => "1h",
    }
}

pub fn lose(id: u64, outcome: &str) -> SignalScore {
    SignalScore { id, r_bps: LOSS_BPS, outcome: outcome.into(), fill_price: None, exit_price: None, cost_bps: None }
}

/// Cost of a `ref_usd` trade on one side of a DEX pool: fee + constant-product price impact.
pub fn dex_side_cost(pool: &Pool, ref_usd: f64) -> f64 {
    let fee = pool.fee.unwrap_or(DEFAULT_POOL_FEE);
    (fee + ref_usd / (0.5 * pool.liquidity_usd.max(1.0))).min(0.99)
}

/// The candle pool must itself clear the floor (not some other, newer pool); returns its
/// per-side cost for the reference trade.
pub fn dex_check(pool: &Pool, floor_usd: f64) -> Result<(), &'static str> {
    if pool.liquidity_usd < floor_usd { Err("below_floor") } else { Ok(()) }
}

/// Deepest pool that existed at `at_s` (or now, for None).
pub fn pick_pool(pools: &[Pool], at_s: Option<u64>) -> Option<&Pool> {
    pools
        .iter()
        .filter(|p| match (at_s, p.created_at_s) {
            (Some(t), Some(c)) => c < t,
            (Some(_), None) => false,
            (None, _) => true,
        })
        .max_by(|a, b| a.liquidity_usd.total_cmp(&b.liquidity_usd))
}

/// A price with six significant digits, as a plain decimal string (no exponent).
pub fn sig6(x: f64) -> String {
    if !(x.is_finite() && x > 0.0) {
        return "0".into();
    }
    let decimals = (5 - x.log10().floor() as i32).clamp(0, 18) as usize;
    format!("{x:.decimals$}")
}

// ------------------------------------------------------------------ parsers

/// GeckoTerminal `/networks/{n}/tokens/{t}/pools?include=base_token,quote_token`: pools where the
/// other side is a major (wrapped native or stablecoin).
pub fn parse_pools(v: &serde_json::Value, token: &str) -> Vec<Pool> {
    parse_pools_on(v, token, "")
}

/// As `parse_pools`, checking quote tokens by address on `network` when it is a known network.
pub fn parse_pools_on(v: &serde_json::Value, token: &str, network: &str) -> Vec<Pool> {
    let included = v["included"].as_array().map(|a| a.as_slice()).unwrap_or(&[]);
    let symbol_of = |id: &str| -> String {
        included
            .iter()
            .find(|t| t["id"].as_str() == Some(id))
            .and_then(|t| t["attributes"]["symbol"].as_str())
            .unwrap_or("")
            .to_uppercase()
    };
    let addr_of = |id: &str| id.split_once('_').map(|(_, a)| a.to_string()).unwrap_or_default();
    v["data"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter(|p| {
            let b = p["relationships"]["base_token"]["data"]["id"].as_str().unwrap_or("");
            let q = p["relationships"]["quote_token"]["data"]["id"].as_str().unwrap_or("");
            let other = if addr_of(b).eq_ignore_ascii_case(token) { q } else if addr_of(q).eq_ignore_ascii_case(token) { b } else { return false };
            is_major(network, &addr_of(other), symbol_of(other).as_str())
        })
        .filter_map(|p| {
            let a = &p["attributes"];
            Some(Pool {
                address: a["address"].as_str()?.to_string(),
                liquidity_usd: a["reserve_in_usd"].as_str().and_then(|s| s.parse().ok()).or(a["reserve_in_usd"].as_f64()).unwrap_or(0.0),
                created_at_s: a["pool_created_at"].as_str().and_then(parse_iso8601_s),
                fee: a["pool_fee_percentage"].as_str().and_then(|s| s.parse::<f64>().ok()).map(|pct| pct / 100.0),
            })
        })
        .collect()
}

fn num(x: &serde_json::Value) -> Option<f64> {
    x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok()))
}

/// GeckoTerminal OHLCV `ohlcv_list`: [[t, o, h, l, c, v], ...]. Minutes without trades are omitted.
pub fn parse_gt_candles(v: &serde_json::Value) -> Vec<Candle> {
    v["data"]["attributes"]["ohlcv_list"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter_map(|c| Some(Candle { t: num(&c[0])? as u64, high: num(&c[2])?, low: num(&c[3])?, close: num(&c[4])? }))
        .collect()
}

/// Hyperliquid `candleSnapshot`: [{"t": ms, "h": "..", "l": "..", "c": "..", ...}, ...].
pub fn parse_hl_candles(v: &serde_json::Value) -> Vec<Candle> {
    v.as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter_map(|c| Some(Candle { t: num(&c["t"])? as u64 / 1000, high: num(&c["h"])?, low: num(&c["l"])?, close: num(&c["c"])? }))
        .collect()
}

/// "2024-01-05T12:34:56Z" (optionally with fraction or +00:00) -> unix seconds.
pub fn parse_iso8601_s(s: &str) -> Option<u64> {
    if s.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + h * 3600 + mi * 60 + se).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(t: u64, close: f64) -> Candle {
        Candle { t, high: close, low: close, close }
    }
    fn cw(t: u64, low: f64, high: f64, close: f64) -> Candle {
        Candle { t, high, low, close }
    }
    fn long(lev: f64, lo: f64, hi: f64, tps: &[f64], sl: f64) -> Plan {
        Plan { long: true, leverage: lev, lo, hi, tps: tps.to_vec(), sl }
    }
    fn short(lev: f64, lo: f64, hi: f64, tps: &[f64], sl: f64) -> Plan {
        Plan { long: false, leverage: lev, lo, hi, tps: tps.to_vec(), sl }
    }
    fn series(closes: &[f64]) -> Vec<Candle> {
        closes.iter().enumerate().map(|(i, x)| c(1000 + i as u64 * 60, *x)).collect()
    }

    #[test]
    fn fills_only_inside_the_range_at_any_time() {
        let p = long(1.0, 100.0, 101.0, &[110.0], 95.0);
        // price sits above the range for a while, then dips in
        let w = walk(&p, &series(&[105.0, 104.0, 103.0, 100.5, 104.0, 111.0]));
        assert_eq!(w.fill, Some(100.5));
        assert_eq!(w.outcome, "tp1");
        assert_eq!(w.exits, vec![110.0]);
        let w = walk(&p, &series(&[105.0, 106.0, 120.0]));
        assert_eq!((w.fill, w.outcome.as_str()), (None, "not_filled"));
    }

    #[test]
    fn take_profits_close_equal_parts_and_sl_closes_the_rest() {
        let p = long(1.0, 100.0, 100.0, &[110.0, 120.0, 130.0], 90.0);
        let w = walk(&p, &series(&[100.0, 111.0, 105.0, 89.0]));
        assert_eq!(w.outcome, "tp1+sl");
        assert_eq!(w.exits, vec![110.0, 89.0, 89.0]);
        let s = finish(1, &p, &w, 0.0, 0.0, 60);
        // (+10% − 11% − 11%) / 3 = −4%
        assert_eq!(s.r_bps, -400);
        // two TPs in one candle
        let w = walk(&p, &series(&[100.0, 125.0, 131.0]));
        assert_eq!(w.outcome, "tp3");
        assert_eq!(w.exits, vec![110.0, 120.0, 130.0]);
    }

    #[test]
    fn tps_and_sl_use_closes_not_wicks() {
        let p = long(1.0, 100.0, 100.0, &[110.0], 90.0);
        let w = walk(&p, &[c(0, 100.0), cw(60, 85.0, 115.0, 100.0), c(120, 102.0)]);
        assert_eq!(w.outcome, "expired");
        assert_eq!(w.exits, vec![102.0]);
    }

    #[test]
    fn leverage_multiplies_and_liquidation_uses_wicks() {
        let p = long(10.0, 100.0, 100.0, &[104.0], 95.0);
        let w = walk(&p, &series(&[100.0, 104.5]));
        let s = finish(1, &p, &w, HL_TAKER_FEE, HL_TAKER_FEE, 60);
        // 10 × 4% − 10 × 0.09% = 39.1%
        assert_eq!(s.r_bps, 3_910);
        // a wick to 89.9 liquidates a 10x long (liq ≈ 90) even though the close is 99
        let w = walk(&p, &[c(0, 100.0), cw(60, 89.9, 100.0, 99.0)]);
        assert_eq!(w.outcome, "liquidated");
        assert_eq!(finish(1, &p, &w, 0.0, 0.0, 60).r_bps, LOSS_BPS);
        // 1x long cannot be liquidated
        let p1 = long(1.0, 100.0, 100.0, &[150.0], 1.0);
        assert_eq!(walk(&p1, &[c(0, 100.0), cw(60, 2.0, 100.0, 50.0)]).outcome, "expired");
    }

    #[test]
    fn shorts_mirror_longs() {
        let p = short(5.0, 100.0, 101.0, &[95.0, 90.0], 106.0);
        let w = walk(&p, &series(&[100.5, 96.0, 94.0, 89.0]));
        assert_eq!(w.outcome, "tp2");
        let s = finish(1, &p, &w, 0.0, 0.0, 60);
        // parts: 5 × (1 − 95/100.5) and 5 × (1 − 90/100.5), averaged
        let want = 5.0 * ((1.0 - 95.0 / 100.5) + (1.0 - 90.0 / 100.5)) / 2.0;
        assert_eq!(s.r_bps, to_bps(want));
        // short liquidation on a wick up (5x: liq ≈ 120.6)
        assert_eq!(walk(&p, &[c(0, 100.5), cw(60, 100.0, 121.0, 102.0)]).outcome, "liquidated");
        // short SL on close
        assert_eq!(walk(&p, &series(&[100.5, 107.0])).outcome, "sl");
    }

    #[test]
    fn not_filled_scores_zero_and_results_are_clipped() {
        let p = long(50.0, 100.0, 100.0, &[200.0], 99.0);
        assert_eq!(finish(1, &p, &walk(&p, &series(&[105.0])), 0.0, 0.0, 60).r_bps, 0);
        let w = walk(&p, &series(&[100.0, 200.0]));
        assert_eq!(finish(1, &p, &w, 0.0, 0.0, 60).r_bps, MAX_GAIN_BPS);
    }

    #[test]
    fn coarse_candles_are_labelled() {
        let p = long(1.0, 100.0, 100.0, &[110.0], 90.0);
        let s = finish(1, &p, &walk(&p, &series(&[100.0, 110.0])), 0.0, 0.0, 900);
        assert_eq!(s.outcome, "tp1 (15m)");
    }

    #[test]
    fn interval_choice() {
        let now = 10_000_000;
        assert_eq!(hl_interval(now, now - 3600).1, "1m");
        assert_eq!(hl_interval(now, now - 4 * 86_400).1, "5m");
        assert_eq!(hl_interval(now, now - 30 * 86_400).1, "15m");
        assert_eq!(hl_interval(now, now - 60 * 86_400).1, "1h");
        assert_eq!(gt_interval(0, 2 * 86_400).2, 1);
        assert_eq!(gt_interval(0, 7 * 86_400).2, 5);
        assert_eq!(gt_interval(0, 30 * 86_400).2, 15);
    }

    #[test]
    fn window_keeps_complete_candles_inside_validity() {
        let w = window(&[c(90, 1.0), c(120, 2.0), c(180, 3.0), c(240, 4.0)], 100, 240, 60);
        assert_eq!(w.iter().map(|c| c.t).collect::<Vec<_>>(), vec![120, 180]);
    }

    #[test]
    fn quote_tokens_by_address_on_known_networks() {
        // a fake "USDC" on Solana doesn't count; the real mint does
        assert!(!is_major("solana", "FakeUsdcMint111", "USDC"));
        assert!(is_major("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"));
        assert!(is_major("base", "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913", "USDC"));
        // unknown networks: by symbol
        assert!(is_major("robinhood", "0xabc", "USDG"));
        let v = serde_json::json!({
            "data": [
                { "attributes": { "address": "P1", "reserve_in_usd": "250000" },
                  "relationships": { "base_token": { "data": { "id": "solana_MINT" } }, "quote_token": { "data": { "id": "solana_FAKE" } } } },
                { "attributes": { "address": "P2", "reserve_in_usd": "150000" },
                  "relationships": { "base_token": { "data": { "id": "solana_MINT" } }, "quote_token": { "data": { "id": "solana_So11111111111111111111111111111111111111112" } } } }
            ],
            "included": [
                { "id": "solana_FAKE", "attributes": { "symbol": "USDC" } },
                { "id": "solana_So11111111111111111111111111111111111111112", "attributes": { "symbol": "SOL" } }
            ]
        });
        let p = parse_pools_on(&v, "MINT", "solana");
        assert_eq!(p.iter().map(|p| p.address.as_str()).collect::<Vec<_>>(), vec!["P2"]);
    }

    #[test]
    fn floor_and_costs_use_the_pool_the_candles_come_from() {
        // old thin pool (existed at the post) + a new deep pool: the candles' pool is below the floor
        let pools = vec![
            Pool { address: "old".into(), liquidity_usd: 20_000.0, created_at_s: Some(100), fee: None },
            Pool { address: "new".into(), liquidity_usd: 900_000.0, created_at_s: Some(5_000), fee: None },
        ];
        let p = pick_pool(&pools, Some(1_000)).unwrap();
        assert_eq!(p.address, "old");
        assert_eq!(dex_check(p, 100_000.0), Err("below_floor"));
        assert!(dex_check(&pools[1], 100_000.0).is_ok());
    }

    #[test]
    fn dex_costs() {
        let p = Pool { address: "p".into(), liquidity_usd: 200_000.0, created_at_s: None, fee: Some(0.0025) };
        assert!((dex_side_cost(&p, 500.0) - 0.0075).abs() < 1e-12);
    }

    #[test]
    fn parses_sources() {
        let v = serde_json::json!({
            "data": [
                { "attributes": { "address": "P1", "reserve_in_usd": "250000.5", "pool_created_at": "2024-01-05T12:34:56Z", "pool_fee_percentage": "0.25" },
                  "relationships": { "base_token": { "data": { "id": "solana_MINT" } }, "quote_token": { "data": { "id": "solana_So111" } } } },
                { "attributes": { "address": "P2", "reserve_in_usd": "999999" },
                  "relationships": { "base_token": { "data": { "id": "solana_MINT" } }, "quote_token": { "data": { "id": "solana_JUNK" } } } }
            ],
            "included": [
                { "id": "solana_So111", "attributes": { "symbol": "SOL" } },
                { "id": "solana_JUNK", "attributes": { "symbol": "JUNK" } },
                { "id": "solana_MINT", "attributes": { "symbol": "BONK" } }
            ]
        });
        let p = parse_pools(&v, "MINT");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].created_at_s, Some(1_704_458_096));
        assert_eq!(p[0].fee, Some(0.0025));
        let g = serde_json::json!({ "data": { "attributes": { "ohlcv_list": [[1_704_458_100u64, 1, 2, 0.5, "1.5", 20]] } } });
        assert_eq!(parse_gt_candles(&g), vec![Candle { t: 1_704_458_100, high: 2.0, low: 0.5, close: 1.5 }]);
        let h = serde_json::json!([{ "t": 1_704_458_100_000u64, "T": 1, "o": "1", "h": "2", "l": "0.5", "c": "1.5", "v": "9", "n": 3 }]);
        assert_eq!(parse_hl_candles(&h), vec![Candle { t: 1_704_458_100, high: 2.0, low: 0.5, close: 1.5 }]);
    }

    #[test]
    fn micro_caps_need_two_closes_for_a_tp_and_exit_on_the_median() {
        let p = long(1.0, 100.0, 100.0, &[150.0], 50.0);
        // one pumped close above the TP doesn't count for a micro-cap…
        let spike = series(&[100.0, 160.0, 101.0, 102.0]);
        assert_eq!(walk_with(&p, &spike, MICRO).outcome, "expired");
        assert_eq!(walk(&p, &spike).outcome, "tp1");
        // …two in a row do
        assert_eq!(walk_with(&p, &series(&[100.0, 155.0, 152.0]), MICRO).outcome, "tp1");
        // expiry: a last-minute pump is ignored (median of the last 30 minutes)
        let mut closes = vec![100.0; 20];
        closes.push(140.0);
        let w = walk_with(&p, &series(&closes), MICRO);
        assert_eq!(w.exits, vec![100.0]);
        // fewer than 10 trading candles in the last 30 minutes → the lowest close
        assert_eq!(expiry_exit(&series(&[100.0, 120.0, 90.0, 130.0]), true), 90.0);
    }

    #[test]
    fn prices_print_six_significant_digits() {
        assert_eq!(sig6(0.000002787327212378393), "0.00000278733");
        assert_eq!(sig6(64012.5), "64012.5");
    }
}
