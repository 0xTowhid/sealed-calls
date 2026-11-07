//! OutLayer entry point: reads JobIn JSON on stdin, fetches GeckoTerminal data, prints JobOut JSON.
//! A per-call data failure scores that call −100% only when the rules say so; a transport failure
//! fails the whole job (ok:false) so the contract lets anyone retry `settle` instead of paying on
//! bad data.

use scorer::*;
use serde_json::Value;
use std::io::{self, Read, Write};
use std::time::Duration;
use wasi_http_client::Client;

const GT: &str = "https://api.geckoterminal.com/api/v2/networks/solana";

fn main() {
    let out = match run() {
        Ok(results) => JobOut { ok: true, results, error: None },
        Err(e) => JobOut { ok: false, results: vec![], error: Some(e) },
    };
    print!("{}", serde_json::to_string(&out).unwrap());
    io::stdout().flush().ok();
}

fn run() -> Result<Vec<CallScore>, String> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).map_err(|e| e.to_string())?;
    let job: JobIn = serde_json::from_str(&raw).map_err(|e| format!("bad input: {e}"))?;
    let mut results = vec![];
    for call in &job.calls {
        let pools = parse_pools(&get(&format!("{GT}/tokens/{}/pools", call.mint))?);
        let posted_s = call.posted_at_ms / 1000;
        let end_s = (call.posted_at_ms + call.horizon_min as u64 * 60_000) / 1000;
        let (entry_candles, exit_candles) = match (pick_pool(&pools, Some(posted_s)), pick_pool(&pools, None)) {
            (Some(ep), Some(xp)) => (
                candles(&ep.address, &call.mint, posted_s + ENTRY_WINDOW_S + 60, 20)?,
                candles(&xp.address, &call.mint, end_s, 35)?,
            ),
            _ => (vec![], vec![]),
        };
        results.push(score_call(
            call,
            &Fetched { pools: &pools, entry_candles: &entry_candles, exit_candles: &exit_candles },
            job.reference_usd,
            job.liquidity_floor_usd,
        ));
    }
    Ok(results)
}

fn candles(pool: &str, mint: &str, before_s: u64, limit: u32) -> Result<Vec<Candle>, String> {
    let url = format!("{GT}/pools/{pool}/ohlcv/minute?aggregate=1&limit={limit}&before_timestamp={before_s}&currency=usd&token={mint}");
    Ok(parse_candles(&get(&url)?))
}

/// GeckoTerminal's free API rate-limits hard (CI saw HTTP 429 after ~8 quick requests), so pace
/// every request and back off on 429 before giving up.
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
            404 => return Ok(Value::Null), // unknown token or pool: rules turn this into −100%
            429 if attempt < TRIES => std::thread::sleep(Duration::from_secs(10 * attempt)),
            s => return Err(format!("http {s} from {url}")),
        }
    }
    unreachable!()
}
