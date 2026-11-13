# Sealed Calls — audit and fixes

The audit below was done on 2026-11-13 against commit `157285e`. The fixes landed in the commits after it; this table is the current status.

| ID | Finding | Status | Fix |
| --- | --- | --- | --- |
| F1 | Contract-paid storage drains escrow | **Fixed** | `share_signals` pays from the creator's prepaid credit (`deposit_storage` / `withdraw_storage`); `register_key`, `reveal`, `mark_unrevealed`, `settle` take a deposit for their storage; `claim_refund` deducts its record's storage from the refund; scoring keeps a small storage fee from its deposit; plans must cost ≥ 0.001 NEAR. `free_balance` view for monitoring |
| F2 | 30-min grace → anyone flips a winning call to −100% | **Fixed** | grace ≥ 24 h enforced in the contract (`MIN_GRACE_MIN`); deployed config 1440 |
| F3 | Owner can swap scorer / OutLayer / rules instantly | **Mitigated** | `set_config` is delayed 24 h (`pending_config`, `apply_config`, shown in the app); OutLayer account and period length can't change. The full-access key on `app.to69.testnet` remains during the hackathon (see README, Honest limits) |
| F4 | DEX floor/costs use current liquidity, on another pool | **Fixed in part** | floor and both-side costs now use the candle pool itself; liquidity is still read at scoring time (no free historical source) — documented |
| F5 | Subscribers may get a different call than committed | **Fixed (app)** | Feed shows a red "Don't trade this" warning and hides the levels on a hash mismatch |
| F6 | One bad subscriber key blocks posting | **Fixed** | contract validates keys (base64, 32 bytes, not small-order); app wraps each reader separately and never fails on one key |
| F7 | `Settling` can get stuck forever | **Fixed** | at most 10 unscored signals per settle; a settlement can be restarted after 15 min; a late, stale answer can't finish the period |
| F8 | Failed transfers booked as paid | **Fixed** | refund failure restores the claim; payout failure is kept as `owed` (`withdraw_owed`, shown in the app) |
| F9 | Quote tokens checked by symbol | **Fixed** | by address on Solana, Ethereum, Base, BSC, Arbitrum; symbol fallback on other networks (documented) |
| F10 | Release rule rewards variance / filler calls | **Fixed in part** | `min_signals` counts only filled calls; all-or-nothing payout and clip asymmetry remain a documented product decision |
| F11 | One scoring error fails the batch; livelock | **Fixed** | the job reports per-signal `failed` (and a 120 s time budget); the contract keeps what was scored; the keeper picks a random batch with ≤ 3 DEX signals |
| F12 | Plan can change under a pending subscribe | **Fixed** | `subscribe(…, expect_days, max_price)`; the app passes both |
| F13 | `stats.filled` counts no-fill outcomes | **Fixed** | first word of the outcome, all eight no-fill outcomes |
| F14 | Truncated score decides release | **Fixed** | release on Σr > 0 |
| F15 | Key rotation locks a member out of live calls | **Fixed** | a rotated key drops the old wraps on live calls so the desk re-shares them |
| F16 | Long calls delay later refunds | **Fixed** | a call counts in the period it ends |
| F17 | Score depends on when scoring runs | **Mitigated** | keeper scores within the hour; candle size is reported in the outcome; liquidity part covered by F4 |
| F18 | "One lucky call can't top the board" | **Fixed** | copy now says the score dampens lucky calls and gives the +50% example |
| F19 | `?contract=` override phishing | **Fixed** | red banner whenever the link points the app at another contract |
| F20 | localStorage keys, CI supply chain, npm advisories | **Mitigated** | testnet workflow pins actions by commit and near-cli / cargo-near by version; keys in localStorage and the transitive npm advisories (wallet-selector tree) remain, documented |
| F21 | Small items | **Fixed** | daily limit per creator across channels; keeper pages through all signals; KPI inflation by self-subscription remains (documented) |

Tests: contract 41 → 58 unit tests (one or more per finding), scorer 13 → 15.

---

## The audit (as delivered, before fixes)

2026-11-13 · audit only, nothing was changed · code at commit `157285e` (main)

## Scope and method

I read every source file:

- **Contract:** `contract/src/lib.rs`, 1,252 lines.
- **Scorer:** `scorer/src/lib.rs` and `main.rs`.
- **Web app:** `web/src`, including the crypto, Desk, Feed, Channel, data and near files.
- **Scripts:** `scripts/testnet.sh` and `sc.mjs`.
- **Workflows:** all three, `testnet.yml`, `ci.yml` and `pages.yml`.

