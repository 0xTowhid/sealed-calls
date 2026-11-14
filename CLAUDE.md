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

## v2 scope (user decision, Nov 8 00:00 Dhaka) — SUPERSEDES the locked MVP below where they differ

The user reviewed the working v1 and asked for a general signal product (like Telegram signal groups). Decisions:

- **Anyone is a creator.** A creator runs a channel (one caller = the creator) and sets subscription plans: price per duration (1w / 2w / 1m / 6m / 12m, creator-chosen prices).
- **Subscriptions are time-limited.** Paying a plan extends `until`. Signals are wrapped only to members active at posting.
- **Money (option 3, chosen by the user):** 50% of every subscription goes to the creator immediately; 50% is spread over the periods (weeks) the subscription covers and held. When a period settles: creator's record for that period positive (S = Σr/(n+5) > 0, at least `min_signals`) → creator gets that period's held half; otherwise (or no signals) members claim it back.
- **Signals:** any token. Ticker search → user picks exact market. Fields: direction long/short, entry range low–high, TP1–TP3, SL, validity (free, 15 min – 30 days), optional message ≤280 chars. All sealed until validity ends.
- **Markets:** Hyperliquid (perps/majors; long or short; fees only) and GeckoTerminal any network (DEX tokens; long only; $100k liquidity floor; $500 price impact).
- **Scoring:** fill = first 1-minute close inside the entry range during validity; never filled → 0% ("not filled"), still counts. TP/SL trigger on 1-minute closes (not wicks); multiple TPs close equal parts; SL closes the rest; otherwise exit at validity end. The entry can fill at any time during validity ("1-minute" is only the candle size the scorer checks). **Leverage is chosen by the creator per signal** (Hyperliquid markets 1–50x; DEX tokens 1x only): result = leveraged return; liquidation if a 1-minute low (long) / high (short) crosses the liquidation price ≈ entry·(1 ∓ 1/lev) → −100%. Clip −100%…+300%. Invalid revealed payload → −100%. Unrevealed after grace → −100%.
- Dropped from v1: fixed horizon list, Solana-only, long-only, no TP/SL, club roster/DAO-funded escrow, duplicate rule. Sputnik DAO is no longer on the critical path.
- Plan: contract Nov 8; scorer Nov 9; UI Nov 10–11 (mockups first); live with real signals Nov 12; video + submit Nov 13–14.

## The locked MVP (v1, superseded where v2 differs)

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

## v2 status (Nov 8, 01:05 Dhaka)

