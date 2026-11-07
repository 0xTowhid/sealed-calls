# CLAUDE.md — Sealed Calls (NEAR HACKATHON 2026)

Handoff from the claude.ai planning session (Nov 6, 2026). Read this first; it records decisions already made and why. Do not re-litigate locked decisions unless the user asks.

- Builder: Towhid (@0xTowhid), solo, crypto Twitter creator (perps, airdrops, analytics). Timezone Asia/Dhaka (UTC+6).
- **Deadline: Nov 14, 2026 23:59 UTC = Nov 15, 05:59 Dhaka.** One project only (second slot deliberately unused).
- Research doc (landscape, why this idea): https://claude.ai/artifact/PeUJTpGHCVB9cPtFTZkMdF
- Critical audit (rounds 1–2, locked MVP): https://claude.ai/artifact/6njWSZRxZ9DwwTxM47Gz1f

## Working agreements with the user

- Smallest honest product over architectural ambition. No fake transactions, hardcoded successes or simulated integrations in the demo.
- Label claims as verified / assumption / unverified. Never overclaim (see "What we claim").
- **UI work: show a concept image or mockup first and get approval before building any UI code.** The user has asked for this repeatedly.
- Prefer free, keyless, open-source dependencies.

## The locked MVP

**Mechanic:** a club's paid memecoin calls become a complete public record after each call ends, scored on what a $500 trade would roughly have returned; the caller is paid from the club's escrow only when that record is positive.

**What we claim, word for word:** "Calls cannot be edited, deleted or hidden, and become public when they end. Scores are indicative returns for a $500 trade. Sealed Calls does not stop callers trading against you; it makes their record public and pays them only when calls work."

| Area | Locked choice |
| --- | --- |
| Chain / assets | Solana memecoins, long only |
| A call | token mint + horizon (1h, 4h, 24h, 72h). No pool choice, no TP/SL |
| Privacy | sha256 commitment of `call‖salt`; tlock copy timelocked to the drand round at **end of horizon**; per-call key wrapped (X25519 sealed box) to each current member. Club cap 25 members. No epoch keys |
| Limits (contract) | roster callers only; one open call per token per caller; 5 calls/day per caller |
| Reveal | permissionless after the round; members may reveal from their own copy; unrevealed after 24 h grace = −100% |
| Money | Sputnik DAO funds an epoch escrow via one FunctionCall proposal; `settle` runs scoring on OutLayer and pays callers with positive score; min record 10 scored calls (club parameter; demo club uses 3, say so in README); unspent budget stays with the club |
| Pages | compose, member feed (decrypt + hash check), public caller profile (every call, cost haircut, result) |

### Scoring rules (implemented in the OutLayer job)

1. **Pool:** caller names token only. Entry pool = deepest GeckoTerminal pool paired with SOL or USDC whose `pool_created_at` < post time. Exit pool = deepest such pool at exit (follows migrations).
2. **Floor:** no eligible pool ≥ $100k liquidity at reveal → −100% ("below floor").
3. **Entry:** first 1-minute close within 15 min after the post's block time; none → −100%.
4. **Missing minutes:** forward-fill last close (gate (d) tells us whether GeckoTerminal omits or zero-fills).
5. **Exit:** median 1-minute close over the last 30 min of the horizon, needs ≥10 minutes with trades; fewer → lowest close in the window. Optional: take the worse of that and a live Jupiter sell quote at reveal.
6. **Costs ($500 reference trade):** pool fee + constant-product impact ≈ 500 ÷ (½ pool USD liquidity at reveal) on each side, + Token-2022 transfer fee if any.
7. **Rugs:** every eligible pool down >80% liquidity during horizon and no other pool ≥ floor → −100%.
8. `r = clip(P_exit·(1−c_out) / (P_entry·(1+c_in)) − 1, −1, +3)`. Win = r > 0. No peak/ATH multiples, no wicks.
9. Epoch score `S = Σr / (n + 5)`. Payout share ∝ `max(S,0) · min(n,20)` among callers past the min record.

### Explicitly excluded