The flows I traced end to end: post → wrap/tlock → subscribe → late share → reveal or mark unrevealed → score → settle → release or refund.

**What I ran (read-only):**

- `cargo test` (contract): **41 passed**.
- `cargo test --lib` (scorer): **13 passed**.
- `tsc --noEmit` (web): clean.
- `npm audit --omit=dev` (web): 21 issues (5 high, 16 low), all transitive.
- A local libsodium check: `crypto_box_seal` **throws** on an all-zero and on a low-order 32-byte public key, and `atob` throws on invalid base64.

**What I did not do:**

- No transactions, deploys or config changes.
- No live RPC reads, because this sandbox can't reach NEAR RPC. The deployed config values come from `scripts/testnet.sh` line 31 (`grace_min 30`, `min_signals 1`, `max_signals_per_day 10`, floor $100k, owner `to69.testnet`). Confirm them on-chain with `get_config`.
- Vercel dashboard settings: not in the repo, so not audited.

**Severity scale.** Ratings assume the stated goal of real subscription money. The current testnet deployment holds only test NEAR, so nothing below is a loss of real funds today.

**How to read the statuses:**

- **Confirmed:** follows directly from the code, with an exact path.
- **Likely:** depends on an external behaviour I couldn't test here.
- **Potential:** a theoretical design concern.

## Summary

| ID | Title | Severity | Status |
| --- | --- | --- | --- |
| F1 | Contract-paid storage is paid out of subscribers' escrow (share_signals, register_key, reveal…) | High | Confirmed |
| F2 | 30-min grace: anyone can mark an honest winning call "unrevealed" (−100%) before the keeper runs | High | Confirmed |
| F3 | Owner can swap scorer / OutLayer account / rules at any time; contract is upgradable | High (real funds) / Info (testnet) | Confirmed |
| F4 | DEX floor and costs use current liquidity; floor checked on a different pool than the candles | High | Confirmed |
| F5 | Subscribers' decrypted copy isn't required to match the commitment (UI only hides a ✓) | Medium | Confirmed |
| F6 | One subscriber with a bad key blocks the creator from posting and late sharing | Medium | Confirmed |
| F7 | A period stuck in `Settling` can never be unstuck → every later period frozen | Medium | Potential |
| F8 | Failed transfers are booked as paid (refund/release lost) | Medium | Confirmed |
| F9 | Quote-asset check is by symbol (fake "USDC" pools count) | Medium | Likely |
| F10 | Release rule rewards variance: min_signals = 1, −100%/+300% clip, filler calls | Medium | Confirmed (design) |
| F11 | Scoring can livelock: one transport error / GT rate limit fails the whole batch | Medium | Potential |
| F12 | Subscribe race: creator can change plan days between signing and execution | Low | Confirmed |
| F13 | Contract `stats.filled` counts no-fill outcomes (Finding B) | Low | Confirmed |
| F14 | Release uses truncated score: a small positive record counts as not positive | Low | Confirmed |
| F15 | Key rotation locks a member out of live signals | Low | Confirmed |
| F16 | Long validity delays every later period's refunds (≤ 30 days + grace) | Low | Confirmed (design) |
| F17 | Scores depend on when scoring runs (candle size, liquidity, data) | Low | Confirmed |
| F18 | "One lucky call can't top the board" is not true | Low | Confirmed |
| F19 | `?contract=` URL override enables look-alike phishing links | Low | Confirmed |
| F20 | Keys in localStorage; CI supply chain around the signing key; npm advisories | Low/Info | Confirmed |
| F21 | Small items: per-channel daily limit, keeper reads 100 signals, no funding costs, liquidation approximation, self-subscription inflates KPIs | Info | Confirmed |

---

## 1. Confirmed security vulnerabilities

### F2 — 30-minute grace lets anyone flip a winning call to −100%

- **Severity:** High. **Status:** Confirmed.
- **Where:**
  - `contract/src/lib.rs` 655–665 (`mark_unrevealed`: anyone, once `now ≥ opens_at + grace`).
  - Deployed `grace_min: 30` (`scripts/testnet.sh` 31).
  - Keeper schedule `7,37 * * * *` (`.github/workflows/testnet.yml` 18).
- **Behaviour:** after a call ends, nobody is obliged to reveal it; the keeper reveals on its next run. After 30 minutes **anyone** can call `mark_unrevealed`, which records r = −100% permanently.
- **Exploit:**
  1. A subscriber watches a channel whose period is going well.
  2. A call ends at 10:08. The keeper runs at 10:37 at best. GitHub often delays or drops scheduled runs.
  3. At 10:38, if it is still sealed, the subscriber calls `mark_unrevealed`.
  4. The call scores −100%, the period's Σr turns negative, and the held half becomes refundable to them.
