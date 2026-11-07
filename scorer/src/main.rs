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
        Ok(results) => JobOut { ok: true, results, error: None },
        Err(e) => JobOut { ok: false, results: vec![], error: Some(e) },
    };
    print!("{}", serde_json::to_string(&out).unwrap());
    io::stdout().flush().ok();
}

fn run() -> Result<Vec<SignalScore>, String> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let job: JobIn = serde_json::from_str(&raw).map_err(|e| format!("bad input: {e}"))?;
    let now_s = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    job.signals.iter().map(|s| score(s, now_s, job.reference_usd, job.liquidity_floor_usd)).collect()
}

fn score(s: &SignalIn, now_s: u64, ref_usd: f64, floor_usd: f64) -> Result<SignalScore, String> {
    let Some(plan) = plan_of(s) else { return Ok(lose(s.id, "invalid")) };
    let posted_s = s.posted_at_ms / 1000;
    let end_s = (s.posted_at_ms + s.valid_min as u64 * 60_000) / 1000;
    match s.venue.as_str() {
        "hyperliquid" => {
            let (sec, name) = hl_interval(now_s, posted_s);
            let body = json!({ "type": "candleSnapshot", "req": { "coin": s.address, "interval": name, "startTime": posted_s * 1000, "endTime": end_s * 1000 } });
            let v = post(HL, &body)?;
            let candles = window(&parse_hl_candles(&v), posted_s, end_s, sec);
            if candles.is_empty() {
                return Ok(SignalScore { id: s.id, r_bps: 0, outcome: "no_data".into(), fill_price: None, exit_price: None, cost_bps: None });
            }
            Ok(finish(s.id, &plan, &walk(&plan, &candles), HL_TAKER_FEE, HL_TAKER_FEE, sec))
        }
        "gecko" => {
            let net = s.network.clone().unwrap_or_default();
            let v = get(&format!("{GT}/{net}/tokens/{}/pools?include=base_token,quote_token", s.address))?;
            let pools = parse_pools(&v, &s.address);
            let Some(now_pool) = pick_pool(&pools, None) else { return Ok(lose(s.id, "no_market")) };
            if now_pool.liquidity_usd < floor_usd {
                return Ok(lose(s.id, "below_floor"));
            }
            let Some(pool) = pick_pool(&pools, Some(posted_s)) else { return Ok(lose(s.id, "no_pool_at_post")) };
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
            let (c_in, c_out) = (dex_side_cost(pool, ref_usd), dex_side_cost(now_pool, ref_usd));
            Ok(finish(s.id, &plan, &walk(&plan, &candles), c_in, c_out, sec))
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
