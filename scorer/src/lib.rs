//! Pure scoring rules (no network), so they can be unit-tested on any machine.
//! These implement the locked MVP rules in CLAUDE.md; change them only together with that file.

use serde::{Deserialize, Serialize};

pub const SOL: &str = "So11111111111111111111111111111111111111112";
pub const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
pub const LOSS_BPS: i32 = -10_000;
pub const MAX_GAIN_BPS: i32 = 30_000;
pub const ENTRY_WINDOW_S: u64 = 15 * 60;
pub const EXIT_WINDOW_S: u64 = 30 * 60;
pub const MIN_ACTIVE_EXIT_MINUTES: usize = 10;
/// Used when the pool reports no fee.
pub const DEFAULT_POOL_FEE: f64 = 0.0025;

#[derive(Deserialize, Debug, Clone)]
pub struct CallIn {
    pub id: u64,
    pub mint: String,
    pub posted_at_ms: u64,
    pub horizon_min: u32,
}

#[derive(Deserialize, Debug)]
pub struct JobIn {
    pub calls: Vec<CallIn>,
    #[serde(default = "default_ref")]
    pub reference_usd: f64,
    #[serde(default = "default_floor")]
    pub liquidity_floor_usd: f64,
}
fn default_ref() -> f64 { 500.0 }
fn default_floor() -> f64 { 100_000.0 }

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct CallScore {
    pub id: u64,
    pub r_bps: i32,
    pub note: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_usd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_usd: Option<String>,
    /// Estimated round-trip cost of the $500 trade, in basis points.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_bps: Option<i32>,
}

#[derive(Serialize, Debug)]
pub struct JobOut {
    pub ok: bool,
    pub results: Vec<CallScore>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pool {
    pub address: String,
    pub liquidity_usd: f64,
    pub created_at_s: Option<u64>,
    pub fee: Option<f64>,
}

/// One 1-minute candle: start time (s), close (USD), volume (USD).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Candle {
    pub t: u64,
    pub close: f64,
    pub volume: f64,
}

/// Rule 1: among pools paired with SOL/USDC, the deepest one that existed at `at_s`.
/// `None` for `at_s` means "deepest now" (exit pool, follows migrations).
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

/// Rule 3: close of the first traded minute that starts after the post, within 15 minutes.
pub fn entry_price(candles: &[Candle], posted_s: u64) -> Option<f64> {
    let first_start = posted_s.div_ceil(60) * 60 + if posted_s % 60 == 0 { 60 } else { 0 };
    let mut c: Vec<&Candle> = candles
        .iter()
        .filter(|c| c.t >= first_start && c.t < posted_s + ENTRY_WINDOW_S && c.volume > 0.0 && c.close > 0.0)
        .collect();
    c.sort_by_key(|c| c.t);
    c.first().map(|c| c.close)
}

/// Rule 5: median close of traded minutes in the last 30 minutes before `end_s`; with fewer than
/// 10 traded minutes, the lowest close in the window (thin activity can only hurt the caller).
pub fn exit_price(candles: &[Candle], end_s: u64) -> Option<(f64, &'static str)> {
    let window: Vec<&Candle> = candles.iter().filter(|c| c.t >= end_s.saturating_sub(EXIT_WINDOW_S) && c.t < end_s && c.close > 0.0).collect();
    let mut active: Vec<f64> = window.iter().filter(|c| c.volume > 0.0).map(|c| c.close).collect();
    if active.len() >= MIN_ACTIVE_EXIT_MINUTES {
        active.sort_by(f64::total_cmp);
        let n = active.len();
        let m = if n % 2 == 1 { active[n / 2] } else { (active[n / 2 - 1] + active[n / 2]) / 2.0 };
        return Some((m, "median"));
    }
    window.iter().map(|c| c.close).min_by(f64::total_cmp).map(|p| (p, "thin_exit_lowest"))
}

/// Rule 6: cost of a `ref_usd` trade on one side: pool fee + constant-product price impact.
pub fn side_cost(pool: &Pool, ref_usd: f64) -> f64 {
    let fee = pool.fee.unwrap_or(DEFAULT_POOL_FEE);
    let impact = ref_usd / (0.5 * pool.liquidity_usd.max(1.0));
    (fee + impact).min(0.99)
}

/// Rule 8: r = clip(P_exit·(1−c_out) / (P_entry·(1+c_in)) − 1, −100%, +300%) in basis points.
pub fn net_return_bps(entry: f64, exit: f64, c_in: f64, c_out: f64) -> i32 {
    let r = exit * (1.0 - c_out) / (entry * (1.0 + c_in)) - 1.0;
    ((r * 10_000.0).round() as i64).clamp(LOSS_BPS as i64, MAX_GAIN_BPS as i64) as i32
}

/// The whole rule set for one call, given data already fetched.
pub struct Fetched<'a> {
    pub pools: &'a [Pool],
    pub entry_candles: &'a [Candle],
    pub exit_candles: &'a [Candle],
}