- **Impact:** a subscriber takes the creator's held half and destroys an honest creator's public record. It costs gas only.
- **Preconditions:** no reveal within 30 minutes of the end (keeper late, drand slow, or creator offline).
- **Fix direction:** make grace long (24–72 h, as the v1 design said). Or allow `mark_unrevealed` only once the drand round has demonstrably passed by hours. Or let the creator's own app reveal automatically. Keep the keeper as a backstop, not the only revealer.
- **Safe test:** unit test: post, advance the clock to end + grace + 1 ms, call `mark_unrevealed` from an unrelated account, and assert it succeeds and the period refunds. Then raise grace and assert it fails before 24 h.

### F1 — Contract-paid storage is paid out of subscribers' escrow

- **Severity:** High. **Status:** Confirmed.
- **Where:** `lib.rs`:
  - 484–518 `share_signals`: no deposit; each new wrapped key is pushed at 510.
  - 596–602 `register_key`.
  - 622–652 `reveal`: stores the body.
  - 605–615 `claim_refund`: `claimed` entries.
  - 690 and 1033 period records.
  - None of these charge storage. Escrow and storage stake share one account balance, and there is no reserve or solvency check.
- **Behaviour:** NEAR locks storage stake from the contract's own balance, and that balance *is* the held halves.
- **Exploit (cheapest path):**
  1. Create a channel with a free plan. `validate_channel` (1169–1178) allows price 0.
  2. Subscribe 100 sybil accounts. Each pays only its own small subscribe storage.
  3. Post up to 10 signals a day while the sybils have no key, so posting costs little.
  4. The sybils register keys (free).
  5. Call `share_signals` with up to 20 signals × 100 members. The contract accepts any key string up to 160 chars and never checks it, so that is about 2,000 entries of about 230 bytes, roughly **4–5 NEAR of storage per call**, paid by the contract.
  6. Repeat across channels and days.
- **Impact:** once storage stake reaches the escrowed amount, refund and release transfers fail (see F8). Subscribers of **all** channels lose money. The attacker's cost is far below the drain.
- **Fix direction:**
  - Charge storage to the caller (`share_signals` and `register_key` take a deposit).
  - Or keep a separate storage budget per channel, funded by its creator.
  - Add an invariant check: balance − storage stake ≥ total escrow.
  - Require plan price > 0.
- **Safe test:** a near-workspaces sandbox test that loops `share_signals` and asserts the contract balance minus locked storage never drops below the sum of `period_held` across channels plus unclaimed refunds.

### F4 — DEX scoring uses current liquidity, and the floor is checked on a different pool (Finding A, confirmed and broader)

- **Severity:** High. **Status:** Confirmed.
- **Where:**
  - `scorer/src/main.rs` 63–90.
  - `scorer/src/lib.rs` 306–315 (`pick_pool`) and 356 (`reserve_in_usd` read from the current API response).
- **Behaviour:**
  - `now_pool` is the deepest pool **now**, of any age. The floor is checked on it (65–68).
  - Candles come from `pool`: the deepest pool *that existed at post time*, ranked by **current** liquidity (69).
  - Entry cost uses `pool`'s current liquidity; exit cost uses `now_pool`'s (90).
  - Liquidity at posting is never recorded anywhere.
- **Answers to the brief's questions:**
  - Is liquidity at publication recorded? **No.**
  - Can liquidity added after the signal qualify a pool? **Yes.**
  - Can current liquidity satisfy a historical floor? **Yes.**
  - Can a signal be penalised because liquidity left later? **Yes** (`below_floor`, −100%).
  - Are entry and exit liquidity distinguished? **Only nominally:** both are current values.
- **Exploit:**
  1. The creator runs a thin pool, paired with SOL or USDC, created before the post.
  2. They post a long with a tight range and TP.
  3. During validity they push closes in their own thin pool (cheap, little liquidity) to fill and then hit the TP.
  4. Right after the call ends they add ≥ $100k of liquidity, or ≥ $10k for `gecko_micro`, so it becomes the deepest pre-existing pool, passes the floor and shows a tiny price impact.
  5. They call `score_signals` themselves (anyone can).
  6. They then withdraw the liquidity.
