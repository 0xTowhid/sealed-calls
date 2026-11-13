//! Sealed Calls v2 — trading signals with a record nobody can edit, and subscriptions that only
//! pay the creator in full when the signals work.
//!
//! * Anyone creates a channel and sets subscription plans (price per number of days).
//! * A subscription pays 50% to the creator at once. The other 50% is spread over the periods
//!   (weeks) it covers and held here. When a period settles, the creator receives that period's
//!   held half only if their signals posted in that period have a positive record; otherwise each
//!   subscriber can claim their part back.
//! * A signal is sealed when posted: subscribers active at that moment can decrypt it at once
//!   (per-signal key wrapped to each of them); everyone else can open it from drand when its
//!   validity ends. Its sha256 commitment is fixed on-chain, so it cannot be edited or hidden.
//! * Scoring runs in an OutLayer job (TEE) over public price data; the result comes back here.
//!
//! What this contract does not guarantee: that subscribers don't leak signals, that the creator
//! doesn't trade against subscribers, or that a $500 trade could really have been filled at the
//! scored prices. Scores are indicative.

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

/// drand quicknet (the chain tlock-js `mainnetClient()` uses): genesis and period in seconds.
pub const QUICKNET_GENESIS_S: u64 = 1_692_803_367;
pub const QUICKNET_PERIOD_S: u64 = 3;
/// The reveal round must fall within this many seconds after validity ends.
pub const ROUND_SLACK_S: u64 = 120;
pub const MIN_VALID_MIN: u32 = 15;
pub const MAX_VALID_MIN: u32 = 43_200; // 30 days
pub const MAX_MEMBERS: u32 = 100;
pub const MAX_PLANS: usize = 6;
pub const MAX_PLAN_DAYS: u32 = 366;
pub const MAX_SUBS_PER_MEMBER: usize = 64;
pub const MAX_TLOCK_CT: usize = 4_096;
pub const MAX_MEMBER_CT: usize = 2_048;
pub const MAX_WRAPPED_KEY: usize = 160;
pub const MAX_MSG_CHARS: usize = 280;
pub const MAX_LEVERAGE: u32 = 50;
pub const LOSS_BPS: i32 = -10_000;
pub const MAX_GAIN_BPS: i32 = 30_000;
/// Phantom flat signals added to every record: S = Σr / (n + SHRINK).
pub const SHRINK: i64 = 5;
const SCORE_CALLBACK_GAS: Gas = Gas::from_tgas(80);
const PAY_CALLBACK_GAS: Gas = Gas::from_tgas(10);
const DAY_MS: u64 = 86_400_000;
/// Nobody can mark a signal unrevealed sooner than this after it ends (time for anyone to reveal it).
pub const MIN_GRACE_MIN: u32 = 1_440;
/// Config changes wait this long once channels exist, so everyone sees them coming.
pub const CONFIG_DELAY_MS: u64 = DAY_MS;
/// A settlement whose scoring never came back can be restarted after this.
pub const SETTLE_TIMEOUT_MS: u64 = 15 * 60_000;
/// Signals a settlement may still have to score itself; more must be scored first (score_signals).
pub const MAX_SETTLE_SCORE: usize = 10;
/// Kept from a scoring deposit to pay for the storage the results take (the rest goes to OutLayer).
pub const SCORE_STORAGE_FEE: NearToken = NearToken::from_millinear(2); // per signal
pub const SETTLE_STORAGE_FEE: NearToken = NearToken::from_millinear(10);
/// Smallest plan price: free plans would let anyone fill a channel with throwaway subscribers.
pub const MIN_PLAN_PRICE: NearToken = NearToken::from_millinear(1);
/// How many of a channel's newest signals a key change looks through.
const KEY_ROTATION_SCAN: u32 = 50;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Channels,
    Signals,
    ChannelSignals,
    PeriodSignals,
    Members,
    Daily,
    Periods,
    Partial,
    Diff,
    Claimed,
}

