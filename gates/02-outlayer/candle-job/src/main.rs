//! Gate (b) job: fetch one price candle inside an OutLayer TDX worker and print it as JSON.
//! This is the seed of the real scoring job: same I/O shape, same price sources.
//!
//! stdin examples:
//!   {"source":"hyperliquid","coin":"ETH","start_ms":1762400000000,"end_ms":1762400600000}
//!   {"source":"geckoterminal","network":"solana","pool":"<pool address>"}
//! stdout: exactly one JSON object, always (a failure is {"ok":false,...}, never a panic).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read, Write};
use std::time::Duration;
use wasi_http_client::Client;

#[derive(Deserialize)]
#[serde(tag = "source", rename_all = "lowercase")]
enum Input {
    Hyperliquid { coin: String, start_ms: u64, end_ms: u64 },
    Geckoterminal { network: String, pool: String },
}

#[derive(Serialize)]
struct Output {
    ok: bool,
    source: String,
    /// Close price of the latest candle, as a decimal string (no float rounding on chain).
    close: Option<String>,
    /// Open time of that candle, unix ms.
    t_ms: Option<u64>,
    candles: usize,
    error: Option<String>,
}

fn main() {
    let out = run().unwrap_or_else(|(source, e)| Output {
        ok: false,
        source,
        close: None,
        t_ms: None,
        candles: 0,
        error: Some(e),
    });
    print!("{}", serde_json::to_string(&out).unwrap());
    io::stdout().flush().ok();
}

fn run() -> Result<Output, (String, String)> {
    let mut raw = String::new();
    io::stdin().read_to_string(&mut raw).map_err(|e| ("?".into(), e.to_string()))?;
    let input: Input = serde_json::from_str(&raw).map_err(|e| ("?".into(), format!("bad input: {e}")))?;
    match input {
        Input::Hyperliquid { coin, start_ms, end_ms } => hyperliquid(&coin, start_ms, end_ms)
            .map_err(|e| ("hyperliquid".into(), e)),
        Input::Geckoterminal { network, pool } => geckoterminal(&network, &pool)
            .map_err(|e| ("geckoterminal".into(), e)),
    }
}

/// POST https://api.hyperliquid.xyz/info  {"type":"candleSnapshot","req":{...}}
/// Response: array of {"t":open_ms,"T":close_ms,"o","h","l","c","v",...} with prices as strings.
fn hyperliquid(coin: &str, start_ms: u64, end_ms: u64) -> Result<Output, String> {
    let body = serde_json::json!({
        "type": "candleSnapshot",
        "req": { "coin": coin, "interval": "1m", "startTime": start_ms, "endTime": end_ms }
    });
    let resp = Client::new()
        .post("https://api.hyperliquid.xyz/info")
        .header("content-type", "application/json")
        .body(body.to_string().as_bytes())
        .connect_timeout(Duration::from_secs(10))
        .send()
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let bytes = resp.body().map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(format!("http {status}: {}", String::from_utf8_lossy(&bytes)));
    }
    let candles: Vec<Value> = serde_json::from_slice(&bytes).map_err(|e| format!("bad json: {e}"))?;
    let last = candles.last().ok_or("no candles in range")?;
    Ok(Output {
        ok: true,
        source: "hyperliquid".into(),
        close: last["c"].as_str().map(str::to_owned),
        t_ms: last["t"].as_u64(),
        candles: candles.len(),
        error: None,
    })
}

/// GET https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pool}/ohlcv/minute?aggregate=1&limit=5
/// Response: data.attributes.ohlcv_list = [[ts_sec, o, h, l, c, v], ...] newest first.
/// (Endpoint shape to be confirmed by gate (d) before relying on it.)
fn geckoterminal(network: &str, pool: &str) -> Result<Output, String> {
    let url = format!(
        "https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pool}/ohlcv/minute?aggregate=1&limit=5"
    );
    let resp = Client::new()
        .get(&url)
        .header("accept", "application/json")
        .connect_timeout(Duration::from_secs(10))
        .send()
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let bytes = resp.body().map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(format!("http {status}: {}", String::from_utf8_lossy(&bytes)));
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("bad json: {e}"))?;
    let list = v["data"]["attributes"]["ohlcv_list"].as_array().ok_or("no ohlcv_list")?;
    let newest = list.first().ok_or("empty ohlcv_list")?;
    Ok(Output {
        ok: true,
        source: "geckoterminal".into(),
        close: newest.get(4).map(|c| c.to_string()),
        t_ms: newest.get(0).and_then(Value::as_u64).map(|s| s * 1000),
        candles: list.len(),
        error: None,
    })
}