- **Variant:** a deep pool created *after* the post passes the floor, while candles still come from the old thin pool.
- **Impact:** a fabricated winning record and the held halves released. Micro-cap rules (two closes, median exit) make it harder but not impossible.
- **Fix direction:**
  - Snapshot the pool and its liquidity at posting: client-provided and checked, or a scoring job run at post time.
  - Floor-check the **same** pool the candles come from, using its liquidity at post and through the window. GeckoTerminal OHLCV volume can serve as a proxy.
  - Score at a fixed time after the end, not whenever someone calls.
- **Safe test:** unit tests on `pick_pool` and the floor logic with crafted pool lists (old thin pool + new deep pool → expect below floor or the new pool). Scorer replay tests on recorded JSON.

## 2. Confirmed functional bugs

### F6 — One subscriber can block the creator from posting

- **Severity:** Medium. **Status:** Confirmed.
- **Where:**
  - `lib.rs` 597: the key check is only "44 chars ending in `=`".
  - `lib.rs` 424–433: the post must wrap to **every** reader.
  - `web/src/crypto.ts` 48 (`crypto_box_seal` per reader) and 146–149 (`wrapFor`).
  - `web/src/pages/Desk.tsx` 212–215 and 375–386.
- **Exploit:** a subscriber registers `AAAA…A=` (32 zero bytes) or a string with invalid base64. libsodium throws (verified locally), so `seal()` throws and the Desk can't post. The late-share pass also throws for everyone.
- **Impact:** the creator can't post until that subscription expires, unless they hand-craft a transaction. It is griefing for the price of one subscription.
- **Fix direction:**
  - Validate the key in the contract: decode base64, require 32 bytes, reject low-order points.
  - In the web app, wrap per reader in try/catch and send a placeholder for broken keys.
  - Or let the contract accept posts that skip readers with invalid keys.
- **Safe test:** a contract unit test that `register_key` rejects zero and invalid keys; a web unit test that `seal` survives one bad reader.

### F12 — Subscribe race on plan terms

- **Severity:** Low. **Status:** Confirmed.
- **Where:** `lib.rs` 531 reads `plans[plan]` at execution; `update_channel` (383–398) can change it.
- **Scenario:** the creator changes plan 0 from 30 days to 1 day while subscribers' transactions are in flight. Same price, fewer days. A higher price fails safely; fewer days does not.
- **Fix direction:** `subscribe(channel, plan, expected_days, max_price)`.
- **Test:** unit test that changes the plan between building and executing the call.

### F13 — `stats.filled` counts no-fill outcomes (Finding B)

- **Severity:** Low. **Status:** Confirmed, and still present.
- **Where:** `lib.rs` 995–1001.
- **Behaviour:** the code excludes only `not_filled | invalid | unrevealed | below_floor | no_market`, as exact strings. These are counted as filled:
  - `no_data`
  - `no_trades`
  - `no_pool_at_post`
  - any coarse-candle outcome, because the scorer appends a suffix (`"not_filled (15m)"`, `scorer/src/lib.rs` 268).
- **Impact:** limited. Payouts and rankings don't use `stats.filled`. The web app computes its own, correct count (`web/src/data.ts` 72: it strips the suffix and excludes all eight outcomes). Anyone reading the contract view directly gets a wrong figure.
- **What "filled" means:** the scorer saw a close inside the entry range.
- **Fix direction:** compare the first word of the outcome, or store `filled: bool` returned by the scorer.
- **Test:** a unit test with each outcome string.

### F14 — Truncated score decides release

- **Severity:** Low. **Status:** Confirmed.
- **Where:** `lib.rs` 1003 and 1045–1048.
- **Behaviour:** `score = sum / (n+5)` uses integer division. With Σr = +3 bps and n = 1, score is 0, so the period is not released even though the record is positive.
- **Fix direction:** release on `sum > 0` (equivalent, without truncation).
- **Test:** `period_score(&[3])` → assert released.

### F15 — Rotating a key locks a member out of live signals

- **Severity:** Low. **Status:** Confirmed.
- **Where:** `lib.rs` 506–508 skips members who already have *any* wrapped key; `Desk.tsx` 381 filters the same way.
- **Scenario:** a member clears their browser, sets up a new key, and still can't read live signals until they open.
- **Fix direction:** allow replacing a wrapped key when the member's registered pubkey changed (store the pubkey, or a hash of it, with each wrapped key).

## 3. Likely vulnerabilities requiring more verification

### F9 — Quote-asset whitelist by symbol

- **Severity:** Medium. **Status:** Likely.
- **Where:** `scorer/src/lib.rs` 31–34 and 350.
- **Behaviour:** a pool counts if the other token's **symbol** is in `MAJORS`. Anyone can mint a token named "USDC" or "SOL".
- **What needs verifying:** how GeckoTerminal computes `reserve_in_usd` for such pools. If it values the fake side at about $1, a fake pool can pass the floor and supply candles.
- **Fix direction:** whitelist quote **addresses** per network.
- **Safe test:** query GeckoTerminal read-only for a known fake-USDC pool and compare its reserve with real liquidity.