// ------------------------------------------------------------------------------------ types

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Config {
    pub owner: AccountId,
    /// Length of a payout period. 10080 (one week) normally; shorter on demo deployments.
    pub period_minutes: u32,
    /// Minutes after a signal's validity ends before it can be marked unrevealed.
    pub grace_min: u32,
    /// Scored signals a creator needs in a period before its held half can be released.
    pub min_signals: u32,
    pub max_signals_per_day: u32,
    pub scorer_wasm_url: String,
    pub scorer_wasm_hash: String,
    pub outlayer: AccountId,
    /// Reference trade size for DEX price impact, and the DEX liquidity floor (USD).
    pub reference_usd: u32,
    pub liquidity_floor_usd: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub days: u32,
    pub price: NearToken,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub signals: u32,
    pub scored: u32,
    pub wins: u32,
    pub filled: u32,
    pub sum_bps: i64,
    pub periods_released: u32,
    pub periods_refunded: u32,
    /// Everything the creator received: immediate halves, released halves and rounding dust.
    pub earned: NearToken,
    /// Held halves that went back to subscribers (claimable).
    pub refundable: NearToken,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Channel {
    pub id: u32,
    pub creator: AccountId,
    pub name: String,
    pub about: String,
    pub plans: Vec<Plan>,
    pub max_members: u32,
    pub created_at_ms: u64,
    /// Accounts with a membership record (active or expired), at most `max_members` active.
    pub member_list: Vec<AccountId>,
    pub signal_count: u32,
    /// The next period to settle (periods settle in order).
    pub next_period: u64,
    /// Running sum of `diff` up to the last settled period.
    pub level: i128,
    pub stats: Stats,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Sub {
    pub start_ms: u64,
    pub end_ms: u64,
    /// The held half of this payment.
    pub held: NearToken,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Member {
    pub until_ms: u64,
    /// X25519 public key, base64 (44 chars).
    pub pubkey: Option<String>,
    pub subs: Vec<Sub>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct WrappedKey {
    pub member: AccountId,
    pub key: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SignalStatus {
    Sealed,
    Revealed { by: AccountId, at_ms: u64 },
    Unrevealed { at_ms: u64 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Market {
    /// "hyperliquid" (perps; `address` is the coin, e.g. "BTC"), "gecko" (a DEX token on
    /// GeckoTerminal; `network` e.g. "solana", `address` the token address) or "gecko_micro" (the
    /// same, scored with the micro-cap rules: lower liquidity floor, stricter TPs and exits).
    pub venue: String,
    #[serde(default)]
    pub network: Option<String>,
    pub address: String,
    pub symbol: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignalBody {
    pub market: Market,
    /// "long" or "short"
    pub side: String,
    pub leverage: u32,
    /// Decimal strings, USD.
    pub entry_low: String,
    pub entry_high: String,
    pub tps: Vec<String>,
    pub sl: String,
    pub msg: String,
}

/// What a revealed plaintext must be. The commitment covers its exact bytes.
#[derive(Deserialize, Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct SignalPayload {
    pub v: u8,
    pub channel: u32,
    pub creator: AccountId,
    pub valid_min: u32,
    pub market: Market,
    pub side: String,
    pub leverage: u32,
    pub entry_low: String,
    pub entry_high: String,
    pub tps: Vec<String>,
    pub sl: String,
    #[serde(default)]
    pub msg: String,
    pub salt: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Signal {
    pub id: u64,
    pub channel: u32,
    pub creator: AccountId,
    pub period: u64,
    pub posted_at_ms: u64,
    pub valid_min: u32,
    /// hex sha256 of the exact plaintext bytes that `reveal` must present.
    pub commit: String,
    pub reveal_round: u64,
    /// age-armored tlock ciphertext; opens at `reveal_round`.
    pub tlock_ct: String,
    /// The signal encrypted with a fresh per-signal key (for subscribers).
    pub member_ct: String,
    /// That key sealed to each active subscriber's X25519 key at posting time.
    pub wrapped_keys: Vec<WrappedKey>,
    pub status: SignalStatus,
    /// The revealed signal; None if sealed, unrevealed, or the revealed text was not a valid signal.
    pub body: Option<SignalBody>,
    pub r_bps: Option<i32>,
    /// Scorer outcome: "tp1", "tp3", "sl", "liquidated", "expired", "not_filled", "invalid", ...
    pub outcome: Option<String>,
    pub fill_price: Option<String>,
    pub exit_price: Option<String>,
    pub cost_bps: Option<i32>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum PeriodStatus {
    Settling,
    Settled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PeriodResult {
    pub status: PeriodStatus,
    pub signals: u32,
    pub sum_bps: i64,
    pub score_bps: i64,
    /// true: the held half went to the creator. false: subscribers can claim it back.
    pub released: bool,
    pub held: NearToken,
    pub settled_at_ms: u64,
}

/// One line of the scoring job's output.
#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct SignalScore {
    pub id: u64,
    pub r_bps: i32,
    pub outcome: String,
    #[serde(default)]
    pub fill_price: Option<String>,
    #[serde(default)]
    pub exit_price: Option<String>,
    #[serde(default)]
    pub cost_bps: Option<i32>,
}

#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct ScoreOut {
    pub ok: bool,
    pub results: Vec<SignalScore>,
    pub error: Option<String>,
    /// Signals the job could not score this time (data source down, time budget): retried later.
    #[serde(default)]
    pub failed: Vec<u64>,
}

/// A config change waiting for its delay.
#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct PendingConfig {
    pub config: Config,
    pub eta_ms: u64,
}

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    fn request_execution(
        &mut self,
        source: serde_json::Value,
        resource_limits: Option<serde_json::Value>,
        input_data: Option<String>,
        secrets_ref: Option<serde_json::Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<serde_json::Value>,
    );
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SealedCalls {
    config: Config,
    channels: Vector<Channel>,
    signals: Vector<Signal>,
    /// (channel, index within channel) -> signal id
    channel_signals: LookupMap<(u32, u32), u64>,
    /// (channel, period) -> signal ids posted in it
    period_signals: LookupMap<(u32, u64), Vec<u64>>,
    members: LookupMap<(u32, AccountId), Member>,
    /// (channel, creator's UTC day) -> signals posted
    daily: LookupMap<(u32, u64), u32>,
    periods: LookupMap<(u32, u64), PeriodResult>,
    /// Held amount of partly covered periods: (channel, period) -> yocto
    partial: LookupMap<(u32, u64), u128>,
    /// Difference array of fully covered periods: level(p) = Σ_{q<=p} diff(q)
    diff: LookupMap<(u32, u64), i128>,
    /// (channel, period, member) -> refund already claimed
    claimed: LookupMap<(u32, u64, AccountId), bool>,
}

#[near]
impl SealedCalls {
    #[init]
    pub fn new(config: Config) -> Self {
        validate_config(&config);
        Self {
            config,
            channels: Vector::new(Key::Channels),
            signals: Vector::new(Key::Signals),
            channel_signals: LookupMap::new(Key::ChannelSignals),
            period_signals: LookupMap::new(Key::PeriodSignals),
            members: LookupMap::new(Key::Members),
            daily: LookupMap::new(Key::Daily),
            periods: LookupMap::new(Key::Periods),
            partial: LookupMap::new(Key::Partial),
            diff: LookupMap::new(Key::Diff),
            claimed: LookupMap::new(Key::Claimed),
        }
    }

    /// Upgrade entry point: keeps all state and sets the config directly (the code upgrade itself is
    /// the trust step; afterwards every change goes through the delayed `set_config`).
    #[private]
    #[init(ignore_state)]
    pub fn migrate(config: Config) -> Self {
        let mut s: Self = env::state_read().expect("no state to migrate");
        validate_config(&config);
        assert_eq!(config.period_minutes, s.config.period_minutes, "period length is fixed");
        assert_eq!(config.outlayer, s.config.outlayer, "the OutLayer account is fixed");
        s.config = config;
        emit("migrated", json!({ "scorer_wasm_hash": s.config.scorer_wasm_hash }));
        s
    }

    /// The owner proposes a new config (e.g. a new scorer build). With channels live it takes effect
    /// only after CONFIG_DELAY_MS, via `apply_config` (anyone). Period length and the OutLayer
    /// account can never change once channels exist.
    pub fn set_config(&mut self, config: Config) {
        assert_eq!(env::predecessor_account_id(), self.config.owner, "only the owner");
        validate_config(&config);
        if self.channels.len() == 0 {
            self.config = config;
            emit("config_changed", json!({ "scorer_wasm_hash": self.config.scorer_wasm_hash }));
            return;
        }
        assert_eq!(config.period_minutes, self.config.period_minutes, "period length is fixed once channels exist");
        assert_eq!(config.outlayer, self.config.outlayer, "the OutLayer account is fixed once channels exist");
        let eta_ms = env::block_timestamp_ms() + CONFIG_DELAY_MS;
        env::storage_write(PENDING_CONFIG, &serde_json::to_vec(&PendingConfig { config: config.clone(), eta_ms }).unwrap());
        emit("config_proposed", json!({ "config": config, "eta_ms": eta_ms }));
    }

    /// Anyone applies a proposed config once its delay has passed.
    pub fn apply_config(&mut self) {
        let p = self.pending_config().expect("no config change pending");
        assert!(env::block_timestamp_ms() >= p.eta_ms, "the config change applies from {}", p.eta_ms);
        env::storage_remove(PENDING_CONFIG);
        self.config = p.config;
        emit("config_changed", json!({ "scorer_wasm_hash": self.config.scorer_wasm_hash }));
    }

    pub fn cancel_config(&mut self) {
        assert_eq!(env::predecessor_account_id(), self.config.owner, "only the owner");
        env::storage_remove(PENDING_CONFIG);
        emit("config_cancelled", json!({}));
    }

    pub fn pending_config(&self) -> Option<PendingConfig> {
        env::storage_read(PENDING_CONFIG).and_then(|v| serde_json::from_slice(&v).ok())
    }

    // ---------------------------------------------------------------- storage credit
    // Late access (`share_signals`) runs without a wallet prompt, so it can't attach a deposit.
    // Its storage is paid from the creator's prepaid credit — never from subscribers' escrow.

    #[payable]
    pub fn deposit_storage(&mut self) -> NearToken {
        let me = env::predecessor_account_id();
        let start = env::storage_usage();
        let mut credit = read_u128(&credit_key(&me)) + env::attached_deposit().as_yoctonear();
        write_u128(&credit_key(&me), credit); // the credit entry itself is paid from the deposit
        credit = credit.saturating_sub(storage_cost(start));
        write_u128(&credit_key(&me), credit);
        NearToken::from_yoctonear(credit)
    }

    pub fn withdraw_storage(&mut self, amount: Option<NearToken>) -> NearToken {
        let me = env::predecessor_account_id();
        let credit = read_u128(&credit_key(&me));
        let take = amount.map(|a| a.as_yoctonear()).unwrap_or(credit);
        assert!(take > 0 && take <= credit, "you have {} of storage credit", NearToken::from_yoctonear(credit).exact_amount_display());
        write_u128(&credit_key(&me), credit - take);
        Promise::new(me).transfer(NearToken::from_yoctonear(take)).detach();
        NearToken::from_yoctonear(take)
    }

    pub fn storage_credit(&self, account: AccountId) -> NearToken {
        NearToken::from_yoctonear(read_u128(&credit_key(&account)))
    }

    /// NEAR owed to an account whose payout transfer failed; withdraw with `withdraw_owed`.
    pub fn owed(&self, account: AccountId) -> NearToken {
        NearToken::from_yoctonear(read_u128(&owed_key(&account)))
    }

    pub fn withdraw_owed(&mut self) -> NearToken {
        let me = env::predecessor_account_id();
        let amount = read_u128(&owed_key(&me));
        assert!(amount > 0, "nothing owed");
        env::storage_remove(&owed_key(&me));
        self.pay(me, amount);
        NearToken::from_yoctonear(amount)
    }

    /// The contract's balance not locked for storage (escrow lives in it).
    pub fn free_balance(&self) -> NearToken {
        env::account_balance().saturating_sub(env::storage_byte_cost().saturating_mul(env::storage_usage() as u128))
    }

    // ---------------------------------------------------------------- creators

    /// Anyone can create a channel. Attach about 0.05 NEAR for storage; the rest is refunded.
    #[payable]
    pub fn create_channel(&mut self, name: String, about: String, plans: Vec<Plan>, max_members: u32, tags: Option<Vec<String>>) -> u32 {
        validate_channel(&name, &about, &plans, max_members, self.config.period_minutes);
        let tags = tags.map(clean_tags);
        let start = env::storage_usage();
        let creator = env::predecessor_account_id();
        let id = self.channels.len();
        self.channels.push(Channel {
            id,
            creator: creator.clone(),
            name,
            about,
            plans,
            max_members,
            created_at_ms: env::block_timestamp_ms(),
            member_list: vec![],
            signal_count: 0,
            next_period: 0,
            level: 0,
            stats: Stats::default(),
        });
        self.channels.flush();
        if let Some(t) = tags { write_tags(id, &t) }
        refund_rest(&creator, charge_storage(start, env::attached_deposit()));
        emit("channel_created", json!({ "channel": id, "creator": creator }));
        id
    }

    /// The creator edits the channel. New prices apply to new subscriptions only.
    #[payable]
    pub fn update_channel(&mut self, channel: u32, name: String, about: String, plans: Vec<Plan>, max_members: u32, tags: Option<Vec<String>>) {
        validate_channel(&name, &about, &plans, max_members, self.config.period_minutes);
        let tags = tags.map(clean_tags);
        let start = env::storage_usage();
        let me = env::predecessor_account_id();
        let c = self.channels.get_mut(channel).expect("no such channel");
        assert_eq!(c.creator, me, "only the creator");
        c.name = name;
        c.about = about;
        c.plans = plans;
        c.max_members = max_members;
        self.channels.flush();
        if let Some(t) = tags { write_tags(channel, &t) }
        refund_rest(&me, charge_storage_or_free(start, env::attached_deposit()));
        emit("channel_updated", json!({ "channel": channel }));
    }

    /// Post a sealed signal. Only the creator. Attach about 0.1 NEAR for storage; the rest is
    /// refunded. `wrapped_keys` must cover exactly the subscribers who are active and have a key.
    #[payable]
    pub fn post_signal(
        &mut self,
        channel: u32,
        valid_min: u32,
        commit: String,
        reveal_round: u64,
        tlock_ct: String,
        member_ct: String,
        wrapped_keys: Vec<WrappedKey>,
    ) -> u64 {
        let start = env::storage_usage();
        let creator = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let c = self.channels.get(channel).expect("no such channel").clone();
        assert_eq!(c.creator, creator, "only the channel's creator posts signals");
        assert!((MIN_VALID_MIN..=MAX_VALID_MIN).contains(&valid_min), "validity must be {MIN_VALID_MIN}..={MAX_VALID_MIN} minutes");
        assert!(is_hex64(&commit), "commit must be 64 lowercase hex chars");
        assert!(!tlock_ct.is_empty() && tlock_ct.len() <= MAX_TLOCK_CT, "tlock_ct size");
        assert!(!member_ct.is_empty() && member_ct.len() <= MAX_MEMBER_CT, "member_ct size");
        check_round(reveal_round, now, valid_min);

        let expected = self.readers(&c, now);
        assert_eq!(wrapped_keys.len(), expected.len(), "wrap the signal key to every active subscriber with a key ({})", expected.len());
        for w in &wrapped_keys {
            assert!(expected.contains(&w.member), "wrapped key for someone who is not an active subscriber: {}", w.member);
            assert!(!w.key.is_empty() && w.key.len() <= MAX_WRAPPED_KEY, "wrapped key size");
        }
        let mut seen: Vec<&AccountId> = wrapped_keys.iter().map(|w| &w.member).collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), wrapped_keys.len(), "duplicate wrapped key");

        // The daily limit is per creator across all their channels (more channels ≠ more signals).
        let day_key = creator_day_key(&creator, now / DAY_MS);
        let today = read_u128(&day_key) as u32;
        assert!(today < self.config.max_signals_per_day, "daily signal limit reached");
        write_u128(&day_key, today as u128 + 1);

        let id = self.signals.len() as u64;
        // A signal counts in the period in which it ends, so a long signal never holds up the
        // settlement (and refunds) of the periods before its end.
        let period = self.period_of(&c, now + valid_min as u64 * 60_000);
        self.signals.push(Signal {
            id,
            channel,
            creator: creator.clone(),
            period,
            posted_at_ms: now,
            valid_min,
            commit: commit.clone(),
            reveal_round,
            tlock_ct,
            member_ct,
            wrapped_keys,
            status: SignalStatus::Sealed,
            body: None,
            r_bps: None,
            outcome: None,
            fill_price: None,
            exit_price: None,
            cost_bps: None,
        });
        let cm = self.channels.get_mut(channel).unwrap();
        self.channel_signals.insert((channel, cm.signal_count), id);
        cm.signal_count += 1;
        cm.stats.signals += 1;
        let mut ps = self.period_signals.get(&(channel, period)).cloned().unwrap_or_default();
        ps.push(id);
        self.period_signals.insert((channel, period), ps);
        self.flush_all();
        refund_rest(&creator, charge_storage(start, env::attached_deposit()));
        emit("signal_posted", json!({
            "channel": channel, "signal": id, "creator": creator, "period": period,
            "valid_min": valid_min, "opens_at_ms": now + valid_min as u64 * 60_000,
            "reveal_round": reveal_round, "commit": commit,
        }));
        id
    }

    /// Late access: the creator wraps still-sealed signals to subscribers who joined (or set up a
    /// browser) after posting. Only the creator, only while a signal is sealed and still valid, only
    /// to active subscribers with a key; a member who already has a wrapped key is skipped. No
    /// deposit (so a wallet's function-call key can do it in the background): the storage is paid
    /// from the creator's prepaid storage credit (`deposit_storage`). Returns how many keys were added.
    pub fn share_signals(&mut self, items: Vec<(u64, Vec<WrappedKey>)>) -> u32 {
        let me = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let start = env::storage_usage();
        assert!(items.len() <= 20, "at most 20 signals per call");
        let mut added = 0u32;
        for (id, keys) in items {
            let (channel, open_at) = {
                let s = self.signals.get(id as u32).expect("no such signal");
                assert_eq!(s.creator, me, "only the signal's creator can share it");
                assert_eq!(s.status, SignalStatus::Sealed, "signal {id} is no longer sealed");
                (s.channel, opens_at(s))
            };
            assert!(now < open_at, "signal {id} has ended; it opens for everyone now");
            let readers = {
                let c = self.channels.get(channel).unwrap();
                self.readers(c, now)
            };
            let s = self.signals.get_mut(id as u32).unwrap();
            let mut new_members = vec![];
            for w in keys {
                assert!(readers.contains(&w.member), "{} is not an active subscriber with a key", w.member);
                assert!(!w.key.is_empty() && w.key.len() <= MAX_WRAPPED_KEY, "wrapped key size");
                if s.wrapped_keys.iter().any(|x| x.member == w.member) {
                    continue;
                }
                new_members.push(w.member.clone());
                s.wrapped_keys.push(w);
                added += 1;
            }
            if !new_members.is_empty() {
                emit("signal_shared", json!({ "signal": id, "channel": channel, "members": new_members }));
            }
        }
        self.signals.flush();
        let cost = storage_cost(start);
        let credit = read_u128(&credit_key(&me));
        assert!(credit >= cost, "storage credit too low: sharing needs {}, you have {} (deposit_storage)",
            NearToken::from_yoctonear(cost).exact_amount_display(), NearToken::from_yoctonear(credit).exact_amount_display());
        write_u128(&credit_key(&me), credit - cost);
        added
    }

    // ---------------------------------------------------------------- subscribers

    /// Subscribe (or extend) with one of the channel's plans. Attach the plan price plus about
    /// 0.02 NEAR for storage; the rest is refunded. Half the price goes to the creator now, half is
    /// held and released period by period only if the creator's record is positive.
    /// `expect_days` / `max_price` guard against the creator changing the plan while the
    /// transaction is on its way (the app always passes both).
    #[payable]
    pub fn subscribe(&mut self, channel: u32, plan: u32, expect_days: Option<u32>, max_price: Option<NearToken>) -> u64 {
        let start = env::storage_usage();
        let me = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let c = self.channels.get(channel).expect("no such channel").clone();
        let p = c.plans.get(plan as usize).expect("no such plan").clone();
        assert_ne!(me, c.creator, "creators don't subscribe to their own channel");
        if let Some(d) = expect_days {
            assert_eq!(p.days, d, "this plan changed: it is now {} days", p.days);
        }
        if let Some(mp) = max_price {
            assert!(p.price <= mp, "this plan changed: it now costs {}", p.price.exact_amount_display());
        }

        let mut m = self.members.get(&(channel, me.clone())).cloned().unwrap_or(Member { until_ms: 0, pubkey: None, subs: vec![] });
        let was_active = m.until_ms > now;
        if !was_active {
            let active = c.member_list.iter().filter(|a| self.members.get(&(channel, (*a).clone())).map(|x| x.until_ms > now).unwrap_or(false)).count();
            assert!((active as u32) < c.max_members, "channel is full ({} subscribers)", c.max_members);
        }
        assert!(m.subs.len() < MAX_SUBS_PER_MEMBER, "too many subscriptions on this account");
        let sub_start = m.until_ms.max(now);
        let sub_end = sub_start + p.days as u64 * DAY_MS;
        let price = p.price.as_yoctonear();
        let held = price - price / 2;
        let mut to_creator = price / 2;

        if held > 0 {
            let sub = Sub { start_ms: sub_start, end_ms: sub_end, held: NearToken::from_yoctonear(held) };
            let (p0, pk) = (self.period_of(&c, sub_start), self.period_of(&c, sub_end - 1));
            let first = self.share(&c, &sub, p0);
            let mut spread = first;
            self.add_partial(channel, p0, first);
            if pk > p0 {
                let last = self.share(&c, &sub, pk);
                spread += last;
                self.add_partial(channel, pk, last);
            }
            if pk > p0 + 1 {
                let full = self.share(&c, &sub, p0 + 1);
                spread += full * (pk - p0 - 1) as u128;
                self.add_diff(channel, p0 + 1, full as i128);
                self.add_diff(channel, pk, -(full as i128));
            }
            to_creator += held - spread; // rounding dust
            m.subs.push(sub);
        }
        m.until_ms = sub_end;
        self.members.insert((channel, me.clone()), m);
        let cm = self.channels.get_mut(channel).unwrap();
        if !cm.member_list.contains(&me) {
            // Drop expired accounts so the list stays bounded.
            let members = &self.members;
            cm.member_list.retain(|a| members.get(&(channel, a.clone())).map(|x| x.until_ms > now).unwrap_or(false));
            cm.member_list.push(me.clone());
        }
        cm.stats.earned = cm.stats.earned.saturating_add(NearToken::from_yoctonear(to_creator));
        self.flush_all();

        let need = price + storage_cost(start);
        let deposit = env::attached_deposit().as_yoctonear();
        assert!(deposit >= need, "attach at least {} (price + storage)", NearToken::from_yoctonear(need).exact_amount_display());
        if to_creator > 0 {
            self.pay(c.creator.clone(), to_creator);
        }
        refund_rest(&me, NearToken::from_yoctonear(deposit - need));
        emit("subscribed", json!({
            "channel": channel, "member": me, "plan": plan, "price": p.price,
            "to_creator": NearToken::from_yoctonear(to_creator), "held": NearToken::from_yoctonear(held),
            "until_ms": sub_end,
        }));
        sub_end
    }

    /// A subscriber registers (or rotates) their X25519 public key for a channel. Signals posted
    /// afterwards are wrapped to it. On a rotation, the member's old wrapped keys on still-live
    /// signals are dropped so the creator's app shares those signals again to the new key.
    /// Attach about 0.01 NEAR for storage; the rest is refunded.
    #[payable]
    pub fn register_key(&mut self, channel: u32, pubkey: String) {
        assert!(valid_x25519(&pubkey), "pubkey must be a base64 32-byte X25519 public key");
        let start = env::storage_usage();
        let me = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let m = self.members.get_mut(&(channel, me.clone())).expect("not subscribed to this channel");
        let rotated = m.pubkey.as_ref().is_some_and(|k| *k != pubkey);
        m.pubkey = Some(pubkey);
        if rotated {
            let count = self.channels.get(channel).map(|c| c.signal_count).unwrap_or(0);
            for i in (count.saturating_sub(KEY_ROTATION_SCAN)..count).rev() {
                let Some(id) = self.channel_signals.get(&(channel, i)).copied() else { continue };
                let s = self.signals.get(id as u32).unwrap();
                if s.status != SignalStatus::Sealed || opens_at(s) <= now || !s.wrapped_keys.iter().any(|w| w.member == me) {
                    continue;
                }
                self.signals.get_mut(id as u32).unwrap().wrapped_keys.retain(|w| w.member != me);
            }
        }
        self.flush_all();
        refund_rest(&me, charge_storage_or_free(start, env::attached_deposit()));
        emit("key_registered", json!({ "channel": channel, "member": me, "rotated": rotated }));
    }

    /// Claim back held halves of settled periods that were not released to the creator. The small
    /// storage this record takes is deducted from the refund.
    pub fn claim_refund(&mut self, channel: u32) -> NearToken {
        let me = env::predecessor_account_id();
        let start = env::storage_usage();
        let (amount, periods) = self.claimable(channel, me.clone());
        assert!(amount.as_yoctonear() > 0, "nothing to claim");
        for p in &periods {
            self.claimed.insert((channel, *p, me.clone()), true);
        }
        self.claimed.flush();
        let fee = storage_cost(start);
        assert!(amount.as_yoctonear() > fee, "refund is smaller than the storage it needs");
        let net = amount.as_yoctonear() - fee;
        emit("refund_claimed", json!({ "channel": channel, "member": me, "amount": NearToken::from_yoctonear(net), "periods": periods }));
        Promise::new(me.clone())
            .transfer(NearToken::from_yoctonear(net))
            .then(Self::ext(env::current_account_id()).with_static_gas(PAY_CALLBACK_GAS).on_refund_paid(channel, me, periods))
            .detach();
        NearToken::from_yoctonear(net)
    }

    /// A refund transfer that failed is claimable again.
    #[private]
    pub fn on_refund_paid(&mut self, channel: u32, member: AccountId, periods: Vec<u64>, #[callback_result] r: Result<(), PromiseError>) {
        if r.is_err() {
            for p in &periods {
                self.claimed.remove(&(channel, *p, member.clone()));
            }
            emit("refund_failed", json!({ "channel": channel, "member": member, "periods": periods }));
        }
    }

    /// A payout transfer that failed is kept for the account to withdraw (`withdraw_owed`).
    #[private]
    pub fn on_paid(&mut self, account: AccountId, amount: NearToken, #[callback_result] r: Result<(), PromiseError>) {
        if r.is_err() {
            let k = owed_key(&account);
            write_u128(&k, read_u128(&k) + amount.as_yoctonear());
            emit("payout_failed", json!({ "account": account, "amount": amount }));
        }
    }

    // ---------------------------------------------------------------- anyone

    /// Publish a signal after its validity. Anyone can do it: from the drand-opened copy, or a
    /// subscriber from their own decrypted copy. Only the exact committed text is accepted. If that
    /// text is not a valid signal for this channel, it is published and scores −100%.
    /// Attach about 0.01 NEAR for the storage the published signal takes; the rest is refunded.
    #[payable]
    pub fn reveal(&mut self, signal_id: u64, plaintext: String) {
        let start = env::storage_usage();
        let now = env::block_timestamp_ms();
        let s = self.signals.get_mut(signal_id as u32).expect("no such signal");
        assert_eq!(s.status, SignalStatus::Sealed, "signal is not sealed");
        assert!(now >= opens_at(s), "signal is still valid; it opens when its validity ends");
        assert_eq!(hex(&env::sha256(plaintext.as_bytes())), s.commit, "text does not match the commitment");
        let body = serde_json::from_str::<SignalPayload>(&plaintext)
            .ok()
            .filter(|p| p.v == 2 && p.channel == s.channel && p.creator == s.creator && p.valid_min == s.valid_min)
            .map(|p| SignalBody {
                market: p.market,
                side: p.side,
                leverage: p.leverage,
                entry_low: p.entry_low,
                entry_high: p.entry_high,
                tps: p.tps,
                sl: p.sl,
                msg: p.msg,
            })
            .filter(|b| validate_body(b).is_ok());
        s.status = SignalStatus::Revealed { by: env::predecessor_account_id(), at_ms: now };
        if body.is_none() {
            s.r_bps = Some(LOSS_BPS);
            s.outcome = Some("invalid".into());
        }
        s.body = body;
        emit("signal_revealed", json!({
            "signal": signal_id, "channel": s.channel, "creator": s.creator,
            "valid": s.body.is_some(), "by": env::predecessor_account_id(),
        }));
        self.signals.flush();
        refund_rest(&env::predecessor_account_id(), charge_storage_or_free(start, env::attached_deposit()));
    }

    /// After the grace period (at least 24 h) a signal nobody revealed is final and scores −100%.
    #[payable]
    pub fn mark_unrevealed(&mut self, signal_id: u64) {
        let start = env::storage_usage();
        let now = env::block_timestamp_ms();
        let grace_ms = self.config.grace_min as u64 * 60_000;
        let s = self.signals.get_mut(signal_id as u32).expect("no such signal");
        assert_eq!(s.status, SignalStatus::Sealed, "signal is not sealed");
        assert!(now >= opens_at(s) + grace_ms, "grace period not over");
        s.status = SignalStatus::Unrevealed { at_ms: now };
        s.r_bps = Some(LOSS_BPS);
        s.outcome = Some("unrevealed".into());
        emit("signal_unrevealed", json!({ "signal": signal_id, "channel": s.channel, "creator": s.creator }));
        self.signals.flush();
        refund_rest(&env::predecessor_account_id(), charge_storage_or_free(start, env::attached_deposit()));
    }

    /// Settle a channel's next period once it has ended and every signal in it is open.
    /// Scoring of any still-unscored signals (at most MAX_SETTLE_SCORE; score the rest first with
    /// `score_signals`) runs on OutLayer: attach its compute deposit (SETTLE_STORAGE_FEE is kept for
    /// storage, the unused rest is refunded by OutLayer). A period with nothing to score settles at
    /// once; its storage is paid from the deposit and the rest returned. A settlement whose scoring
    /// never came back can be restarted after SETTLE_TIMEOUT_MS.
    #[payable]
    pub fn settle(&mut self, channel: u32) -> PromiseOrValue<Option<PeriodResult>> {
        let start = env::storage_usage();
        let now = env::block_timestamp_ms();
        let c = self.channels.get(channel).expect("no such channel").clone();
        let period = c.next_period;
        assert!(now >= self.period_end(&c, period), "period {period} has not ended");
        if let Some(r) = self.periods.get(&(channel, period)) {
            assert!(
                r.status != PeriodStatus::Settling || now >= r.settled_at_ms + SETTLE_TIMEOUT_MS,
                "period {period} is being settled"
            );
        }
        let ids = self.period_signals.get(&(channel, period)).cloned().unwrap_or_default();
        for id in &ids {
            assert!(self.signals.get(*id as u32).unwrap().status != SignalStatus::Sealed, "signal {id} is still sealed");
        }
        let to_score: Vec<u64> = ids.iter().copied().filter(|id| self.signals.get(*id as u32).unwrap().r_bps.is_none()).collect();
        let deposit = env::attached_deposit();
        if to_score.is_empty() {
            let result = self.finish_period(channel, period);
            self.periods.flush();
            refund_rest(&env::predecessor_account_id(), charge_storage_or_free(start, deposit));
            return PromiseOrValue::Value(Some(result));
        }
        assert!(to_score.len() <= MAX_SETTLE_SCORE, "{} signals are unscored: score them first with score_signals (10 per call)", to_score.len());
        assert!(deposit > SETTLE_STORAGE_FEE, "attach a deposit for OutLayer compute (0.1–0.5 NEAR; unused part is refunded)");
        self.periods.insert(
            (channel, period),
            PeriodResult { status: PeriodStatus::Settling, signals: 0, sum_bps: 0, score_bps: 0, released: false, held: NearToken::from_yoctonear(0), settled_at_ms: now },
        );
        emit("settle_requested", json!({ "channel": channel, "period": period, "signals": to_score }));
        PromiseOrValue::Promise(
            self.scoring_request(&to_score, deposit.saturating_sub(SETTLE_STORAGE_FEE))
                .then(Self::ext(env::current_account_id()).with_static_gas(SCORE_CALLBACK_GAS).on_scores(channel, period, to_score, now)),
        )
    }

    /// Official scores as soon as signals end, without waiting for the period to settle.
    /// Anyone can call it (the keeper does) with up to 10 revealed, ended, unscored signals and a
    /// deposit for OutLayer compute (SCORE_STORAGE_FEE per signal is kept for storage; the unused
    /// rest is refunded by OutLayer). Settlement later uses these scores as they are.
    #[payable]
    pub fn score_signals(&mut self, ids: Vec<u64>) -> Promise {
        assert!(!ids.is_empty() && ids.len() <= 10, "1 to 10 signals per call");
        let now = env::block_timestamp_ms();
        let mut seen = ids.clone();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), ids.len(), "duplicate signal id");
        for id in &ids {
            let s = self.signals.get(*id as u32).expect("no such signal");
            assert!(matches!(s.status, SignalStatus::Revealed { .. }), "signal {id} is not revealed");
            assert!(s.body.is_some() && s.r_bps.is_none(), "signal {id} is already scored");
            assert!(now >= opens_at(s), "signal {id} is still valid");
        }
        let deposit = env::attached_deposit();
        let fee = SCORE_STORAGE_FEE.saturating_mul(ids.len() as u128);
        assert!(deposit > fee, "attach a deposit for OutLayer compute (0.1–0.5 NEAR; unused part is refunded)");
        emit("scoring_requested", json!({ "signals": ids }));
        self.scoring_request(&ids, deposit.saturating_sub(fee))
            .then(Self::ext(env::current_account_id()).with_static_gas(SCORE_CALLBACK_GAS).on_signal_scores(ids))
    }

    #[private]
    pub fn on_signal_scores(&mut self, ids: Vec<u64>, #[callback_result] result: Result<Option<ScoreOut>, PromiseError>) -> u32 {
        let out = match result {
            Ok(Some(o)) if o.ok && check_scores(&ids, &o.results, &o.failed).is_ok() => o,
            other => {
                let why = match other {
                    Ok(Some(o)) => o.error.unwrap_or_else(|| "scores did not match the request".into()),
                    Ok(None) => "scoring job failed or returned nothing".into(),
                    Err(_) => "OutLayer request failed".into(),
                };
                emit("scoring_failed", json!({ "signals": ids, "reason": why }));
                return 0;
            }
        };
        let n = self.apply_scores(&out.results);
        if !out.failed.is_empty() {
            emit("scoring_failed", json!({ "signals": out.failed, "reason": out.error.unwrap_or_else(|| "data unavailable; retry later".into()) }));
        }
        n
    }

    #[private]
    pub fn on_scores(
        &mut self,
        channel: u32,
        period: u64,
        ids: Vec<u64>,
        requested_ms: u64,
        #[callback_result] result: Result<Option<ScoreOut>, PromiseError>,
    ) -> Option<PeriodResult> {
        // Only the settlement that is still current may finish the period (a timed-out one that
        // answers late just leaves its scores).
        let current = self.periods.get(&(channel, period)).is_some_and(|r| r.status == PeriodStatus::Settling && r.settled_at_ms == requested_ms)
            && self.channels.get(channel).is_some_and(|c| c.next_period == period);
        let out = match result {
            Ok(Some(o)) if o.ok && check_scores(&ids, &o.results, &o.failed).is_ok() => o,
            other => {
                let why = match other {
                    Ok(Some(o)) => o.error.unwrap_or_else(|| "scores did not match the request".into()),
                    Ok(None) => "scoring job failed or returned nothing".into(),
                    Err(_) => "OutLayer request failed".into(),
                };
                if current {
                    self.periods.remove(&(channel, period));
                }
                emit("settle_failed", json!({ "channel": channel, "period": period, "reason": why }));
                return None; // anyone can call settle again
            }
        };
        self.apply_scores(&out.results);
        if !current {
            return None;
        }
        if !out.failed.is_empty() {
            self.periods.remove(&(channel, period));
            emit("settle_failed", json!({ "channel": channel, "period": period, "reason": "some signals could not be scored yet", "signals": out.failed }));
            return None;
        }
        Some(self.finish_period(channel, period))
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    /// What each channel says it posts: any of "perps", "dex", "micro"; empty = all kinds.
    /// Declared by the creator; the public record shows what was actually posted.
    pub fn channel_tags(&self, channels: Vec<u32>) -> Vec<Vec<String>> {
        assert!(channels.len() <= 200, "at most 200 channels");
        channels.into_iter().map(read_tags).collect()
    }

    pub fn get_channel(&self, channel: u32) -> Option<Channel> {
        self.channels.get(channel).cloned()
    }

    pub fn list_channels(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Channel> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.channels.len()).take(limit as usize).filter_map(|i| self.channels.get(i).cloned()).collect()
    }

    pub fn get_signal(&self, signal_id: u64) -> Option<Signal> {
        self.signals.get(signal_id as u32).cloned()
    }

    /// Signals in a channel, newest first. `from_index` is exclusive (pass the last index seen).
    pub fn list_signals(&self, channel: u32, from_index: Option<u32>, limit: Option<u32>) -> Vec<Signal> {
        let Some(c) = self.channels.get(channel) else { return vec![] };
        let limit = limit.unwrap_or(50).min(100);
        let top = from_index.unwrap_or(c.signal_count).min(c.signal_count);
        (0..top)
            .rev()
            .take(limit as usize)
            .filter_map(|i| self.channel_signals.get(&(channel, i)))
            .filter_map(|id| self.signals.get(*id as u32).cloned())
            .collect()
    }

    pub fn get_member(&self, channel: u32, account: AccountId) -> Option<Member> {
        self.members.get(&(channel, account)).cloned()
    }

    /// Active subscribers with a registered key: exactly who a new signal must be wrapped to.
    pub fn readers_now(&self, channel: u32) -> Vec<(AccountId, String)> {
        let c = self.channels.get(channel).expect("no such channel");
        let now = env::block_timestamp_ms();
        self.readers(c, now)
            .into_iter()
            .map(|a| {
                let k = self.members.get(&(channel, a.clone())).unwrap().pubkey.clone().unwrap();
                (a, k)
            })
            .collect()
    }

    /// Active subscribers (with or without a key) and when each subscription ends.
    pub fn subscribers(&self, channel: u32) -> Vec<(AccountId, u64, bool)> {
        let c = self.channels.get(channel).expect("no such channel");
        let now = env::block_timestamp_ms();
        c.member_list
            .iter()
            .filter_map(|a| self.members.get(&(channel, a.clone())).map(|m| (a.clone(), m.until_ms, m.pubkey.is_some())))
            .filter(|(_, until, _)| *until > now)
            .collect()
    }

    pub fn get_period(&self, channel: u32, period: u64) -> Option<PeriodResult> {
        self.periods.get(&(channel, period)).cloned()
    }

    pub fn current_period(&self, channel: u32) -> u64 {
        let c = self.channels.get(channel).expect("no such channel");
        self.period_of(c, env::block_timestamp_ms())
    }

    /// Held amount (yocto) a period has accumulated so far — what settlement will release or refund.
    pub fn period_held(&self, channel: u32, period: u64) -> NearToken {
        let c = self.channels.get(channel).expect("no such channel");
        if let Some(r) = self.periods.get(&(channel, period)) {
            if r.status == PeriodStatus::Settled {
                return r.held;
            }
        }
        let mut level = c.level;
        for p in c.next_period..=period {
            level += self.diff.get(&(channel, p)).copied().unwrap_or(0);
        }
        NearToken::from_yoctonear(self.partial.get(&(channel, period)).copied().unwrap_or(0) + level.max(0) as u128)
    }

    /// What `account` can claim back from a channel now, and from which periods.
    pub fn claimable(&self, channel: u32, account: AccountId) -> (NearToken, Vec<u64>) {
        let Some(c) = self.channels.get(channel) else { return (NearToken::from_yoctonear(0), vec![]) };
        let Some(m) = self.members.get(&(channel, account.clone())) else { return (NearToken::from_yoctonear(0), vec![]) };
        let mut total = 0u128;
        let mut periods = vec![];
        let mut ps: Vec<u64> = vec![];
        for s in &m.subs {
            for p in self.period_of(c, s.start_ms)..=self.period_of(c, s.end_ms - 1) {
                if p >= c.next_period {
                    break;
                }
                if !ps.contains(&p) {
                    ps.push(p);
                }
            }
        }
        for p in ps {
            let failed = self.periods.get(&(channel, p)).map(|r| r.status == PeriodStatus::Settled && !r.released).unwrap_or(false);
            if !failed || self.claimed.get(&(channel, p, account.clone())).is_some() {
                continue;
            }
            let amount: u128 = m.subs.iter().map(|s| self.share(c, s, p)).sum();
            if amount > 0 {
                total += amount;
                periods.push(p);
            }
        }
        (NearToken::from_yoctonear(total), periods)
    }

    // ---------------------------------------------------------------- internals

    /// The OutLayer request that runs the scorer on these (revealed, valid) signals.
    fn scoring_request(&self, ids: &[u64], deposit: NearToken) -> Promise {
        let input: Vec<_> = ids
            .iter()
            .map(|id| {
                let s = self.signals.get(*id as u32).unwrap();
                let b = s.body.as_ref().unwrap();
                json!({
                    "id": id, "venue": b.market.venue, "network": b.market.network, "address": b.market.address,
                    "side": b.side, "leverage": b.leverage, "entry_low": b.entry_low, "entry_high": b.entry_high,
                    "tps": b.tps, "sl": b.sl, "posted_at_ms": s.posted_at_ms, "valid_min": s.valid_min,
                })
            })
            .collect();
        let cfg = &self.config;
        let source = json!({ "WasmUrl": { "url": cfg.scorer_wasm_url, "hash": cfg.scorer_wasm_hash, "build_target": "wasm32-wasip2" } });
        let limits = json!({ "max_instructions": 10_000_000_000u64, "max_memory_mb": 256u32, "max_execution_seconds": 180u64 });
        let job = json!({ "signals": input, "reference_usd": cfg.reference_usd, "liquidity_floor_usd": cfg.liquidity_floor_usd });
        ext_outlayer::ext(cfg.outlayer.clone())
            .with_attached_deposit(deposit)
            .with_unused_gas_weight(1)
            .request_execution(source, Some(limits), Some(job.to_string()), None, Some("Json".into()), Some(env::predecessor_account_id()), None)
    }

    fn flush_all(&mut self) {
        self.channels.flush();
        self.signals.flush();
        self.channel_signals.flush();
        self.period_signals.flush();
        self.members.flush();
        self.daily.flush();
        self.partial.flush();
        self.diff.flush();
    }

    fn period_ms(&self) -> u64 {
        self.config.period_minutes as u64 * 60_000
    }

    fn period_of(&self, c: &Channel, t_ms: u64) -> u64 {
        t_ms.saturating_sub(c.created_at_ms) / self.period_ms()
    }

    fn period_start(&self, c: &Channel, p: u64) -> u64 {
        c.created_at_ms + p * self.period_ms()
    }

    fn period_end(&self, c: &Channel, p: u64) -> u64 {
        self.period_start(c, p + 1)
    }

    /// The part of a subscription's held half that belongs to period `p` (by time overlap).
    fn share(&self, c: &Channel, s: &Sub, p: u64) -> u128 {
        let (ps, pe) = (self.period_start(c, p), self.period_end(c, p));
        let overlap = s.end_ms.min(pe).saturating_sub(s.start_ms.max(ps)) as u128;
        let len = (s.end_ms - s.start_ms) as u128;
        let held = s.held.as_yoctonear();
        held / len * overlap + held % len * overlap / len
    }

    fn add_partial(&mut self, channel: u32, p: u64, amount: u128) {
        let v = self.partial.get(&(channel, p)).copied().unwrap_or(0);
        self.partial.insert((channel, p), v + amount);
    }

    fn add_diff(&mut self, channel: u32, p: u64, amount: i128) {
        let v = self.diff.get(&(channel, p)).copied().unwrap_or(0);
        self.diff.insert((channel, p), v + amount);
    }

    /// Active subscribers with a registered key at `now`.
    fn readers(&self, c: &Channel, now: u64) -> Vec<AccountId> {
        c.member_list
            .iter()
            .filter(|a| self.members.get(&(c.id, (*a).clone())).map(|m| m.until_ms > now && m.pubkey.is_some()).unwrap_or(false))
            .cloned()
            .collect()
    }

    fn apply_scores(&mut self, results: &[SignalScore]) -> u32 {
        let mut n = 0;
        for r in results {
            let s = self.signals.get_mut(r.id as u32).unwrap();
            if s.r_bps.is_some() {
                continue; // scored meanwhile by another request
            }
            apply_score(s, r);
            n += 1;
        }
        if n > 0 {
            emit("signals_scored", json!({ "signals": results.iter().map(|r| json!({ "id": r.id, "r_bps": r.r_bps, "outcome": r.outcome })).collect::<Vec<_>>() }));
        }
        n
    }

    /// Sends NEAR; if the transfer fails, the amount is kept as owed to that account.
    fn pay(&self, to: AccountId, amount: u128) {
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(PAY_CALLBACK_GAS).on_paid(to, NearToken::from_yoctonear(amount)))
            .detach();
    }

    fn finish_period(&mut self, channel: u32, period: u64) -> PeriodResult {
        let ids = self.period_signals.get(&(channel, period)).cloned().unwrap_or_default();
        let mut rs: Vec<i32> = vec![];
        let mut filled = 0u32;
        for id in &ids {
            let s = self.signals.get(*id as u32).unwrap();
            rs.push(s.r_bps.unwrap_or(LOSS_BPS));
            if was_filled(s.outcome.as_deref().unwrap_or("")) {
                filled += 1;
            }
        }
        let (sum, score) = period_score(&rs);
        // Released only on a positive total (Σr > 0, not the rounded score) over at least
        // `min_signals` calls that actually filled (calls that never fill can't pad the count).
        let released = filled >= self.config.min_signals && sum > 0;
        let held = self.partial.get(&(channel, period)).copied().unwrap_or(0);
        let diff = self.diff.get(&(channel, period)).copied().unwrap_or(0);
        let c = self.channels.get_mut(channel).unwrap();
        c.level += diff;
        let held = NearToken::from_yoctonear(held + c.level.max(0) as u128);
        c.next_period = period + 1;
        c.stats.scored += rs.len() as u32;
        c.stats.wins += rs.iter().filter(|r| **r > 0).count() as u32;
        c.stats.filled += filled;
        c.stats.sum_bps += sum;
        if released {
            c.stats.periods_released += 1;
            c.stats.earned = c.stats.earned.saturating_add(held);
            if held.as_yoctonear() > 0 {
                let creator = c.creator.clone();
                self.pay(creator, held.as_yoctonear());
            }
        } else {
            c.stats.periods_refunded += 1;
            c.stats.refundable = c.stats.refundable.saturating_add(held);
        }
        let result = PeriodResult {
            status: PeriodStatus::Settled,
            signals: rs.len() as u32,
            sum_bps: sum,
            score_bps: score,
            released,
            held,
            settled_at_ms: env::block_timestamp_ms(),
        };
        self.periods.insert((channel, period), result.clone());
        emit("period_settled", json!({
            "channel": channel, "period": period, "signals": rs.len(), "score_bps": score,
            "released": released, "held": held,
        }));
        result
    }
}

// -------------------------------------------------------------------- pure helpers

/// (Σr, S = Σr / (n + SHRINK)) in basis points.
pub fn period_score(rs: &[i32]) -> (i64, i64) {
    let sum: i64 = rs.iter().map(|r| *r as i64).sum();
    (sum, sum / (rs.len() as i64 + SHRINK))
}

/// Every requested signal appears exactly once, either scored or reported as failed.
pub fn check_scores(ids: &[u64], results: &[SignalScore], failed: &[u64]) -> Result<(), String> {
    if results.len() + failed.len() != ids.len() {
        return Err(format!("expected {} scores, got {} (+{} failed)", ids.len(), results.len(), failed.len()));
    }
    for id in ids {
        if results.iter().filter(|s| s.id == *id).count() + failed.iter().filter(|f| *f == id).count() != 1 {
            return Err(format!("signal {id} missing or repeated in scores"));
        }
    }
    Ok(())
}

/// Outcomes in which the entry never filled (or there was nothing to trade). The scorer may append
/// the candle size, e.g. "not_filled (15m)", so only the first word counts.
pub const NO_FILL: &[&str] = &["not_filled", "invalid", "unrevealed", "below_floor", "no_market", "no_pool_at_post", "no_data", "no_trades"];

pub fn was_filled(outcome: &str) -> bool {
    let first = outcome.split(' ').next().unwrap_or("");
    !first.is_empty() && !NO_FILL.contains(&first)
}

/// The drand round must open no earlier than validity's end and at most ROUND_SLACK_S after.
pub fn check_round(round: u64, posted_ms: u64, valid_min: u32) {
    assert!(round >= 1, "bad round");
    let round_s = QUICKNET_GENESIS_S + (round - 1) * QUICKNET_PERIOD_S;
    let end_s = (posted_ms + valid_min as u64 * 60_000).div_ceil(1000);
    assert!(round_s >= end_s, "reveal round opens before validity ends");
    assert!(round_s <= end_s + ROUND_SLACK_S, "reveal round is too far after validity ends");
}

fn price(s: &str) -> Result<f64, String> {
    if s.is_empty() || s.len() > 32 || !s.bytes().all(|b| b.is_ascii_digit() || b == b'.') || s.matches('.').count() > 1 {
        return Err(format!("bad price {s:?}"));
    }
    let v: f64 = s.parse().map_err(|_| format!("bad price {s:?}"))?;
    if !(v > 0.0 && v.is_finite()) {
        return Err(format!("price must be positive: {s:?}"));
    }
    Ok(v)
}

fn token_chars(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b))
}

