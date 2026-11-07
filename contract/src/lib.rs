//! Sealed Calls — a club's memecoin calls become a complete public record after each call ends,
//! scored by an attested OutLayer job, and callers are paid from the club's escrow only when
//! their record is positive.
//!
//! What this contract guarantees: a posted call cannot be edited, deleted or hidden; it opens only
//! after its horizon; it is wrapped to every registered member; a call nobody reveals scores −100%.
//! What it cannot guarantee: that the timelocked copy is valid (members can reveal from their own
//! copy), that members don't leak calls, or that callers don't trade against members elsewhere.

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
/// The reveal round must fall within this many seconds after the horizon ends.
pub const ROUND_SLACK_S: u64 = 120;
pub const MAX_MEMBERS: usize = 25;
pub const MAX_CALLERS: usize = 25;
pub const MAX_TLOCK_CT: usize = 2_048;
pub const MAX_MEMBER_CT: usize = 1_024;
pub const MAX_WRAPPED_KEY: usize = 160;
pub const LOSS_BPS: i32 = -10_000;
pub const MAX_GAIN_BPS: i32 = 30_000;
/// Phantom flat calls added to every record: S = Σr / (n + SHRINK).
pub const SHRINK: i64 = 5;
pub const WEIGHT_CAP: i64 = 20;
const SCORE_CALLBACK_GAS: Gas = Gas::from_tgas(60);
const DAY_MS: u64 = 86_400_000;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Clubs,
    Calls,
    ClubCalls,
    Daily,
    Epochs,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ClubConfig {
    pub name: String,
    pub epoch_minutes: u32,
    pub epoch_budget: NearToken,
    /// Scored calls a caller needs in an epoch before they can be paid (10 normally).
    pub min_record: u32,
    /// Allowed call horizons in minutes, e.g. [60, 240, 1440, 4320].
    pub horizons_min: Vec<u32>,
    /// Minutes after the horizon before a sealed call can be marked unrevealed (1440 normally).
    pub grace_min: u32,
    pub max_calls_per_day: u32,
    /// OutLayer settings: the scoring job's public https URL, its sha256, and the OutLayer contract.
    pub scorer_wasm_url: String,
    pub scorer_wasm_hash: String,
    pub outlayer: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Member {
    pub account: AccountId,
    /// X25519 public key, base64 (44 chars), registered by the member.
    pub pubkey: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Club {
    pub id: u32,
    /// Usually a Sputnik DAO: it created the club and governs the roster, members and treasury.
    pub governor: AccountId,
    pub config: ClubConfig,
    pub started_at_ms: u64,
    pub escrow: NearToken,
    pub callers: Vec<AccountId>,
    pub members: Vec<Member>,
    pub call_count: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct WrappedKey {
    pub member: AccountId,
    pub key: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CallStatus {
    Sealed,
    Revealed { mint: String, by: AccountId, at_ms: u64 },
    Unrevealed { at_ms: u64 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Call {
    pub id: u64,
    pub club: u32,
    pub caller: AccountId,
    pub epoch: u64,
    pub posted_at_ms: u64,
    pub horizon_min: u32,
    /// hex sha256 of the exact plaintext bytes that `reveal` must present.
    pub commit: String,
    pub reveal_round: u64,
    /// age-armored tlock ciphertext, opens at `reveal_round`.
    pub tlock_ct: String,
    /// The call encrypted with a fresh per-call key (for members).
    pub member_ct: String,
    /// That per-call key sealed to each registered member's X25519 key.
    pub wrapped_keys: Vec<WrappedKey>,
    pub status: CallStatus,
    pub score_bps: Option<i32>,
    pub note: Option<String>,
}

/// What a revealed plaintext must contain. The commitment covers its exact bytes.
#[derive(Deserialize, Serialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct CallPayload {
    pub v: u8,
    pub club: u32,
    pub caller: AccountId,
    pub mint: String,
    pub horizon_min: u32,
    pub salt: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum EpochStatus {
    Settling,
    Settled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CallerResult {
    pub caller: AccountId,
    pub calls: u32,
    pub sum_bps: i64,
    pub score_bps: i64,
    pub eligible: bool,
    pub paid: NearToken,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct EpochResult {
    pub status: EpochStatus,
    pub budget: NearToken,
    pub paid: NearToken,
    pub callers: Vec<CallerResult>,
    pub settled_at_ms: u64,
}

/// One line of the scoring job's output.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct CallScore {
    pub id: u64,
    pub r_bps: i32,
    pub note: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct ScoreOut {
    pub ok: bool,
    pub results: Vec<CallScore>,
    pub error: Option<String>,
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
    clubs: Vector<Club>,
    calls: Vector<Call>,
    /// (club, index within club) -> call id
    club_calls: LookupMap<(u32, u32), u64>,
    /// (club, caller, UTC day) -> calls posted
    daily: LookupMap<(u32, AccountId, u64), u32>,
    epochs: LookupMap<(u32, u64), EpochResult>,
}

#[near]
impl SealedCalls {
    #[init]
    pub fn new() -> Self {
        Self {
            clubs: Vector::new(Key::Clubs),
            calls: Vector::new(Key::Calls),
            club_calls: LookupMap::new(Key::ClubCalls),
            daily: LookupMap::new(Key::Daily),
            epochs: LookupMap::new(Key::Epochs),
        }
    }

    // ---------------------------------------------------------------- governance (the DAO)

    /// Called by the club's DAO through one FunctionCall proposal. The attached deposit, minus
    /// storage, becomes the club's escrow.
    #[payable]
    pub fn create_club(&mut self, config: ClubConfig, callers: Vec<AccountId>, members: Vec<AccountId>) -> u32 {
        validate_config(&config);
        let start = env::storage_usage();
        let id = self.clubs.len();
        let club = Club {
            id,
            governor: env::predecessor_account_id(),
            config,
            started_at_ms: env::block_timestamp_ms(),
            escrow: NearToken::from_yoctonear(0),
            callers: dedup_capped(callers, MAX_CALLERS, "callers"),
            members: dedup_capped(members, MAX_MEMBERS, "members")
                .into_iter()
                .map(|account| Member { account, pubkey: None })
                .collect(),
            call_count: 0,
        };
        self.clubs.push(club);
        self.clubs.flush();
        let escrow = charge_storage(start, env::attached_deposit());
        self.clubs.get_mut(id).unwrap().escrow = escrow;
        emit("club_created", json!({ "club": id, "governor": env::predecessor_account_id(), "escrow": escrow }));
        id
    }

    pub fn set_callers(&mut self, club: u32, callers: Vec<AccountId>) {
        let c = self.governed(club);
        c.callers = dedup_capped(callers, MAX_CALLERS, "callers");
        emit("roster_changed", json!({ "club": club, "callers": c.callers }));
    }

    /// Replaces the member list. Members that stay keep their registered key.
    pub fn set_members(&mut self, club: u32, members: Vec<AccountId>) {
        let c = self.governed(club);
        let old = std::mem::take(&mut c.members);
        c.members = dedup_capped(members, MAX_MEMBERS, "members")
            .into_iter()
            .map(|account| {
                let pubkey = old.iter().find(|m| m.account == account).and_then(|m| m.pubkey.clone());
                Member { account, pubkey }
            })
            .collect();
        emit("members_changed", json!({ "club": club, "members": c.members.iter().map(|m| &m.account).collect::<Vec<_>>() }));
    }

    /// Anyone can add to a club's escrow.
    #[payable]
    pub fn fund(&mut self, club: u32) -> NearToken {
        let c = self.clubs.get_mut(club).expect("no such club");
        c.escrow = c.escrow.saturating_add(env::attached_deposit());
        emit("funded", json!({ "club": club, "by": env::predecessor_account_id(), "amount": env::attached_deposit() }));
        c.escrow
    }

    /// The governor takes unspent escrow back to its treasury (e.g. to refund members).
    pub fn withdraw(&mut self, club: u32, amount: NearToken) -> Promise {
        let governor = {
            let c = self.governed(club);
            assert!(amount <= c.escrow, "amount exceeds escrow");
            c.escrow = c.escrow.saturating_sub(amount);
            c.governor.clone()
        };
        emit("withdrawn", json!({ "club": club, "amount": amount }));
        Promise::new(governor).transfer(amount)
    }

    // ---------------------------------------------------------------- members

    /// A member registers (or rotates) their X25519 public key. Calls posted afterwards are
    /// wrapped to it; calls posted before are not.
    pub fn register_key(&mut self, club: u32, pubkey: String) {
        assert!(pubkey.len() == 44 && pubkey.ends_with('='), "pubkey must be a base64 32-byte X25519 key");
        let me = env::predecessor_account_id();
        let c = self.clubs.get_mut(club).expect("no such club");
        let m = c.members.iter_mut().find(|m| m.account == me).expect("not a member of this club");
        m.pubkey = Some(pubkey);
        emit("key_registered", json!({ "club": club, "member": me }));
    }

    // ---------------------------------------------------------------- callers

    /// Post a sealed call. Attach enough NEAR for storage (about 0.05 NEAR; the rest is refunded).
    #[payable]
    pub fn post_call(
        &mut self,
        club: u32,
        horizon_min: u32,
        commit: String,
        reveal_round: u64,
        tlock_ct: String,
        member_ct: String,
        wrapped_keys: Vec<WrappedKey>,
    ) -> u64 {
        let start = env::storage_usage();
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let c = self.clubs.get(club).expect("no such club").clone();
        assert!(c.callers.contains(&caller), "not on this club's caller roster");
        assert!(c.config.horizons_min.contains(&horizon_min), "horizon not allowed in this club");
        assert!(is_hex64(&commit), "commit must be 64 lowercase hex chars");
        assert!(!tlock_ct.is_empty() && tlock_ct.len() <= MAX_TLOCK_CT, "tlock_ct size");
        assert!(!member_ct.is_empty() && member_ct.len() <= MAX_MEMBER_CT, "member_ct size");
        check_round(reveal_round, now, horizon_min);

        // Every registered member must get the call, and nobody else.
        let expected: Vec<&AccountId> = c.members.iter().filter(|m| m.pubkey.is_some()).map(|m| &m.account).collect();
        assert_eq!(wrapped_keys.len(), expected.len(), "wrap the call key to every registered member");
        for w in &wrapped_keys {
            assert!(expected.contains(&&w.member), "wrapped key for a non-member: {}", w.member);
            assert!(!w.key.is_empty() && w.key.len() <= MAX_WRAPPED_KEY, "wrapped key size");
        }
        let mut seen: Vec<&AccountId> = wrapped_keys.iter().map(|w| &w.member).collect();
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), wrapped_keys.len(), "duplicate wrapped key");

        let day_key = (club, caller.clone(), now / DAY_MS);
        let today = self.daily.get(&day_key).copied().unwrap_or(0);
        assert!(today < c.config.max_calls_per_day, "daily call limit reached");
        self.daily.insert(day_key, today + 1);

        let id = self.calls.len() as u64;
        let epoch = (now - c.started_at_ms) / (c.config.epoch_minutes as u64 * 60_000);
        self.calls.push(Call {
            id,
            club,
            caller: caller.clone(),
            epoch,
            posted_at_ms: now,
            horizon_min,
            commit: commit.clone(),
            reveal_round,
            tlock_ct,
            member_ct,
            wrapped_keys,
            status: CallStatus::Sealed,
            score_bps: None,
            note: None,
        });
        let cm = self.clubs.get_mut(club).unwrap();
        self.club_calls.insert((club, cm.call_count), id);
        cm.call_count += 1;
        self.calls.flush();
        self.club_calls.flush();
        self.daily.flush();
        self.clubs.flush();
        let refund = charge_storage(start, env::attached_deposit());
        if refund.as_yoctonear() > 0 {
            Promise::new(caller.clone()).transfer(refund).detach();
        }
        emit("call_posted", json!({
            "club": club, "call": id, "caller": caller, "epoch": epoch,
            "horizon_min": horizon_min, "opens_at_ms": now + horizon_min as u64 * 60_000,
            "reveal_round": reveal_round, "commit": commit,
        }));
        id
    }

    // ---------------------------------------------------------------- anyone

    /// Publish a call after its horizon. Anyone can do it: from the drand-opened tlock copy, or a
    /// member from their own decrypted copy. Only the exact committed plaintext is accepted.
    pub fn reveal(&mut self, call_id: u64, plaintext: String) {
        let now = env::block_timestamp_ms();
        let call = self.calls.get_mut(call_id as u32).expect("no such call");
        assert_eq!(call.status, CallStatus::Sealed, "call is not sealed");
        assert!(now >= opens_at(call), "call is still within its horizon");
        assert_eq!(hex(&env::sha256(plaintext.as_bytes())), call.commit, "plaintext does not match the commitment");
        let p: CallPayload = serde_json::from_str(&plaintext).expect("plaintext is not a call payload");
        assert_eq!(p.v, 1, "unsupported payload version");
        assert_eq!(p.club, call.club, "payload is for another club");
        assert_eq!(p.caller, call.caller, "payload is for another caller");
        assert_eq!(p.horizon_min, call.horizon_min, "payload horizon differs");
        assert!(is_solana_mint(&p.mint), "mint is not a Solana address");
        call.status = CallStatus::Revealed { mint: p.mint.clone(), by: env::predecessor_account_id(), at_ms: now };
        emit("call_revealed", json!({ "call": call_id, "club": call.club, "caller": call.caller, "mint": p.mint, "by": env::predecessor_account_id() }));
    }

    /// After the grace period a call nobody could reveal is final and scores −100%.
    pub fn mark_unrevealed(&mut self, call_id: u64) {
        let now = env::block_timestamp_ms();
        let grace_ms = {
            let call = self.calls.get(call_id as u32).expect("no such call");
            self.clubs.get(call.club).unwrap().config.grace_min as u64 * 60_000
        };
        let call = self.calls.get_mut(call_id as u32).unwrap();
        assert_eq!(call.status, CallStatus::Sealed, "call is not sealed");
        assert!(now >= opens_at(call) + grace_ms, "grace period not over");
        call.status = CallStatus::Unrevealed { at_ms: now };
        call.score_bps = Some(LOSS_BPS);
        call.note = Some("unrevealed".into());
        emit("call_unrevealed", json!({ "call": call_id, "club": call.club, "caller": call.caller }));
    }

    /// Score an ended epoch and pay callers. Anyone can call it once every call in the epoch is
    /// revealed or marked unrevealed. Attach OutLayer's compute deposit (unused part is refunded
    /// by OutLayer to the caller of this method).
    #[payable]
    pub fn settle(&mut self, club: u32, epoch: u64) -> PromiseOrValue<Option<EpochResult>> {
        let now = env::block_timestamp_ms();
        let c = self.clubs.get(club).expect("no such club").clone();
        let epoch_ms = c.config.epoch_minutes as u64 * 60_000;
        assert!(now >= c.started_at_ms + (epoch + 1) * epoch_ms, "epoch has not ended");
        if let Some(e) = self.epochs.get(&(club, epoch)) {
            assert!(e.status != EpochStatus::Settled, "epoch already settled");
            assert!(e.status != EpochStatus::Settling, "epoch settlement in progress");
        }
        let ids = self.epoch_call_ids(club, epoch);
        for id in &ids {
            assert!(self.calls.get(*id as u32).unwrap().status != CallStatus::Sealed, "call {id} is still sealed");
        }
        self.mark_duplicates(&ids);

        let to_score: Vec<u64> = ids
            .iter()
            .copied()
            .filter(|id| {
                let call = self.calls.get(*id as u32).unwrap();
                matches!(call.status, CallStatus::Revealed { .. }) && call.score_bps.is_none()
            })
            .collect();

        if to_score.is_empty() {
            let result = self.finish_epoch(club, epoch);
            return PromiseOrValue::Value(Some(result));
        }

        let input: Vec<_> = to_score
            .iter()
            .map(|id| {
                let call = self.calls.get(*id as u32).unwrap();
                let mint = match &call.status { CallStatus::Revealed { mint, .. } => mint.clone(), _ => unreachable!() };
                json!({ "id": id, "mint": mint, "posted_at_ms": call.posted_at_ms, "horizon_min": call.horizon_min })
            })
            .collect();
        let deposit = env::attached_deposit();
        assert!(deposit.as_yoctonear() > 0, "attach a deposit for OutLayer compute");
        self.epochs.insert(
            (club, epoch),
            EpochResult { status: EpochStatus::Settling, budget: NearToken::from_yoctonear(0), paid: NearToken::from_yoctonear(0), callers: vec![], settled_at_ms: 0 },
        );
        emit("settle_requested", json!({ "club": club, "epoch": epoch, "calls": to_score }));

        let source = json!({ "WasmUrl": { "url": c.config.scorer_wasm_url, "hash": c.config.scorer_wasm_hash, "build_target": "wasm32-wasip2" } });
        let limits = json!({ "max_instructions": 10_000_000_000u64, "max_memory_mb": 256u32, "max_execution_seconds": 120u64 });
        let job_input = json!({ "calls": input, "reference_usd": 500, "liquidity_floor_usd": 100_000 });
        PromiseOrValue::Promise(
            ext_outlayer::ext(c.config.outlayer.clone())
                .with_attached_deposit(deposit)
                .with_unused_gas_weight(1)
                .request_execution(source, Some(limits), Some(job_input.to_string()), None, Some("Json".into()), Some(env::predecessor_account_id()), None)
                .then(Self::ext(env::current_account_id()).with_static_gas(SCORE_CALLBACK_GAS).on_scores(club, epoch, to_score)),
        )
    }

    #[private]
    pub fn on_scores(
        &mut self,
        club: u32,
        epoch: u64,
        ids: Vec<u64>,
        #[callback_result] result: Result<Option<ScoreOut>, PromiseError>,
    ) -> Option<EpochResult> {
        let out = match result {
            Ok(Some(o)) if o.ok => o,
            other => {
                let why = match other {
                    Ok(Some(o)) => o.error.unwrap_or_else(|| "scorer reported failure".into()),
                    Ok(None) => "scoring job failed or returned nothing".into(),
                    Err(_) => "OutLayer request failed".into(),
                };
                self.epochs.remove(&(club, epoch));
                emit("settle_failed", json!({ "club": club, "epoch": epoch, "reason": why }));
                return None; // anyone can call settle again
            }
        };
        if let Err(why) = check_scores(&ids, &out.results) {
            self.epochs.remove(&(club, epoch));
            emit("settle_failed", json!({ "club": club, "epoch": epoch, "reason": why }));
            return None;
        }
        for s in &out.results {
            let call = self.calls.get_mut(s.id as u32).unwrap();
            call.score_bps = Some(s.r_bps.clamp(LOSS_BPS, MAX_GAIN_BPS));
            call.note = Some(s.note.chars().take(64).collect());
        }
        Some(self.finish_epoch(club, epoch))
    }

    // ---------------------------------------------------------------- views

    pub fn get_club(&self, club: u32) -> Option<Club> {
        self.clubs.get(club).cloned()
    }

    pub fn get_call(&self, call_id: u64) -> Option<Call> {
        self.calls.get(call_id as u32).cloned()
    }

    /// Calls in a club, newest first.
    pub fn list_calls(&self, club: u32, from_index: Option<u32>, limit: Option<u32>) -> Vec<Call> {
        let Some(c) = self.clubs.get(club) else { return vec![] };
        let limit = limit.unwrap_or(50).min(100);
        let top = from_index.unwrap_or(c.call_count).min(c.call_count);
        (0..top)
            .rev()
            .take(limit as usize)
            .filter_map(|i| self.club_calls.get(&(club, i)))
            .filter_map(|id| self.calls.get(*id as u32).cloned())
            .collect()
    }

    pub fn get_epoch(&self, club: u32, epoch: u64) -> Option<EpochResult> {
        self.epochs.get(&(club, epoch)).cloned()
    }

    pub fn current_epoch(&self, club: u32) -> u64 {
        let c = self.clubs.get(club).expect("no such club");
        (env::block_timestamp_ms() - c.started_at_ms) / (c.config.epoch_minutes as u64 * 60_000)
    }

    // ---------------------------------------------------------------- internals

    fn governed(&mut self, club: u32) -> &mut Club {
        let c = self.clubs.get_mut(club).expect("no such club");
        assert_eq!(env::predecessor_account_id(), c.governor, "only the club governor");
        c
    }

    fn epoch_call_ids(&self, club: u32, epoch: u64) -> Vec<u64> {
        let n = self.clubs.get(club).unwrap().call_count;
        (0..n)
            .filter_map(|i| self.club_calls.get(&(club, i)).copied())
            .filter(|id| self.calls.get(*id as u32).unwrap().epoch == epoch)
            .collect()
    }

    /// A second call on the same token by the same caller while the first is still open scores
    /// −100%. (The token is sealed at posting, so this can only be enforced after reveal.)
    fn mark_duplicates(&mut self, ids: &[u64]) {
        let mut dups = vec![];
        for (i, a) in ids.iter().enumerate() {
            let ca = self.calls.get(*a as u32).unwrap();
            let CallStatus::Revealed { mint: ma, .. } = &ca.status else { continue };
            if ca.score_bps.is_some() {
                continue;
            }
            for b in &ids[..i] {
                let cb = self.calls.get(*b as u32).unwrap();
                if let CallStatus::Revealed { mint: mb, .. } = &cb.status {
                    if cb.caller == ca.caller && mb == ma && ca.posted_at_ms < opens_at(cb) {
                        dups.push(*a);
                        break;
                    }
                }
            }
        }
        for id in dups {
            let call = self.calls.get_mut(id as u32).unwrap();
            call.score_bps = Some(LOSS_BPS);
            call.note = Some("duplicate".into());
        }
    }

    fn finish_epoch(&mut self, club: u32, epoch: u64) -> EpochResult {
        let ids = self.epoch_call_ids(club, epoch);
        let scored: Vec<(AccountId, i32)> = ids
            .iter()
            .map(|id| {
                let call = self.calls.get(*id as u32).unwrap();
                (call.caller.clone(), call.score_bps.unwrap_or(LOSS_BPS))
            })
            .collect();
        let (min_record, budget_cfg, escrow) = {
            let c = self.clubs.get(club).unwrap();
            (c.config.min_record, c.config.epoch_budget, c.escrow)
        };
        let budget = if budget_cfg < escrow { budget_cfg } else { escrow };
        let mut results = aggregate(&scored, min_record);
        let payouts = split_budget(&results, budget);
        let mut paid = NearToken::from_yoctonear(0);
        for (r, amount) in results.iter_mut().zip(payouts) {
            r.paid = amount;
            if amount.as_yoctonear() > 0 {
                paid = paid.saturating_add(amount);
                Promise::new(r.caller.clone()).transfer(amount).detach();
                emit("payout", json!({ "club": club, "epoch": epoch, "caller": r.caller, "amount": amount, "score_bps": r.score_bps }));
            }
        }
        let c = self.clubs.get_mut(club).unwrap();
        c.escrow = c.escrow.saturating_sub(paid);
        let result = EpochResult { status: EpochStatus::Settled, budget, paid, callers: results, settled_at_ms: env::block_timestamp_ms() };
        self.epochs.insert((club, epoch), result.clone());
        emit("epoch_settled", json!({ "club": club, "epoch": epoch, "budget": budget, "paid": paid }));
        result
    }
}

// -------------------------------------------------------------------- pure helpers

/// Per-caller record for an epoch: S = Σr / (n + SHRINK), in basis points.
pub fn aggregate(scored: &[(AccountId, i32)], min_record: u32) -> Vec<CallerResult> {
    let mut out: Vec<CallerResult> = vec![];
    for (caller, r) in scored {
        let e = match out.iter_mut().position(|x| &x.caller == caller) {
            Some(i) => &mut out[i],
            None => {
                out.push(CallerResult { caller: caller.clone(), calls: 0, sum_bps: 0, score_bps: 0, eligible: false, paid: NearToken::from_yoctonear(0) });
                out.last_mut().unwrap()
            }
        };
        e.calls += 1;
        e.sum_bps += *r as i64;
    }
    for e in &mut out {
        e.score_bps = e.sum_bps / (e.calls as i64 + SHRINK);
        e.eligible = e.calls >= min_record && e.score_bps > 0;
    }
    out
}

/// Budget split in proportion to S × min(n, WEIGHT_CAP) among eligible callers. Rounds down.
pub fn split_budget(results: &[CallerResult], budget: NearToken) -> Vec<NearToken> {
    let weights: Vec<u128> = results
        .iter()
        .map(|r| if r.eligible { (r.score_bps * (r.calls as i64).min(WEIGHT_CAP)) as u128 } else { 0 })
        .collect();
    let total: u128 = weights.iter().sum();
    weights
        .iter()
        .map(|w| if total == 0 { NearToken::from_yoctonear(0) } else { NearToken::from_yoctonear(budget.as_yoctonear() / total * w + budget.as_yoctonear() % total * w / total) })
        .collect()
}

pub fn check_scores(ids: &[u64], results: &[CallScore]) -> Result<(), String> {
    if results.len() != ids.len() {
        return Err(format!("expected {} scores, got {}", ids.len(), results.len()));
    }
    for id in ids {
        if results.iter().filter(|s| s.id == *id).count() != 1 {
            return Err(format!("call {id} missing or repeated in scores"));
        }
    }
    Ok(())
}

/// The drand round must open no earlier than the horizon's end and at most ROUND_SLACK_S after.
pub fn check_round(round: u64, posted_ms: u64, horizon_min: u32) {
    assert!(round >= 1, "bad round");
    let round_s = QUICKNET_GENESIS_S + (round - 1) * QUICKNET_PERIOD_S;
    let end_s = (posted_ms + horizon_min as u64 * 60_000).div_ceil(1000);
    assert!(round_s >= end_s, "reveal round opens before the horizon ends");
    assert!(round_s <= end_s + ROUND_SLACK_S, "reveal round is too far after the horizon");
}

fn opens_at(call: &Call) -> u64 {
    call.posted_at_ms + call.horizon_min as u64 * 60_000
}

fn validate_config(c: &ClubConfig) {
    assert!(!c.name.is_empty() && c.name.len() <= 64, "name length");
    assert!(c.epoch_minutes >= 10, "epoch too short");
    assert!(!c.horizons_min.is_empty() && c.horizons_min.iter().all(|h| (10..=4320).contains(h)), "horizons must be 10..=4320 minutes");
    assert!(c.horizons_min.iter().all(|h| *h <= c.epoch_minutes), "a horizon cannot exceed the epoch");
    assert!(c.max_calls_per_day >= 1 && c.max_calls_per_day <= 20, "max_calls_per_day 1..=20");
    assert!(c.min_record >= 1, "min_record >= 1");
    assert!(c.scorer_wasm_url.starts_with("https://"), "scorer_wasm_url must be https");
    assert!(is_hex64(&c.scorer_wasm_hash), "scorer_wasm_hash must be 64 lowercase hex chars");
}

fn dedup_capped(mut v: Vec<AccountId>, cap: usize, what: &str) -> Vec<AccountId> {
    let mut seen = vec![];
    v.retain(|a| if seen.contains(a) { false } else { seen.push(a.clone()); true });
    assert!(v.len() <= cap, "too many {what} (max {cap})");
    v
}

/// Charges storage added since `start` against `deposit`; returns what is left.
fn charge_storage(start: u64, deposit: NearToken) -> NearToken {
    let used = env::storage_usage().saturating_sub(start) as u128;
    let cost = env::storage_byte_cost().saturating_mul(used);
    assert!(deposit >= cost, "attach at least {} for storage", cost.exact_amount_display());
    deposit.saturating_sub(cost)
}

pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn is_solana_mint(s: &str) -> bool {
    const B58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    (32..=44).contains(&s.len()) && s.chars().all(|ch| B58.contains(ch))
}

fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    bytes.iter().flat_map(|b| [H[(b >> 4) as usize] as char, H[(b & 15) as usize] as char]).collect()
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "sealedcalls", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

#[cfg(test)]
mod tests;
