# Sealed Calls

A paid alpha club where a caller cannot delete, edit or hide a losing call. A community's Sputnik DAO funds a club once; calls are timelocked to a drand round (members read them at once, everyone else at the round); an OutLayer TEE job scores revealed calls against public prices; the contract pays callers by score.

Built for NEAR HACKATHON 2026 (tracks: Social Money, Privacy & Private AI, Open Innovation). Status: **day-1 gate checks**. Nothing below is the product yet.

## Day 1 (Nov 7): gate checks

No app code until these four pass. Each prints PASS or FAIL.

### Setup (once)

```bash
# Rust + WASM targets + NEAR tooling
rustup target add wasm32-unknown-unknown wasm32-wasip2
cargo install cargo-near near-cli-rs        # or the installers from their GitHub releases
cargo install wasmtime-cli                  # optional: runs the OutLayer job locally first

# A testnet account funded by the faucet (gives ~10 testnet NEAR)
near account create-account sponsor-by-faucet-service YOURNAME.testnet autogenerate-new-keypair save-to-keychain network-config testnet create
export ME=YOURNAME.testnet
```

Gate (c) needs ~6 NEAR and gate (b) ~3 NEAR, so create a second faucet account and send its NEAR to `$ME` if you run short:
`near tokens SECOND.testnet send-near $ME '9 NEAR' network-config testnet sign-with-keychain send`

### (a) Timelock seal and reveal — `gates/01-tlock`

```bash
cd gates/01-tlock && npm install && node tlock-roundtrip.mjs
```

PASS: three `OK` lines, `period=3s` (drand quicknet), and the ciphertext size it prints (expect under 1 KB). Takes about 70 s because check 3 waits for a real round.

### (d) Price sources — `gates/04-prices` (run before (b), it gives you a pool address)

```bash
node gates/04-prices/fetch-candles.mjs
```

PASS: Hyperliquid and both GeckoTerminal lines `OK`. Copy the Solana pool address it prints. The Robinhood line only tells us whether stock tokens make the MVP.

### (b) Contract → OutLayer → callback — `gates/02-outlayer`

```bash
cd gates/02-outlayer
./run-probe.sh build                 # builds the job (wasm32-wasip2) and the probe contract; prints the job sha256
# commit candle-job.wasm to a PUBLIC GitHub repo, then use its raw URL:
WASM_URL=https://raw.githubusercontent.com/<you>/<repo>/main/gates/02-outlayer/candle-job.wasm ./run-probe.sh deploy
./run-probe.sh call                  # asks OutLayer for a Hyperliquid ETH candle (attaches 0.05 NEAR; unused part is refunded)
./run-probe.sh result                # wait ~20–60 s first
POOL=<solana pool from (d)> ./run-probe.sh call-gt && ./run-probe.sh result
```

PASS: `result` shows `"ok": true` with a `close` price, and the transaction in the explorer has an `on_result` receipt. This proves the exact path `settle` will use.

If `deploy` rejects the contract wasm (a `PrepareError` or deserialization error), pin `near-sdk = "=5.17.0"` and build with Rust 1.86 (`rustup install 1.86.0 && rustup override set 1.86.0` in `probe-contract`).

**If (b) still fails by the evening of Nov 7, switch to the fallback:** run the same job through OutLayer's HTTPS API, let anyone submit the result to `settle`, and add a 24-hour window in which anyone can re-run the public scorer and the DAO council can veto.

### (c) Sputnik DAO with a FunctionCall proposal — `gates/03-sputnik`

```bash
./gates/03-sputnik/create-dao.sh     # run after (b) so probe.$ME exists
```

PASS: `get_policy` lists `$ME` in the council, and proposal 0 has a `FunctionCall` kind targeting `probe.$ME`. That is the shape of the Nov 12 "fund the club" proposal.

## What each gate proves

| Gate | Proves | Used by |
| --- | --- | --- |
| (a) | Calls can be sealed until a round and opened by anyone after it, with a hash check | posting and reveal |
| (b) | A NEAR contract can run an attested job that fetches prices and get its JSON back through yield/resume | `settle` |
| (c) | A DAO can call our contract with one proposal | club funding |
| (d) | Free, keyless candles exist for perps and Solana/Base tokens | scoring |

## Third-party code

- [tlock-js](https://github.com/drand/tlock-js) (drand timelock encryption)
- [near-sdk-rs](https://github.com/near/near-sdk-rs), [wasi-http-client](https://crates.io/crates/wasi-http-client)
- Patterns from [OutLayer's proxy-contract tutorial](https://github.com/fastnear/near-outlayer/blob/main/wasi-examples/PROXY_CONTRACTS_TUTORIAL.md) and the [Sputnik DAO README](https://github.com/near-daos/sputnik-dao-contract)

## License

MIT