/// Rules a revealed signal must follow. A signal that breaks them scores −100%.
pub fn validate_body(b: &SignalBody) -> Result<(), String> {
    let m = &b.market;
    match m.venue.as_str() {
        "hyperliquid" => {
            if m.network.is_some() {
                return Err("hyperliquid markets have no network".into());
            }
            if !(1..=MAX_LEVERAGE).contains(&b.leverage) {
                return Err(format!("leverage must be 1..={MAX_LEVERAGE}"));
            }
        }
        "gecko" | "gecko_micro" => {
            let net = m.network.as_deref().unwrap_or("");
            if !token_chars(net, 32) {
                return Err("DEX tokens need a network".into());
            }
            if b.side != "long" {
                return Err("DEX tokens can only be long".into());
            }
            if b.leverage != 1 {
                return Err("DEX tokens are 1x only".into());
            }
        }
        _ => return Err("unknown venue".into()),
    }
    if !token_chars(&m.address, 64) || m.symbol.is_empty() || m.symbol.chars().count() > 24 {
        return Err("bad market".into());
    }
    let long = match b.side.as_str() {
        "long" => true,
        "short" => false,
        _ => return Err("side must be long or short".into()),
    };
    let (lo, hi, sl) = (price(&b.entry_low)?, price(&b.entry_high)?, price(&b.sl)?);
    if lo > hi {
        return Err("entry low is above entry high".into());
    }
    if b.tps.is_empty() || b.tps.len() > 3 {
        return Err("1 to 3 take-profits".into());
    }
    let tps: Vec<f64> = b.tps.iter().map(|t| price(t)).collect::<Result<_, _>>()?;
    if long {
        if sl >= lo {
            return Err("stop loss must be below the entry range".into());
        }
        if tps.iter().any(|t| *t <= hi) || tps.windows(2).any(|w| w[1] <= w[0]) {
            return Err("take-profits must be above the entry range, rising".into());
        }
    } else {
        if sl <= hi {
            return Err("stop loss must be above the entry range".into());
        }
        if tps.iter().any(|t| *t >= lo) || tps.windows(2).any(|w| w[1] >= w[0]) {
            return Err("take-profits must be below the entry range, falling".into());
        }
    }
    if b.msg.chars().count() > MAX_MSG_CHARS {
        return Err("message too long".into());
    }
    Ok(())
}