pub fn score_call(call: &CallIn, d: &Fetched, ref_usd: f64, floor_usd: f64) -> CallScore {
    let posted_s = call.posted_at_ms / 1000;
    let end_s = (call.posted_at_ms + call.horizon_min as u64 * 60_000) / 1000;
    let lose = |note: &str| CallScore { id: call.id, r_bps: LOSS_BPS, note: note.into(), entry_usd: None, exit_usd: None, cost_bps: None };

    let Some(exit_pool) = pick_pool(d.pools, None) else { return lose("no_sol_usdc_pool") };
    if exit_pool.liquidity_usd < floor_usd {
        return lose("below_floor");
    }
    let Some(entry_pool) = pick_pool(d.pools, Some(posted_s)) else { return lose("no_pool_at_post") };
    let Some(entry) = entry_price(d.entry_candles, posted_s) else { return lose("no_entry_trade") };
    let Some((exit, how)) = exit_price(d.exit_candles, end_s) else { return lose("no_exit_trades") };
    let (c_in, c_out) = (side_cost(entry_pool, ref_usd), side_cost(exit_pool, ref_usd));
    let r = net_return_bps(entry, exit, c_in, c_out);
    CallScore {
        id: call.id,
        r_bps: r,
        note: how.into(),
        entry_usd: Some(sig6(entry)),
        exit_usd: Some(sig6(exit)),
        cost_bps: Some(((c_in + c_out) * 10_000.0).round() as i32),
    }
}

/// A price with six significant digits, as a plain decimal string (no exponent).
pub fn sig6(x: f64) -> String {
    if !(x.is_finite() && x > 0.0) {
        return "0".into();
    }
    let decimals = (5 - x.log10().floor() as i32).clamp(0, 18) as usize;
    format!("{x:.decimals$}")
}

