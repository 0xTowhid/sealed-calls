//! OutLayer entry point: reads JobIn JSON on stdin, fetches public price data (Hyperliquid or
//! GeckoTerminal), prints JobOut JSON. Data rules turn a bad market into a scored result; a
//! transport failure fails the whole job (ok:false) so the contract lets anyone retry `settle`
//! instead of settling on bad data.

use scorer::*;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use wasi_http_client::Client;

const GT: &str = "https://api.geckoterminal.com/api/v2/networks";
const HL: &str = "https://api.hyperliquid.xyz/info";

fn main() {
    let out = match run() {
        Ok((results, failed, error)) => JobOut { ok: true, results, error, failed },
        Err(e) => JobOut { ok: false, results: vec![], error: Some(e), failed: vec![] },
    };
    print!("{}", serde_json::to_string(&out).unwrap());
    io::stdout().flush().ok();
}

/// Stop starting new signals after this many seconds (OutLayer allows 180): the rest are reported
/// as failed and retried by the next request instead of failing the whole job.
const TIME_BUDGET_S: u64 = 120;

fn run() -> Result<(Vec<SignalScore>, Vec<u64>, Option<String>), String> {
    let started = std::time::Instant::now();
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let job: JobIn = serde_json::from_str(&raw).map_err(|e| format!("bad input: {e}"))?;
    let now_s = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    // Hyperliquid perp names, fetched once if any signal needs them.
    // (A failure to load it fails only the Hyperliquid signals.)
    let hl_coins: Result<Vec<String>, String> = if job.signals.iter().any(|s| s.venue == "hyperliquid") {
        post(HL, &json!({ "type": "meta" })).map(|v| {
            v["universe"].as_array().map(|u| u.iter().filter_map(|c| c["name"].as_str().map(String::from)).collect()).unwrap_or_default()
        })
    } else {
        Ok(vec![])
    };
    let (mut results, mut failed, mut first_err) = (vec![], vec![], None);
    for s in &job.signals {
        if started.elapsed().as_secs() > TIME_BUDGET_S {
            failed.push(s.id);
            first_err.get_or_insert_with(|| "time budget used up".to_string());
            continue;
        }
        let r = match (&hl_coins, s.venue.as_str()) {
            (Err(e), "hyperliquid") => Err(e.clone()),
            (coins, _) => score(s, now_s, job.reference_usd, job.liquidity_floor_usd, coins.as_deref().unwrap_or(&[])),
        };
        match r {
            Ok(x) => results.push(x),
            Err(e) => {
                failed.push(s.id);
                first_err.get_or_insert(e);
            }
        }
    }
    Ok((results, failed, first_err))
}