fn apply_score(s: &mut Signal, r: &SignalScore) {
    s.r_bps = Some(r.r_bps.clamp(LOSS_BPS, MAX_GAIN_BPS));
    s.outcome = Some(r.outcome.chars().take(32).collect());
    s.fill_price = r.fill_price.as_ref().map(|x| x.chars().take(32).collect());
    s.exit_price = r.exit_price.as_ref().map(|x| x.chars().take(32).collect());
    s.cost_bps = r.cost_bps.map(|c| c.clamp(0, 10_000));
}

fn opens_at(s: &Signal) -> u64 {
    s.posted_at_ms + s.valid_min as u64 * 60_000
}

fn validate_config(c: &Config) {
    assert!(c.period_minutes >= 10, "period too short");
    assert!(c.max_signals_per_day >= 1 && c.max_signals_per_day <= 50, "max_signals_per_day 1..=50");
    assert!(c.min_signals >= 1, "min_signals >= 1");
    assert!(c.grace_min >= MIN_GRACE_MIN, "grace_min must be at least {MIN_GRACE_MIN} minutes");
    assert!(c.scorer_wasm_url.starts_with("https://"), "scorer_wasm_url must be https");
    assert!(is_hex64(&c.scorer_wasm_hash), "scorer_wasm_hash must be 64 lowercase hex chars");
}