Base/ETH/BSC/Hyperliquid/Robinhood; caller-chosen pools; TP/SL; shorts; public reveal before horizon end; peak multiples; epoch keys; per-subscriber billing; per-member refunds; any claim of executable/verified PnL, front-running prevention or leak prevention; live entry quotes; wallet clustering; cross-club reputation; mainnet; 1Click; Telegram bot; own token.

**Optional only after the full loop works:** wallet linking (Solana ed25519 sig verified in contract via `env::ed25519_verify`) + pre-buy/horizon-sell flag; Jupiter exit quote + published exit-estimate calibration; Solana freeze-authority / Token-2022 checks; approving the DAO proposal through Trezu's UI; hosted app.

## NEAR components (verified in docs/source, not yet run unless noted)

| Component | Use | Notes |
| --- | --- | --- |
| near-sdk (Rust) | main contract | near-sdk 5.30.1 resolves today, MSRV 1.95. If deploy rejects the wasm (PrepareError), pin `=5.17.0` + Rust 1.86 |
| NEP-297 events | feed / explorer | |
| OutLayer `outlayer.testnet` | attested scoring | `request_execution(source={"WasmUrl":{url,hash,build_target:"wasm32-wasip2"}}, resource_limits (ALWAYS pass, else compile-only), input_data, secrets_ref, response_format:"Json", payer_account_id, params)`. Result arrives in the `.then()` callback as `Option<T>` (null on failure). Yield window ~200 blocks. WasmUrl must be https, no explicit port; GitHub raw URL works. Non-connector jobs have unrestricted outbound HTTP (WASI P2, `wasi-http-client`). Source: fastnear/near-outlayer `wasi-examples/PROXY_CONTRACTS_TUTORIAL.md` |
| Sputnik DAO v2 factory `sputnik-v2.testnet` | club treasury | `create {name, args: base64({config:{name,purpose,metadata}, policy:[council...]})}`, ~6 NEAR; proposals via `add_proposal` with `FunctionCall {receiver_id, actions:[{method_name,args(base64),deposit,gas}]}` + proposal bond |
| Trezu | UI over Sputnik (optional) | supports bulk payments |
| Function-call keys / gas keys (NEP-611) | keeper for reveal/settle | |
| drand quicknet + tlock-js 0.9.0 | sealing | `mainnetClient()` is pinned to quicknet (chain hash 52db9ba7…), 3 s rounds, 12-of-22 threshold |

## Accounts (Nov 7)

