//! Gate (b) probe: a NEAR contract asks OutLayer to run the candle job, pauses (yield),
//! and stores the attested result when OutLayer resumes it. This is exactly the path
//! `settle` will use in Sealed Calls, minus the payouts.

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct CandleOut {
    pub ok: bool,
    pub source: String,
    pub close: Option<String>,
    pub t_ms: Option<u64>,
    pub candles: usize,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
#[near(serializers = [borsh])]
pub struct Record {
    pub requested_at_ms: u64,
    pub resolved_at_ms: u64,
    /// The job's JSON output as OutLayer returned it, or a short failure reason.
    pub result: String,
    pub ok: bool,
}

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    );
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Probe {
    outlayer: AccountId,
    wasm_url: String,
    wasm_hash: String,
    last: Option<Record>,
}

#[near]
impl Probe {
    #[init]
    pub fn new(outlayer: AccountId, wasm_url: String, wasm_hash: String) -> Self {
        assert!(wasm_url.starts_with("https://"), "wasm_url must be https");
        assert!(wasm_hash.len() == 64 && wasm_hash.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "wasm_hash must be 64 lowercase hex chars");
        Self { outlayer, wasm_url, wasm_hash, last: None }
    }

    /// Attach the deposit from `estimate_execution_cost` on the OutLayer contract (0.05 NEAR is plenty on testnet).
    /// The window is the last 10 minutes before this block, so the job needs no clock of its own.
    #[payable]
    pub fn request_hl_candle(&mut self, coin: String) -> Promise {
        let now = env::block_timestamp_ms();
        let input = json!({ "source": "hyperliquid", "coin": coin, "start_ms": now - 600_000, "end_ms": now });
        self.request(input)
    }

    #[payable]
    pub fn request_gt_candle(&mut self, network: String, pool: String) -> Promise {
        self.request(json!({ "source": "geckoterminal", "network": network, "pool": pool }))
    }

    #[private]
    pub fn on_result(
        &mut self,
        requested_at_ms: u64,
        #[callback_result] result: Result<Option<CandleOut>, PromiseError>,
    ) -> Record {
        let (ok, text) = match result {
            Ok(Some(out)) => (out.ok, serde_json::to_string(&out).unwrap()),
            Ok(None) => (false, "run failed or printed nothing (OutLayer returned null)".to_string()),
            Err(_) => (false, "request_execution was refused".to_string()),
        };
        env::log_str(&format!("probe result: {text}"));
        let rec = Record { requested_at_ms, resolved_at_ms: env::block_timestamp_ms(), result: text, ok };
        self.last = Some(rec.clone());
        rec
    }

    pub fn last_result(&self) -> Option<Record> {
        self.last.clone()
    }

    pub fn config(&self) -> (AccountId, String, String) {
        (self.outlayer.clone(), self.wasm_url.clone(), self.wasm_hash.clone())
    }

    fn request(&mut self, input: Value) -> Promise {
        let deposit = env::attached_deposit();
        assert!(deposit > NearToken::from_yoctonear(0), "attach a deposit for OutLayer compute");
        let source = json!({ "WasmUrl": { "url": self.wasm_url, "hash": self.wasm_hash, "build_target": "wasm32-wasip2" } });
        // Always pass resource_limits: without it OutLayer only compiles and runs nothing.
        let limits = json!({ "max_instructions": 2_000_000_000u64, "max_memory_mb": 128u32, "max_execution_seconds": 60u64 });
        ext_outlayer::ext(self.outlayer.clone())
            .with_attached_deposit(deposit)
            .with_unused_gas_weight(1)
            .request_execution(
                source,
                Some(limits),
                Some(input.to_string()),
                None,
                Some("Json".to_string()),
                Some(env::predecessor_account_id()), // unused deposit goes back to the caller
                None,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_result(env::block_timestamp_ms()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn setup() -> Probe {
        testing_env!(VMContextBuilder::new().block_timestamp(1_762_400_000_000_000_000).build());
        Probe::new("outlayer.testnet".parse().unwrap(), "https://example.com/candle-job.wasm".into(), "a".repeat(64))
    }

    #[test]
    #[should_panic(expected = "wasm_hash must be 64 lowercase hex chars")]
    fn rejects_bad_hash() {
        Probe::new("outlayer.testnet".parse().unwrap(), "https://x/y.wasm".into(), "ABC".into());
    }

    #[test]
    fn stores_successful_result() {
        let mut p = setup();
        let out = CandleOut { ok: true, source: "hyperliquid".into(), close: Some("3120.5".into()), t_ms: Some(1), candles: 10, error: None };
        let rec = p.on_result(5, Ok(Some(out)));
        assert!(rec.ok);
        assert!(p.last_result().unwrap().result.contains("3120.5"));
    }

    #[test]
    fn records_failed_run() {
        let mut p = setup();
        let rec = p.on_result(5, Ok(None));
        assert!(!rec.ok);
        assert!(rec.result.contains("null"));
    }
}