fn validate_channel(name: &str, about: &str, plans: &[Plan], max_members: u32, period_minutes: u32) {
    assert!(!name.trim().is_empty() && name.chars().count() <= 48, "name: 1..=48 characters");
    assert!(about.chars().count() <= 400, "about: at most 400 characters");
    assert!(!plans.is_empty() && plans.len() <= MAX_PLANS, "1..={MAX_PLANS} plans");
    for p in plans {
        assert!((1..=MAX_PLAN_DAYS).contains(&p.days), "plan days must be 1..={MAX_PLAN_DAYS}");
        assert!(p.price >= MIN_PLAN_PRICE, "plan price must be at least {}", MIN_PLAN_PRICE.exact_amount_display());
    }
    let _ = period_minutes;
    assert!((1..=MAX_MEMBERS).contains(&max_members), "max subscribers 1..={MAX_MEMBERS}");
}

fn storage_cost(start: u64) -> u128 {
    env::storage_byte_cost().as_yoctonear() * env::storage_usage().saturating_sub(start) as u128
}

/// Charges storage added since `start` against `deposit`; returns what is left.
fn charge_storage(start: u64, deposit: NearToken) -> NearToken {
    let used = env::storage_usage().saturating_sub(start) as u128;
    let cost = env::storage_byte_cost().saturating_mul(used);
    assert!(deposit >= cost, "attach at least {} for storage", cost.exact_amount_display());
    deposit.saturating_sub(cost)
}