- Testnet owner: **`to69.testnet`** (the user's). Its private key is the repo secret `NEAR_PRIVATE_KEY`; the workflow derives the public key and refuses to sign unless it is a full-access key of `to69.testnet` (`scripts/pubkey.mjs`, `preflight` in `scripts/testnet.sh`).
- Contract: `app.to69.testnet`; demo members `m1.to69.testnet`, `m2.to69.testnet`; calls are posted by `to69.testnet` itself.
- **Never put a mainnet key in GitHub secrets.** The user's mainnet account is `to69.near`; mainnet is out of scope and, if ever done, runs from a key that is not stored on GitHub.
- Old generated accounts `sealedcalls-towhid.testnet` (+ app/caller/m2 sub-accounts) are abandoned test leftovers.

## Gate results (Nov 7)

| Gate | Result | Evidence |
| --- | --- | --- |
| (a) tlock | PASS | CI: sealed to a future round, refused early, opened at the round; 694–792 byte ciphertext |
| (d) prices | PASS | GeckoTerminal pools have `pool_created_at`; empty minutes are **omitted**; 72 h history works; free API rate-limits after ~8 fast calls (scorer paces + retries); Jupiter lite-api quote works |
| (b) contract → OutLayer → callback | **PASS** | testnet e2e 16:34–16:50 UTC: club 1 on app.sealedcalls-towhid.testnet, call 0 BONK, member decrypt OK, early reveal rejected, drand reveal OK, settle → OutLayer request 12291 success (9.6 s, 0.0021 NEAR charged, rest refunded) → score −147 bps "median", paid 0 |
| (c) Sputnik DAO | not run yet | |

Fallbacks for (a), (b), (d) are no longer needed. near-sdk 5.30 wasm deploys fine.
near-cli-rs (Nov 2026): `sign-with-plaintext-private-key <PRIVATE_KEY> send` (positional; `--signer-public-key` was removed; its README is outdated).

## Status (Nov 7, evening)

- Work continues in the claude.ai cloud session. Its sandbox reaches GitHub only, so all network work (gates, wasm builds, deploys) runs in GitHub Actions (`.github/workflows/ci.yml`); results are pushed to the `results` branch, the built scorer wasm to the `dist` branch.
- `contract/`: main contract written (clubs, roster/members by governor, member X25519 keys, post_call with drand-round and wrapped-key checks, daily limit, reveal bound to club+caller+horizon, mark_unrevealed, settle → OutLayer → on_scores, duplicate rule, shrunk score, budget split, NEP-297 events). 20 unit tests pass.
- Design change found while building: the token is sealed at posting, so "one open call per token" is enforced at settle (later duplicate scores −100%), not rejected at posting.
- `scorer/`: OutLayer job implementing the scoring rules against GeckoTerminal; 8 unit tests pass on the pure rules; the live run is in CI (`scorer-live`).

## Status at handoff (Nov 6)

- `gates/` written; **none of the network gates have been run yet** (the planning sandbox had no outbound network). Verified there: probe contract unit tests pass (3/3); candle job type-checks; scripts parse.
- Gate kit: (a) `gates/01-tlock` tlock round-trip; (d) `gates/04-prices` GeckoTerminal pool/candle/history + gap behaviour + optional Jupiter; (b) `gates/02-outlayer` probe contract → OutLayer → callback (the riskiest); (c) `gates/03-sputnik` create DAO + FunctionCall proposal. Run order: a, d, b, c. See README.
- The probe/candle job still contains a Hyperliquid path; it is only a connectivity probe now. The MVP path is `call-gt` (GeckoTerminal).

## Plan (order of work)

| Day | Work | Gate |
| --- | --- | --- |
| Nov 7 | run gates a, d, b, c | if (b) fails by evening → fallback below |
| Nov 8 | contract: clubs, roster, member keys, post_call (limits), reveal, mark_unrevealed, events, unit tests; deploy testnet | |
| Nov 9 | scoring job (Solana rules above); compose page (mockup first!). User starts posting real calls daily | |
| Nov 10 | member key wrapping + feed decrypt/verify; reveal button + keeper | **loop gate:** post → member read → public reveal |
| Nov 11 | settle via OutLayer, payouts, min-record | |
| Nov 12 | DAO funding via near-cli proposal; profile page; README for AI screener | |
| Nov 13 | optional items or buffer; demo video | |
| Nov 14 | submit: public repo, X post (@NEARProtocol #NEARHackathon), form | |

## Unverified integrations → fallback

| Integration | Fallback |
| --- | --- |
| tlock-js vs drand | Node helper; if drand unusable, OutLayer-held key released at horizon |
| Contract → OutLayer yield/resume | OutLayer HTTPS API; anyone submits result to `settle`; 24 h window to re-run public scorer; DAO council veto |
| GeckoTerminal inside OutLayer (30 calls/min shared) | batch ≤2 requests per call; else public scorer + challenge window |
| GeckoTerminal endpoints / gap behaviour | DexScreener (pools), Birdeye free key (candles), or fixed token list |
| Jupiter lite-api (optional) | drop; candles only |
| Solana RPC mint reads (optional) | skip; rely on rug rules |
| Sputnik create + FunctionCall with deposit | members deposit directly into contract escrow; DAO governs roster only |
| Trezu custom proposal (optional) | near-cli, show in Trezu |
| Wallet selector on testnet | scripted demo accounts with keys in `.env` |
| X25519 sealed boxes in browser | libsodium-wrappers instead of tweetnacl |
| Solana sig verify in contract (optional) | drop wallet linking |
| near-sdk 5.30 wasm on deploy | near-sdk 5.17 + Rust 1.86 |

## Hackathon rules that matter

- Testnet-only is eligible. NEAR Intents has no testnet (not used in MVP).
- Claude Code / Codex screen each repo first: it must run and do what the README says. Keep README steps literal ("do X, see Y").
- Public repo, open-source license (MIT, present), X post with demo, submission form. Disclose third-party code in README.
