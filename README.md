# Sealed Calls

**Trading signals with a record nobody can edit, and subscriptions that pay the creator in full only when the signals work.**

Anyone can open a channel and sell subscriptions (1 week to 12 months, creator's prices). A creator posts signals the way Telegram signal groups do: market, long or short, leverage, buy range, up to three take-profits, a stop loss, how long it is valid, and a message. Each signal is **sealed**:

- subscribers who are active at that moment can decrypt it at once (in their browser);
- everyone else, including the creator's critics, can open it only when its validity ends (drand timelock);
- its hash is fixed on NEAR when it is posted, so it cannot be edited, deleted or quietly hidden.

When a signal ends it is **scored in an OutLayer TEE job** on public candles (Hyperliquid for perps, GeckoTerminal for DEX tokens on any chain): did it fill inside the range, which take-profits or the stop loss were hit, was it liquidated, what fees and DEX price impact cost. The result is written back to the contract and stays on the creator's public page.

**Money:** 50% of every subscription goes to the creator immediately. The other 50% is spread over the periods the subscription covers and held by the contract. When a period settles, the creator gets that period's held half only if the signals they posted in it have a positive score; otherwise each subscriber can claim their part back.

What we claim, and only this: *Signals cannot be edited, deleted or hidden, and become public when they end. Results are indicative: they replay each signal on public candles with fees, leverage and, for DEX tokens, the price impact of a $500 trade. Sealed Calls does not stop creators trading against subscribers or subscribers leaking signals; it makes the record public and pays creators in full only when signals work.*

Built for NEAR HACKATHON 2026 by [@0xTowhid](https://x.com/0xTowhid). Testnet only.

- **Live app:** https://0xtowhid.github.io/sealed-calls/ (reads `app.to69.testnet`)
- **Contract:** [`app.to69.testnet`](https://testnet.nearblocks.io/address/app.to69.testnet)

## Try it in 5 minutes (no keys needed)

```bash
git clone https://github.com/0xTowhid/sealed-calls && cd sealed-calls

# 1. Contract rules: channels, 50/50 escrow, sealing, reveal, settlement, refunds (30 tests)
cd contract && cargo test && cd ..
# expect: "test result: ok. 30 passed"

# 2. Scoring rules: fills, TP/SL on closes, leverage + liquidation on wicks, shorts, costs (12 tests)
cd scorer && cargo test && cd ..
# expect: "test result: ok. 12 passed"

# 3. Read the live contract on testnet
cd scripts && npm install && node sc.mjs view app.to69.testnet get_config '{}' && node sc.mjs view app.to69.testnet list_channels '{}'
cd ..
# expect: the config (period length, scorer URL + sha256, outlayer.testnet) and the channels

# 4. The web app against the live contract
cd web && npm install && npm run dev
# open the printed URL: Explore lists creators; a channel page shows every signal and its result
```

Optional, the real scoring job on live prices (needs Rust's `wasm32-wasip2` target and [wasmtime](https://wasmtime.dev)):

```bash
rustup target add wasm32-wasip2
cd scorer && cargo build --release --target wasm32-wasip2 && cd ..
node scripts/sample-signals.mjs | wasmtime run -S http scorer/target/wasm32-wasip2/release/scorer.wasm
# expect: {"ok":true,"results":[{"id":1,"r_bps":…,"outcome":"expired"|"tp1"|…}, …, {"id":5,"r_bps":-10000,"outcome":"no_market"}]}
```

## The full loop on testnet

`scripts/testnet.sh e2e` runs everything against real testnet, real drand and real OutLayer, on a throwaway contract with a 20-minute period, then deletes it:

1. `to69.testnet` creates a channel; `m1` subscribes and registers a browser key, `m2` subscribes without one.
2. A BTC long is sealed and posted; `m1` decrypts it immediately and the hash matches; the public timelock copy and an early `reveal` are both refused.
3. After validity, anyone opens it from drand and reveals it.
4. After the period, `settle` sends it to the OutLayer scoring job (yield/resume); the result comes back, and the held half goes to the creator or becomes claimable by subscribers.

It runs in GitHub Actions (`.github/workflows/testnet.yml`, signing with a testnet key from a repo secret); logs are on the [`testnet-results`](https://github.com/0xTowhid/sealed-calls/tree/testnet-results) branch. To run it yourself: `MAIN=<you>.testnet SK=<testnet private key> PUBKEY=<its public key> SCORER_URL=… SCORER_HASH=… bash scripts/testnet.sh e2e`.

## How it uses NEAR

| Piece | What it does here |
| --- | --- |
| Rust contract (near-sdk 5) | channels, plans, subscriptions, the 50/50 split and per-period escrow, sealed signals, reveal rules, settlement, refunds; NEP-297 events |
| **OutLayer** (`outlayer.testnet`) | `settle` calls `request_execution` with the scorer's public wasm URL + sha256; the TEE job fetches candles and returns scores through yield/resume to `on_scores`. Unused compute deposit is refunded |
| Wallet selector | MyNearWallet, Meteor, Intear on testnet |
| drand quicknet + tlock | the public copy of each signal opens at the round when its validity ends |
| X25519 sealed boxes (libsodium) | a fresh key per signal, wrapped to each active subscriber's browser key |

## Scoring rules (scorer/src/lib.rs)

- **Fill:** the first candle close inside the entry range during validity. Never → "not filled", 0%, and it still counts in the record.
- **Exits:** take-profit *i* when a close crosses it (exits at TP *i*); stop loss when a close crosses it (exits at that close); TPs close equal parts; anything open exits at the last close of the validity window.
- **Leverage:** chosen by the creator (Hyperliquid 1–50x, DEX tokens 1x). The result is the leveraged return. Liquidation if a candle's low (long) / high (short) crosses ≈ fill × (1 ∓ 1/leverage) → −100%.
- **Costs:** Hyperliquid taker fee each side × leverage; DEX tokens pay pool fee + price impact of a $500 trade each side, and need a pool ≥ $100k paired with a major (SOL, ETH, USDC, …) that existed before the post.
- **Candles:** the finest still available (1-minute for recent signals; 5- or 15-minute or 1-hour for older ones). The size used is shown in the outcome.
- Clipped to −100%…+300%. A signal never revealed after the grace period, or a revealed text that is not a valid signal, scores −100%.
- **Period score** `S = Σr / (n + 5)`: five phantom flat signals, so a couple of lucky trades can't beat a long steady record.

## Honest limits

- Scores are indicative replays on public candles, not executed trades.
- The demo contract settles **daily** so results appear before the hackathon deadline; the product would settle weekly.
- Subscribers can leak decrypted signals; creators can trade against subscribers. Neither is prevented; the public record is the deterrent.
- The contract owner can point to a new scorer build (URL + sha256 are public in `get_config`). A production version would put that behind a DAO.
- Each signal is wrapped to every active subscriber, so channels are capped at 100 subscribers.

## Repo

| Path | What |
| --- | --- |
| `contract/` | NEAR contract + 30 unit tests |
| `scorer/` | OutLayer job (wasm32-wasip2) + 12 unit tests |
| `web/` | React app (Vite) |
| `scripts/` | `sc.mjs` (seal / open / view), `testnet.sh` (deploy, e2e, settle), `sample-signals.mjs` |
| `gates/` | the day-1 feasibility checks (tlock, prices, OutLayer, Sputnik) |
| `.github/workflows/` | CI (tests, wasm builds, live scorer run), testnet operations, Pages |

## Third-party code

- [near-sdk-rs](https://github.com/near/near-sdk-rs), [near-wallet-selector](https://github.com/near/wallet-selector), [wasi-http-client](https://crates.io/crates/wasi-http-client)
- [tlock-js](https://github.com/drand/tlock-js) (drand timelock encryption), [libsodium.js](https://github.com/jedisct1/libsodium.js)
- React, Vite, Archivo and JetBrains Mono (fontsource)
- Patterns from [OutLayer's proxy-contract tutorial](https://github.com/fastnear/near-outlayer/blob/main/wasi-examples/PROXY_CONTRACTS_TUTORIAL.md)
- Price data: [Hyperliquid info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint), [GeckoTerminal API](https://www.geckoterminal.com/dex-api)

## License

MIT