/// Like `charge_storage`, but storage that shrank costs nothing.
fn charge_storage_or_free(start: u64, deposit: NearToken) -> NearToken {
    if env::storage_usage() <= start {
        return deposit;
    }
    charge_storage(start, deposit)
}

fn refund_rest(to: &AccountId, amount: NearToken) {
    if amount.as_yoctonear() > 0 {
        Promise::new(to.clone()).transfer(amount).detach();
    }
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    bytes.iter().flat_map(|b| [H[(b >> 4) as usize] as char, H[(b & 15) as usize] as char]).collect()
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "sealedcalls", "version": "2.0.0", "event": event, "data": [data] })
    ));
}

#[cfg(test)]
mod tests;

// Channel kinds live under their own storage keys so the Channel struct (and state) is unchanged.
const TAGS: [&str; 3] = ["perps", "dex", "micro"];

fn tag_key(channel: u32) -> Vec<u8> {
    [b"tags:".as_slice(), &channel.to_le_bytes()].concat()
}

fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for t in tags {
        assert!(TAGS.contains(&t.as_str()), "tags: perps, dex or micro");
        if !out.contains(&t) { out.push(t) }
    }
    if out.len() == TAGS.len() { out.clear() } // all three = all kinds
    out
}

fn write_tags(channel: u32, tags: &[String]) {
    if tags.is_empty() {
        env::storage_remove(&tag_key(channel));
    } else {
        env::storage_write(&tag_key(channel), &serde_json::to_vec(tags).unwrap());
    }
}