### F7 — `Settling` can become permanent

- **Severity:** Medium. **Status:** Potential.
- **Where:** `lib.rs` 690–697 (sets `Settling`), 46 (callback gas fixed at 80 Tgas), 754–786 (`on_scores` applies every score, then `finish_period`, which reads every signal of the period twice).
- **Behaviour:** if the callback runs out of gas, its changes revert but `Settling` remains. Nothing can clear it: no timeout, no owner method. That period and every later one can then never settle, so refunds and releases freeze for that channel.
- **Trigger:** `settle` called while many of the period's signals are still unscored. Anyone can call it at period end, before the keeper scores in batches of 10. Large signals cost about 1 Tgas each in reads and writes.
- **Fix direction:**
  - Cap `to_score` (for example ≤ 10) or require all signals to be scored before settling.
  - Add a `Settling` timeout that anyone can reset.
  - Keep `finish_period` light (store `r_bps` per period).
- **Safe test:** a near-workspaces sandbox that posts N max-size signals, calls settle with a mocked OutLayer, and measures callback gas.

### F11 — Scoring livelock

- **Severity:** Medium. **Status:** Potential.
- **Where:**
  - `scorer/src/main.rs` 38: one `Err` fails the whole batch.
  - `scorer/src/main.rs` 98–118: a 2.5 s pace, plus 10/20/30/40 s backoff, against a 180 s limit.
  - `scripts/testnet.sh` 68: the keeper always takes the *first* 10 unscored signals.
- **Scenario:** 10 DEX signals need at least 20–40 paced requests. Under GeckoTerminal 429s the job exceeds 180 s and fails, and the next run retries the same batch.
  - Signals are never scored, so periods never settle and refunds wait.
  - A non-200/404/429 response (for example 400/403 or an HTML challenge) for one market fails its batch every time.
- **Fix direction:**
  - Score one or two DEX signals per job.
  - Return per-signal `error` results instead of failing the batch.
  - Rotate batches in the keeper.
  - Add a rule for permanently unscorable signals, such as `no_data` → 0% after N attempts.

## 4. Cryptographic and timelock concerns

### What holds

- **Binding.** The commitment is sha256 over the exact plaintext bytes; `reveal` (622–652) accepts only those bytes, so a posted call can't be changed. The payload binds channel, creator and validity, which are checked at reveal (630), so copying another creator's commitment scores −100%.
- **Hiding.** A 16-byte random salt (`crypto.ts` 29) means content can't be brute-forced.
- **Serialization.** Hashing raw bytes means no canonicalization ambiguity. Duplicate JSON keys make serde reject the payload, so a creator can't make the UI and the contract disagree to their own benefit.
- **Timing.** `reveal` is gated by **block time** (626), not by drand, so nobody can publish early on-chain. `check_round` (1063–1069) uses the correct quicknet genesis (1692803367) and 3 s period, and the round must fall in [end, end + 120 s].
- **drand trust.** Beacon authenticity doesn't matter for integrity: a wrong beacon can't decrypt, and any plaintext still has to hash to the commitment.
- **Withholding.** A creator can't hide a losing call, because unrevealed means −100%.

### F5 — Subscribers may receive a different call than the committed one

- **Severity:** Medium. **Status:** Confirmed.
- **Where:** `web/src/crypto.ts` 54–61 (`opened()` returns the body whether or not it matches) and `web/src/pages/Feed.tsx` 125–130 (renders it; a mismatch only hides the ✓).
- **Behaviour:** the contract can't check `member_ct` or `tlock_ct`. A creator can encrypt call X for subscribers and commit call Y for the public record. Subscribers trade X; the record shows Y.
- **Impact:** the public record isn't what subscribers were sold. This is the core promise of the product.
- **Fix direction:**
  - Treat a mismatch as an error in the Feed: show a red warning, hide the trade levels.
  - Optionally let subscribers flag it on-chain (prove the mismatch by revealing the decrypted text, which fails the hash, then record a flag).
- **Test:** a web unit test with a forged `member_ct`.

### Other notes