/// Parses GeckoTerminal `/networks/solana/tokens/{mint}/pools` into eligible pools.
pub fn parse_pools(v: &serde_json::Value) -> Vec<Pool> {
    let id = |p: &serde_json::Value, rel: &str| p["relationships"][rel]["data"]["id"].as_str().unwrap_or("").trim_start_matches("solana_").to_string();
    v["data"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter(|p| {
            let (b, q) = (id(p, "base_token"), id(p, "quote_token"));
            [SOL, USDC].contains(&q.as_str()) || [SOL, USDC].contains(&b.as_str())
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

/// Parses GeckoTerminal OHLCV `ohlcv_list`: [[t, o, h, l, c, v], ...].
pub fn parse_candles(v: &serde_json::Value) -> Vec<Candle> {
    let num = |x: &serde_json::Value| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok()));
    v["data"]["attributes"]["ohlcv_list"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter_map(|c| Some(Candle { t: num(&c[0])? as u64, close: num(&c[4])?, volume: num(&c[5]).unwrap_or(0.0) }))
        .collect()
}

/// "2024-01-05T12:34:56Z" (optionally with fraction or +00:00) -> unix seconds.
pub fn parse_iso8601_s(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    // days from civil (Howard Hinnant)
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

    fn pool(addr: &str, liq: f64, created: Option<u64>) -> Pool {
        Pool { address: addr.into(), liquidity_usd: liq, created_at_s: created, fee: Some(0.0025) }
    }
    fn c(t: u64, close: f64, volume: f64) -> Candle {
        Candle { t, close, volume }
    }
    const P: u64 = 1_762_400_010; // posted 10 s into a minute

    #[test]
    fn pool_must_exist_before_the_post_for_entry_but_exit_follows_migration() {
        let pools = vec![pool("old", 200_000.0, Some(P - 1000)), pool("new", 900_000.0, Some(P + 600))];
        assert_eq!(pick_pool(&pools, Some(P)).unwrap().address, "old");
        assert_eq!(pick_pool(&pools, None).unwrap().address, "new");
        assert!(pick_pool(&[pool("x", 1.0, None)], Some(P)).is_none());
    }

    #[test]
    fn entry_is_first_traded_minute_after_post() {
        let start = 1_762_399_980; // minute containing P
        let candles = [c(start, 1.0, 100.0), c(start + 60, 0.0, 0.0), c(start + 120, 1.2, 50.0), c(start + 180, 1.5, 50.0)];
        // the minute containing the post is skipped; the empty minute is skipped
        assert_eq!(entry_price(&candles, P), Some(1.2));
        assert_eq!(entry_price(&[c(start, 1.0, 100.0)], P), None);
        // a post exactly on a minute boundary starts from the next minute
        assert_eq!(entry_price(&[c(start, 1.0, 1.0), c(start + 60, 2.0, 1.0)], start), Some(2.0));
    }

    #[test]
    fn entry_window_is_15_minutes() {
        let start = P.div_ceil(60) * 60;
        assert_eq!(entry_price(&[c(start + 15 * 60, 3.0, 1.0)], P), None);
        assert_eq!(entry_price(&[c(start + 14 * 60, 3.0, 1.0)], P), Some(3.0));
    }

    #[test]
    fn exit_median_needs_ten_active_minutes_else_lowest() {
        let end = 1_762_410_000;
        let busy: Vec<Candle> = (0..12).map(|i| c(end - 1800 + i * 60, 1.0 + i as f64, 10.0)).collect();
        let (p, how) = exit_price(&busy, end).unwrap();
        assert_eq!(how, "median");
        assert_eq!(p, 6.5);
        // a single pumped minute in a thin window cannot set the exit
        let thin = [c(end - 600, 2.0, 5.0), c(end - 60, 50.0, 5.0)];
        assert_eq!(exit_price(&thin, end).unwrap(), (2.0, "thin_exit_lowest"));
        // candles outside the window are ignored
        assert!(exit_price(&[c(end, 9.0, 1.0), c(end - 1801, 9.0, 1.0)], end).is_none());
    }

    #[test]
    fn returns_include_costs_and_are_clipped() {
        // +50% move, 0.25% fee + 0.5% impact each side at $200k
        let p = pool("p", 200_000.0, None);
        let cost = side_cost(&p, 500.0);
        assert!((cost - 0.0075).abs() < 1e-12);
        let r = net_return_bps(1.0, 1.5, cost, cost);
        // 1.5 × 0.9925 / 1.0075 − 1 = 47.77%: costs take about 2.2 points off a 50% move
        assert_eq!(r, 4_777);
        assert_eq!(net_return_bps(1.0, 10.0, 0.0, 0.0), MAX_GAIN_BPS);
        assert_eq!(net_return_bps(1.0, 0.0, 0.0, 0.0), LOSS_BPS);
    }

    #[test]
    fn score_call_rules() {
        let call = CallIn { id: 7, mint: "M".into(), posted_at_ms: P * 1000, horizon_min: 60 };
        let end = P + 3600;
        let pools = vec![pool("a", 300_000.0, Some(P - 86_400))];
        let entry = [c(P.div_ceil(60) * 60, 1.0, 10.0)];
        let exit: Vec<Candle> = (0..12).map(|i| c(end - 1800 + i * 60, 1.2, 10.0)).collect();
        let s = score_call(&call, &Fetched { pools: &pools, entry_candles: &entry, exit_candles: &exit }, 500.0, 100_000.0);
        assert_eq!(s.note, "median");
        assert!(s.r_bps > 1_500 && s.r_bps < 2_000, "{}", s.r_bps);

        let thin = vec![pool("a", 50_000.0, Some(P - 86_400))];
        let s = score_call(&call, &Fetched { pools: &thin, entry_candles: &entry, exit_candles: &exit }, 500.0, 100_000.0);
        assert_eq!((s.r_bps, s.note.as_str()), (LOSS_BPS, "below_floor"));

        let s = score_call(&call, &Fetched { pools: &pools, entry_candles: &[], exit_candles: &exit }, 500.0, 100_000.0);
        assert_eq!(s.note, "no_entry_trade");
    }

    #[test]
    fn parses_geckoterminal_shapes() {
        let pools = serde_json::json!({ "data": [
            { "attributes": { "address": "P1", "reserve_in_usd": "250000.5", "pool_created_at": "2024-01-05T12:34:56Z", "pool_fee_percentage": "0.25" },
              "relationships": { "base_token": { "data": { "id": "solana_MINT" } }, "quote_token": { "data": { "id": format!("solana_{SOL}") } } } },
            { "attributes": { "address": "P2", "reserve_in_usd": "999999" },
              "relationships": { "base_token": { "data": { "id": "solana_MINT" } }, "quote_token": { "data": { "id": "solana_OTHER" } } } }
        ]});
        let p = parse_pools(&pools);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].address, "P1");
        assert_eq!(p[0].created_at_s, Some(1_704_458_096));
        assert_eq!(p[0].fee, Some(0.0025));
        let o = serde_json::json!({ "data": { "attributes": { "ohlcv_list": [[1_704_458_100u64, 1, 1, 1, "1.5", 20]] } } });
        assert_eq!(parse_candles(&o), vec![c(1_704_458_100, 1.5, 20.0)]);
    }

    #[test]
    fn prices_print_six_significant_digits() {
        assert_eq!(sig6(0.000002787327212378393), "0.00000278733");
        assert_eq!(sig6(1.93212), "1.93212");
        assert_eq!(sig6(64012.5), "64012.5");
    }

    #[test]
    fn iso_dates() {
        assert_eq!(parse_iso8601_s("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601_s("2026-11-07T00:00:00.123Z"), Some(1_794_009_600));
        assert_eq!(parse_iso8601_s("nope"), None);
    }
}