fn read_tags(channel: u32) -> Vec<String> {
    env::storage_read(&tag_key(channel)).and_then(|v| serde_json::from_slice(&v).ok()).unwrap_or_default()
}

// ------------------------------------------------------------- raw-key state (no struct change)
const PENDING_CONFIG: &[u8] = b"pending_config";

fn credit_key(a: &AccountId) -> Vec<u8> {
    [b"scred:".as_slice(), a.as_bytes()].concat()
}
fn owed_key(a: &AccountId) -> Vec<u8> {
    [b"owed:".as_slice(), a.as_bytes()].concat()
}
fn creator_day_key(a: &AccountId, day: u64) -> Vec<u8> {
    [b"cday:".as_slice(), a.as_bytes(), b":", &day.to_le_bytes()].concat()
}
fn read_u128(k: &[u8]) -> u128 {
    env::storage_read(k).and_then(|v| v.try_into().ok()).map(u128::from_le_bytes).unwrap_or(0)
}
fn write_u128(k: &[u8], v: u128) {
    if v == 0 {
        env::storage_remove(k);
    } else {
        env::storage_write(k, &v.to_le_bytes());
    }
}

/// X25519 public keys that make every shared secret predictable (libsodium refuses them too).
const SMALL_ORDER: [[u8; 32]; 7] = [
    [0; 32],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00],
    [0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef, 0x5b, 0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f, 0x11, 0x57],
    [0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f],
    [0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f],
    [0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f],
];

/// Standard base64 of 32 bytes that is not a small-order point (top bit ignored, as X25519 does).
pub fn valid_x25519(s: &str) -> bool {
    use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
    let Ok(b) = STANDARD.decode(s) else { return false };
    let Ok(mut k): Result<[u8; 32], _> = b.try_into() else { return false };
    k[31] &= 0x7f;
    !SMALL_ORDER.iter().any(|z| {
        let mut z = *z;
        z[31] &= 0x7f;
        z == k
    })
}