- **tlock round not verifiable on-chain (Info).** The contract can't check which round `tlock_ct` targets. A creator could use an earlier round, which leaks to the public early and hurts their own subscribers, or a far-future or garbage round, which nobody can open from drand, so subscribers must reveal or it scores −100%.
- **drand availability (Info).** Reveal depends on drand HTTP relays and on the keeper. Combined with F2, a 30-minute outage harms honest creators.
- **Late-access keys (Info).** Each signal key is HMAC(creator secret, commit), and the secret sits in localStorage (`crypto.ts` 105–125). Any XSS or compromised dependency on the app's domain exposes every live signal of every creator who used that browser. Member private keys are stored the same way.
- **Leaks by subscribers (Info).** Leaks can't be prevented; this is already disclosed in the README.

## 5. Fund custody and accounting

### Verified safe in code (Finding C)

- **Split.** `held = price − price/2` (544). It is spread by time overlap with `share()` (965–971) into `partial` for the first and last period and `diff` for full periods. Rounding dust goes to the creator. There is no overflow: the u128 terms stay far below the limit.
- **Refunds equal what was held.** `claimable` (881–909) uses the same `share()` per subscription and period, so the sum of refunds equals that period's held amount.
- **Double claims.** `claimed[(channel, period, member)]` prevents claiming twice (610). Tested.
- **Refund and payout are exclusive.** A period is released *or* refundable, never both (1003, 898).
- **Settlement order.** Periods settle strictly in order (`next_period`). There is no double settlement or double scoring: `r_bps` is set once (743, 781), and `score_signals` refuses already-scored signals (716).
- **Access control.**
  - Callbacks are `#[private]`.
  - Only the creator posts and shares.
  - Only the member claims their own refund.
  - The owner only changes config.
- **Deposit order.** The deposit check comes after state changes, which is fine: the whole receipt reverts if it fails.
- **Malicious callers.** A subscriber or creator can't withdraw others' funds or manipulate period IDs, which are derived from block time.

### F8 — Failed transfers are booked as paid

- **Severity:** Medium. **Status:** Confirmed.
- **Where:** `lib.rs` 613, 1018 and 583 (`Promise::transfer(...).detach()` with no callback).
- **Behaviour:** if a transfer fails, the claim is still marked done or the period is still marked released. Causes: the F1 balance shortfall, or a deleted recipient account. The money stays in the contract with no accounting.
- **Fix direction:** add a callback that restores `claimed` on failure, or a pull-based withdrawal balance.

### F3 — Owner and upgrade centralization

- **Severity:** High for real funds; Info for the testnet. **Status:** Confirmed.
- **Where:** `set_config` (340–348) lets the owner change all of these at any time, applying to pending periods too:
  - `scorer_wasm_url` and `scorer_wasm_hash`
  - the **`outlayer` account** (it could point to a contract that returns any scores)
  - `min_signals`, `grace_min` (for example 0, which means instant −100%), the liquidity floor and `reference_usd`
- **Upgrade risk:** `app.to69.testnet` still has a full-access key, so its code can be replaced, including code that sends the escrow anywhere. The owner `to69.testnet` is also an active creator.
- **Fix direction:** before real money:
  - Lock the contract, or put it behind a DAO or timelock.
  - Make the `outlayer` account immutable.
  - Apply config changes only to periods that start after the change.

### F16 — Long validity delays refunds

- **Severity:** Low (design). **Status:** Confirmed.
- **Where:** `settle` waits for every signal of the period (680–682), and periods settle in order.
- **Scenario:** a 30-day call posted on day 1 holds day 1's settlement, and therefore every later day's, for up to 30 days plus grace. Funds aren't lost, but refunds are slow.
- **Fix direction:** cap validity relative to the period length, or settle periods independently.

### Gas bounds (Info)

`claimable` is O(periods² × subscriptions) because `ps.contains` runs inside the loop, and every claim re-reads all past periods. It is fine with weekly periods, but with daily periods and long or many subscriptions it grows without limit.

## 6. Scoring methodology and data integrity

The main scoring issues, F4, F9 and F11, are covered above.

### F10 — The release rule rewards variance, not skill

- **Severity:** Medium (design). **Status:** Confirmed.
- **Where:** `lib.rs` 1003, `scorer/src/lib.rs` 254–264, and deployed `min_signals = 1`.
- **Behaviour:**
  - Release depends only on Σr > 0 in the period. SHRINK changes the displayed number, not the sign.
  - Losses clip at −100% while gains clip at +300%, with leverage up to 50x.
  - With `min_signals = 1`, one 50x lottery call decides the whole period.
  - Calls that never fill score 0% and still count, so `min_signals` can be met with deliberately unfillable calls.
- **Fix direction:**
  - Require min_signals ≥ 3–5 *filled* calls.
  - Release proportionally (for example by S) rather than all-or-nothing.
  - Use symmetric clipping or cap leverage for scoring.
  - Consider a risk-adjusted score.