- Contract v2 (30 tests) deployed fresh at `app.to69.testnet` with period_minutes 1440 (daily; README says weekly in production). v1 state was deleted.
- Scorer v2 (12 tests) live-tested in CI on Hyperliquid + GeckoTerminal.
- **v2 e2e PASS on testnet (19:03 UTC Nov 7)**, throwaway contract e2e071842.to69.testnet: channel → 2 subscribers (50/50 split events) → sealed BTC 5x long → m1 decrypts, hash matches → early tlock/reveal refused → drand reveal → settle → OutLayer request 12482 success (1.4 s) → r −48 bps "expired", fill 75816, exit 75812, cost 45 bps → period not released → m1 claimed refund. Log on `testnet-results`.
- Web v2 built from the approved mockups (Explore, Channel, Creator desk, Feed); `?viewas=<account>` gives a read-only preview. Pages deploys from main.
- **Late access (option A, user chose Nov 8 01:12):** `share_signals(items)` (creator only, sealed + still valid, active subscribers with a key, no deposit so the wallet's function-call key works silently). Web derives each signal key as HMAC(creator secret in localStorage, "sealed-calls v2 signal|"+commit); the desk re-shares every 30 s while open; key backup/restore on the desk. Contract upgraded in place 19:16 UTC Nov 7 (34 tests). Signals posted before this (random keys) can't be re-shared. Options B (bot) / C (OutLayer TEE key escrow) not built.
- **Hourly keeper** (testnet.yml `schedule: 17 * * * *`, action `keep`): reveals ended signals from drand (signed by to69.testnet), marks unopened ones after grace, settles every ended period via OutLayer. Log overwrites `keeper-latest.txt` on `testnet-results`. First run 19:48 UTC Nov 7 revealed meowcalls signal 0. Late access still needs the creator's desk open.
- **Score on end (Nov 8 12:30 Dhaka):** `score_signals(ids ≤10)` (anyone; OutLayer; deposit) gives official scores right after a signal ends; the keeper calls it each run (0.3 NEAR attached, mostly refunded); settle reuses existing scores (no OutLayer call if all scored). First run: request 13228 scored XRP −0.62% expired, ETH 0% not_filled. 38 contract tests.
- Web additions Nov 8: My channel (/#/@account), live unofficial replay (web/src/score.ts mirrors scorer rules), DEX = spot buy UI, direct token-address lookup, page cache + lazy crypto chunk, global Buffer polyfill in main.tsx.
- **Micro-caps (user agreed Nov 8 12:50):** keep the $100k liquidity floor for the hackathon and say why in the pitch/README; "micro-cap mode" is roadmap. CORRECTION Nov 8 13:02: user wants the $100k floor kept for normal DEX signals AND a separate micro-cap mode now. Built: venue "gecko_micro" (contract accepts it, no struct change), scorer MICRO rules: $10k floor, TP needs 2 consecutive closes, expiry exit = median of last 30 min (≥10 candles) else lowest close. Floor reset to 100000 via `floor=100000`. UI approved and built 13:10: desk micro box (auto when pool < floor and ≥ $10k; < $10k refused), MICRO tags, "called at ≈ $Xk mcap" (today's FDV × price at call ÷ price now, from GeckoTerminal, client-side), Explore Micro-caps tab ranked on micro signals only, live replay applies micro rules. Wallet check = roadmap.
- **Multiple channels (approved Nov 8 13:23):** any account can run several channels (contract always allowed it). Web: desk "Posting to" switcher + "+ New channel" (#/desk/new), creator page #/@account (all channels + combined), channel URLs #/@account/<slug or id>, every channel page shows the creator's full record across channels + NEW CHANNEL badge when a creator's channel has no scored signals, Explore ranks creators (accounts) on all channels together. Anti-farming: history follows the account; new accounts show as new creators (honest limit).
- **Channel kinds (approved Nov 8 13:41):** contract `create_channel`/`update_channel` take optional `tags` (perps|dex|micro; empty or all three = all kinds), stored under raw keys `tags:`+id (no struct change), view `channel_tags(channels)`; 41 tests. Explore tab = declared kinds ∪ revealed kinds (nothing declared → revealed kinds; nothing revealed → all tabs), ranked on that kind's ended signals. Kind picker on create/edit (edit attaches 0.01 NEAR only when kinds change), PERPS/DEX/MICRO/ALL KINDS tags on channel header + Explore.
- Desk explains pools paired with non-major tokens (e.g. WHITEHOUSE/DJT): only pools vs SOL/USDC/majors count; message names the bigger non-major pool.
- Web token search/prices via DexScreener (GeckoTerminal only for candles, paced + cached) after GT rate-limited the browser.
- Robinhood Chain supported (GT network `robinhood`), USDG counts as a major quote (app + scorer, Nov 8).
- to69.testnet balance ~3.5 NEAR (Nov 8 06:30 UTC); each settle/score costs ~0.003 NEAR + gas.
- **Late access verified live by the user (Nov 8 15:20 Dhaka)** with a second wallet.
- Layout pass Nov 8: Explore short list (option B, approved) ≤1180px, channel page single column ≤1320px, signal cards ≤880px; checked 360–1920px with mocked RPC (scratchpad harness), no overflow/clipped tables.
- **Design A2 locked and built (Nov 8 15:33 Dhaka):** new UI (Geist + Geist Mono, white panels on #F5F6F5, black ink, NEAR mint #00EC97 accent). Sticky app bar with tabs, NEAR Testnet chip (links contract on nearblocks), wallet chip (avatar + balance via view_account, menu). Explore: intro + 'How one call works' (real latest scored call + real sealed countdown), KPI strip from contract stats (calls, traders, active subscribers, paid to traders, returned to subscribers), leaderboard table (list ≤1100px). Channel: crumbs, profile (avatar, kinds, Share/explorer), stats4, cumulative result chart (sum of r_bps), filterable call table (cards ≤860px), sticky aside (Subscribe radio plans + split box, day-by-day pills, Verified on NEAR links). Feed/Desk/Creator restyled via shared classes. Mockups in scratchpad redesign/ (concept-A2-dapp.png).
- **Nov 9 finalize:** README rewritten to HACKATHON.md rules (problem, live-app do X → see Y, from-source steps, e2e evidence, NEAR usage, honest limits, baseline = none (first commit Nov 6), other project Pixel Bazaar, AI/third-party code). Tracks: open, privacy, social. Keeper now skips settling a period while one of its signals is still sealed (period 0 of meowcalls waits for signal 3). cargo-near install retries (release download 504s). Submission form draft + updated X post in the Docs artifact (5iaNGgDNjKCrkRkCoYeVxF). User submits himself (consent, email).
- Next: user posts real signals daily, records video, posts on X, submits. Contract lock (delete app.to69.testnet full-access key) only on the user's go-ahead.
- **Audit + fixes (Nov 13, user: "fix all"):** AUDIT.md lists 21 findings and their status. Contract (58 tests): storage paid by callers (share_signals from creator credit `deposit_storage`; register_key/reveal/mark_unrevealed/settle take deposits; claim deducts), grace ≥ 24 h, set_config delayed 24 h (`pending_config`/`apply_config`, OutLayer + period fixed), `migrate(config)` for upgrades, X25519 key validation, settle ≤ 10 unscored + 15-min restart, transfer callbacks (`owed`/`withdraw_owed`), release = Σr>0 over ≥ min_signals filled calls, subscribe(expect_days,max_price), signals count in the period they end, daily limit per creator, key rotation drops live wraps. Scorer (15 tests): same-pool floor/costs, quote whitelist by address (sol/eth/base/bsc/arbitrum), per-signal `failed` + 120 s budget. Web: mismatch warning, per-reader wrap, storage credit on desk, owed + pending-config + contract-override banners. Upgraded in place 14:10 UTC Nov 13 (grace 1440).
- **Nov 14:** full e2e PASS on the audited contract (OutLayer flakiness earlier was their testnet; scorer must be built with Rust 1.97, newer exports wasi:cli/run@0.2.12 which OutLayer can't run). Landing page (vault/envelope design, approved) at `/` (no hash), app at `#/`. App redesign approved: light/dark toggle (Option A light, Option B dark colours, top-bar layout), one number per row, explanations behind `Info` tips, sticky Subscribe bar on phones. Vercel builds every branch (failure emails for testnet-results/gh-pages/dist): user said no need to fix.
- testnet.sh actions: accounts, wipe-app, delete=<acct>, deploy, e2e, settle (CH=n), status. Small calls use 100 Tgas (members hold ~0.5 NEAR).

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