fn score(s: &SignalIn, now_s: u64, ref_usd: f64, floor_usd: f64, hl_coins: &[String]) -> Result<SignalScore, String> {
    let Some(plan) = plan_of(s) else { return Ok(lose(s.id, "invalid")) };
    let posted_s = s.posted_at_ms / 1000;
    let end_s = (s.posted_at_ms + s.valid_min as u64 * 60_000) / 1000;
    match s.venue.as_str() {
        "hyperliquid" => {
            if !hl_coins.iter().any(|c| c == &s.address) {
                return Ok(lose(s.id, "no_market"));
            }
            let (sec, name) = hl_interval(now_s, posted_s);
            let body = json!({ "type": "candleSnapshot", "req": { "coin": s.address, "interval": name, "startTime": posted_s * 1000, "endTime": end_s * 1000 } });
            let v = post(HL, &body)?;
            let candles = window(&parse_hl_candles(&v), posted_s, end_s, sec);
            if candles.is_empty() {
                return Ok(SignalScore { id: s.id, r_bps: 0, outcome: "no_data".into(), fill_price: None, exit_price: None, cost_bps: None });
            }
            Ok(finish(s.id, &plan, &walk(&plan, &candles), HL_TAKER_FEE, HL_TAKER_FEE, sec))
        }
        "gecko" | "gecko_micro" => {
            let micro = s.venue == "gecko_micro";
            let (floor_usd, rules) = if micro { (MICRO_FLOOR_USD, MICRO) } else { (floor_usd, NORMAL) };
            let net = s.network.clone().unwrap_or_default();
            let v = get(&format!("{GT}/{net}/tokens/{}/pools?include=base_token,quote_token", s.address))?;
            let pools = parse_pools_on(&v, &s.address, &net);
            if pools.is_empty() {
                return Ok(lose(s.id, "no_market"));
            }
            // The pool the candles come from (deepest of those that existed at the post) must
            // itself clear the floor; a newer pool can't lend it liquidity.
            let Some(pool) = pick_pool(&pools, Some(posted_s)) else { return Ok(lose(s.id, "no_pool_at_post")) };
            if let Err(why) = dex_check(pool, floor_usd) {
                return Ok(lose(s.id, why));
            }
            let (sec, tf, agg) = gt_interval(posted_s, end_s);
            let mut all = vec![];
            let mut before = end_s;
            for _ in 0..3 {
                let url = format!(
                    "{GT}/{net}/pools/{}/ohlcv/{tf}?aggregate={agg}&limit=1000&before_timestamp={before}&currency=usd&token={}",
                    pool.address, s.address
                );
                let page = parse_gt_candles(&get(&url)?);
                let oldest = page.iter().map(|c| c.t).min();
                all.extend(page);
                match oldest {
                    Some(t) if t > posted_s => before = t,
                    _ => break,
                }
            }
            let candles = window(&all, posted_s, end_s, sec);
            if candles.is_empty() {
                return Ok(SignalScore { id: s.id, r_bps: 0, outcome: "no_trades".into(), fill_price: None, exit_price: None, cost_bps: None });
            }
            let c = dex_side_cost(pool, ref_usd);
            let (c_in, c_out) = (c, c);
            Ok(finish(s.id, &plan, &walk_with(&plan, &candles, rules), c_in, c_out, sec))
        }
        _ => Ok(lose(s.id, "invalid")),
    }
}

/// GeckoTerminal's free API rate-limits hard, so pace every request and back off on 429.
fn get(url: &str) -> Result<Value, String> {
    const TRIES: u64 = 5;
    for attempt in 1..=TRIES {
        std::thread::sleep(Duration::from_millis(2_500));
        let resp = Client::new()
            .get(url)
            .header("accept", "application/json")
            .connect_timeout(Duration::from_secs(15))
            .send()
            .map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        let body = resp.body().map_err(|e| e.to_string())?;
        match status {
            200 => return serde_json::from_slice(&body).map_err(|e| format!("bad json from {url}: {e}")),
            404 => return Ok(Value::Null), // unknown token or pool: rules turn this into a result
            429 if attempt < TRIES => std::thread::sleep(Duration::from_secs(10 * attempt)),
            s => return Err(format!("http {s} from {url}")),
        }
    }
    unreachable!()
}

fn post(url: &str, body: &Value) -> Result<Value, String> {
    const TRIES: u64 = 4;
    let bytes = serde_json::to_vec(body).unwrap();
    for attempt in 1..=TRIES {
        let resp = Client::new()
            .post(url)
            .header("content-type", "application/json")
            .body(&bytes)
            .connect_timeout(Duration::from_secs(15))
            .send()
            .map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        let out = resp.body().map_err(|e| e.to_string())?;
        match status {
            200 => return serde_json::from_slice(&out).map_err(|e| format!("bad json from {url}: {e}")),
            429 | 500..=599 if attempt < TRIES => std::thread::sleep(Duration::from_secs(5 * attempt)),
            s => return Err(format!("http {s} from {url}: {}", String::from_utf8_lossy(&out).chars().take(200).collect::<String>())),
        }
    }
    unreachable!()
}