### F17 — The score depends on when scoring runs

- **Severity:** Low. **Status:** Confirmed.
- **Behaviour:** results change with the scoring time:
  - Hyperliquid candle size depends on the signal's age (`hl_interval`, 140–143); after about 3.4 days 1-minute candles are gone.
  - DEX liquidity and costs are read at scoring time (F4).
  - GeckoTerminal history can change.
- **Who controls it:** anyone, including the creator, can choose the moment by calling `score_signals`.
- **Fix direction:** score in a fixed window after the end, and record the data snapshot used.

### Methodology checks that hold

- **No look-ahead.** Candles must start at or after the post and end by expiry (`window`, 152–161).
- **Entry.** The fill is the first close inside the range.
- **TP and SL.** TP exits at the TP level and SL exits at the close, which is conservative. Liquidation is checked on wicks before SL or TP.
- **Shorts.** They mirror longs correctly (tested).
- **Costs.** Fees are charged × leverage on both sides.

### Approximations and data issues (Low/Info)

- No funding costs for perps; this matters for long, high-leverage holds.
- Liquidation ignores maintenance margin, so it is optimistic.
- No partial fills or position sizing; the $500 reference applies to DEX impact only.
- Gaps are left as gaps (missing minutes omitted) and candles are de-duplicated by timestamp.
- `no_data` and `no_trades` score 0% rather than a loss; a market that stops trading is neutral for the creator.
- Hyperliquid markets outside the main `meta` universe (HIP-3 `dex:COIN`) score `no_market`, −100%.
- Survivorship: a pool that is rugged or migrated before scoring scores `below_floor` (−100%) even if the call was fine at the time.
- Subscribers' held halves for period p are released by calls posted in p, including to members who joined after those calls ended.
- Joining late in a period that is already clearly negative refunds that share (minor timing game).

## 7. Frontend, backend and deployment

### F18 — Ranking copy overclaims

- **Severity:** Low. **Status:** Confirmed.
- **Where:** `web/src/pages/Explore.tsx` 146 says "one lucky call can't top the board"; README 119 says something similar.
- **Why it's wrong:** a single +300% call scores 300/6 = +50%, which beats 30 calls averaging +10% (300/35 ≈ 8.6%).
- **Fix direction:** reword ("dampens"), or rank with a minimum number of calls. This matters under the "never overclaim" rule.

### F19 — `?contract=` override

- **Severity:** Low. **Status:** Confirmed.
- **Where:** `web/src/config.ts` 5; the wallet sign-in uses `contractId: CONTRACT` (`near.ts` 72).
- **Scenario:** a link like `sealed-calls.vercel.app/?contract=evil.testnet` renders the genuine UI against an attacker's contract, and subscribe deposits go there. The wallet does show the receiver.
- **Fix direction:** an allowlist, or a visible banner whenever the override is active.

### F20 — Key storage, CI and dependencies

- **Severity:** Low/Info. **Status:** Confirmed.
- **Browser storage:** creator secrets and member keys live in localStorage (see section 4). React escapes everything, and I found no `dangerouslySetInnerHTML`. External links use fixed hosts.
- **CI around the signing key:**
  - `testnet.yml` runs with `contents: write` and the testnet signing key in the same job.
  - It installs near-cli and cargo-near with `curl | sh` from "latest" releases.
  - It uses actions pinned by tag, not SHA (`dtolnay/rust-toolchain@stable`).
  - That is acceptable for a testnet key; it would not be for a mainnet key.
  - The key is never printed: the public logs on `testnet-results` contain no `ed25519:` secret.
- **npm audit:** 21 advisories (5 high: `decode-uri-component`, `nanoid`, `elliptic`, …). All come through the wallet-selector dependency tree, and the practical impact in a browser dapp is low.
- **Backend:** there is no backend API. Reads go straight to public RPCs, DexScreener and GeckoTerminal with no secrets. All write authority lives in the contract.
- **Hardcoded values:** contract `app.to69.testnet`, the RPC list and `outlayer.testnet` are testnet values.

### F21 — Smaller items

- **Severity:** Info. **Status:** Confirmed.
- **Daily limit per channel:** it is keyed per channel (`lib.rs` 435), not per creator. More channels means more calls.
- **Keeper sees 100 signals:** `list_signals limit 100` means older signals in a big channel are ignored.
- **Self-subscription:** a creator can subscribe to their own channel from other accounts, inflating subscriber counts and "paid to traders" (Explore KPIs) at little net cost.
- **Posting race:** a post fails if the reader set changes between building and executing it (a new subscriber, an expiry). It reverts safely but can be used for annoyance (see F6).

## 8. Missing tests and coverage gaps

The 41 contract tests and 13 scorer tests cover the happy paths, the limits and double claims well. Missing:

- A solvency invariant: contract balance minus storage stake ≥ the sum of unsettled held amounts and unclaimed refunds, under fuzzed subscribe, share and claim sequences. **(F1, F8)**
- Contract-paid storage growth from `share_signals`, `register_key` and `reveal`. **(F1)**
- `mark_unrevealed` by a third party right after grace. **(F2)**
- Invalid or low-order `register_key` values; `seal()` with a bad reader. **(F6)**
- Settle with many unscored signals: callback gas and recovery from `Settling`. **(F7)**
- Failed transfer handling. **(F8)**
- Outcome-string classification, including the " (15m)" suffix. **(F13)**
- Small positive Σr released. **(F14)**
- Key rotation during a live signal. **(F15)**
- Scorer:
  - pool selection with old-thin plus new-deep pools (F4)
  - fake-symbol quotes (F9)
  - batch failure isolation (F11)
  - recorded-response replays from GeckoTerminal and Hyperliquid
- Web: Feed behaviour on a commitment mismatch (F5); the `?contract` override (F19).
- Integration tests (near-workspaces sandbox) instead of unit-only `testing_env`, so gas, storage and promise failures are measured.

## 9. Previously identified issues: status now

- **Finding A (historical scoring uses current liquidity):** **Confirmed, and broader.** The floor is checked on a different pool from the one supplying the candles, and costs use current liquidity on both sides (F4).
- **Finding B (filled statistics):** **Confirmed in the contract.** `stats.filled` includes no_data, no_trades, no_pool_at_post and suffixed outcomes. **Not present in the web app,** which computes filled correctly and doesn't use the contract figure. Payouts and rankings are unaffected (F13).
- **Finding C (fund custody):** **no drain or refund theft through the accounting itself.** It is exact and double-claim safe. But funds are at risk through storage (F1), unhandled transfer failures (F8), owner powers (F3) and a stuck `Settling` (F7).

## Conclusions

### Top 5 by practical risk

1. **F2** — anyone can turn a winning call into −100% after 30 minutes and take the held half.
2. **F1** — contract-paid storage lets a creator drain everyone's escrow.
3. **F4** — DEX scores can be manufactured with temporary liquidity on a thin pre-existing pool.
4. **F3** — the owner can change the scorer, the OutLayer account and the rules, or upgrade the contract.
5. **F5** — subscribers can be sold a different call from the one on the public record.

### The six questions

- **Are user funds adequately protected?** For testnet, yes: the accounting is exact and no direct theft path exists. **For real money, no.** F1, F8 and F3 can make escrow unrecoverable or redirect it, and F7 can freeze it.
- **Can providers manipulate scores?** **Yes, for DEX tokens (F4, F9),** and they can farm the release rule with variance and filler calls (F10). Perp (Hyperliquid) scores are hard to manipulate, because data comes from a deep venue and candle timing is fixed.
- **Can subscribers be unfairly denied refunds?** **Mostly through delays and freezes,** not denial: a stuck `Settling` (F7), scoring livelock (F11), long validity (F16), or transfer failures losing a claim (F8). The reverse also exists: subscribers can unfairly *gain* refunds (F2).
- **Does the cryptographic reveal achieve its guarantees?** **Binding and hiding: yes.** Calls can't be edited or deleted, and can't be read early from the contract or drand. **What subscribers decrypt is not guaranteed to be the committed call (F5).** Liveness depends on the keeper or drand within a 30-minute grace (F2).

### Must fix before accepting real payments

- F1: storage paid by the caller, plus a solvency invariant.
- F2: a long grace and automatic reveal.
- F3: lock or govern the contract; fix the OutLayer account.
- F4 and F9: pool and liquidity snapshot at post; address whitelist.
- F5: hard-fail a mismatch.
- F6: key validation.
- F7: recoverable `Settling`.
- F8: transfer callbacks.
- F11: per-signal scorer errors and small batches.
- Integration tests for all of the above.

### Can wait

- F10: payout design, which needs a product decision.
- F12–F19: small bugs and copy.
- Funding and maintenance-margin realism.
- KPI inflation from self-subscription.
- Dependency bumps.

For the hackathon (testnet), F18 is the only item that conflicts with the project's "never overclaim" rule. F2 is the one most likely to hit a live demo channel by accident. Everything else is accurate for a testnet demo and belongs in the README's honest-limits section.
