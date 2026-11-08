use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const T0_MS: u64 = 1_762_560_000_000; // 2025-11-08
const WEEK_MS: u64 = 7 * DAY_MS;
const PK_A: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PK_B: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, at_ms: u64, deposit_yocto: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("app.testnet"))
        .predecessor_account_id(acc(who))
        .block_timestamp(at_ms * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .build());
}

fn near(n: u128) -> u128 {
    n * 10u128.pow(24)
}

fn config() -> Config {
    Config {
        owner: acc("owner.testnet"),
        period_minutes: 10_080,
        grace_min: 60,
        min_signals: 1,
        max_signals_per_day: 5,
        scorer_wasm_url: "https://example.com/scorer.wasm".into(),
        scorer_wasm_hash: "a".repeat(64),
        outlayer: acc("outlayer.testnet"),
        reference_usd: 500,
        liquidity_floor_usd: 100_000,
    }
}

fn plans() -> Vec<Plan> {
    vec![
        Plan { days: 7, price: NearToken::from_near(2) },
        Plan { days: 14, price: NearToken::from_near(3) },
        Plan { days: 30, price: NearToken::from_near(6) },
    ]
}

fn round_for(posted_ms: u64, valid_min: u32) -> u64 {
    let end_s = (posted_ms + valid_min as u64 * 60_000).div_ceil(1000);
    (end_s - QUICKNET_GENESIS_S).div_ceil(QUICKNET_PERIOD_S) + 1
}

fn body_json(side: &str, lev: u32, lo: &str, hi: &str, tps: &[&str], sl: &str) -> String {
    let tps: Vec<String> = tps.iter().map(|t| format!("\"{t}\"")).collect();
    format!(
        r#""market":{{"venue":"hyperliquid","address":"ETH","symbol":"ETH"}},"side":"{side}","leverage":{lev},"entry_low":"{lo}","entry_high":"{hi}","tps":[{}],"sl":"{sl}","msg":"breakout retest""#,
        tps.join(",")
    )
}

fn payload(valid_min: u32, body: &str, salt: &str) -> String {
    format!(r#"{{"v":2,"channel":0,"creator":"alice.testnet","valid_min":{valid_min},{body},"salt":"{salt}"}}"#)
}

fn commit_of(p: &str) -> String {
    hex(&env::sha256(p.as_bytes()))
}

/// Channel 0 by alice. Members: m1 (7-day plan, key), m2 (14-day plan, no key).
fn setup() -> SealedCalls {
    ctx("owner.testnet", T0_MS, 0);
    let mut c = SealedCalls::new(config());
    ctx("alice.testnet", T0_MS, near(1));
    c.create_channel("Alice Alpha".into(), "ETH and majors".into(), plans(), 25);
    ctx("m1.testnet", T0_MS + 1000, near(3));
    c.subscribe(0, 0);
    c.register_key(0, PK_A.into());
    ctx("m2.testnet", T0_MS + 2000, near(4));
    c.subscribe(0, 1);
    c
}

fn post(c: &mut SealedCalls, at_ms: u64, valid_min: u32, body: &str, salt: &str, keys: Vec<WrappedKey>) -> (u64, String) {
    let p = payload(valid_min, body, salt);
    ctx("alice.testnet", at_ms, near(1));
    let id = c.post_signal(0, valid_min, commit_of(&p), round_for(at_ms, valid_min), "-----BEGIN AGE ENCRYPTED FILE-----x".into(), "member-ct".into(), keys);
    (id, p)
}

fn m1_key() -> Vec<WrappedKey> {
    vec![WrappedKey { member: acc("m1.testnet"), key: "wrapped".into() }]
}

fn good_long() -> String {
    body_json("long", 5, "3000", "3050", &["3200", "3400"], "2900")
}

fn score(id: u64, r: i32, outcome: &str) -> SignalScore {
    SignalScore { id, r_bps: r, outcome: outcome.into(), fill_price: Some("3010".into()), exit_price: Some("3200".into()), cost_bps: Some(9) }
}

fn ok(results: Vec<SignalScore>) -> Result<Option<ScoreOut>, PromiseError> {
    Ok(Some(ScoreOut { ok: true, results, error: None }))
}

fn logs_have(event: &str) -> bool {
    get_logs().iter().any(|l| l.contains(&format!("\"event\":\"{event}\"")))
}

// ------------------------------------------------------------------ channels and subscriptions

#[test]
fn anyone_creates_a_channel() {
    let c = setup();
    let ch = c.get_channel(0).unwrap();
    assert_eq!(ch.creator, acc("alice.testnet"));
    assert_eq!(ch.plans.len(), 3);
    assert_eq!(c.subscribers(0).len(), 2);
}

#[test]
fn subscription_pays_half_now_and_holds_half() {
    let c = setup();
    // m1: 2 NEAR for 7 days -> 1 now, 1 held. m2: 3 NEAR for 14 days -> 1.5 now, 1.5 held.
    let earned = c.get_channel(0).unwrap().stats.earned.as_yoctonear();
    assert!(earned >= near(25) / 10 && earned <= near(25) / 10 + 10, "earned {earned}");
    let held: u128 = (0..4).map(|p| c.period_held(0, p).as_yoctonear()).sum();
    assert!(held <= near(25) / 10 && held + 10 >= near(25) / 10, "held {held}");
    // m1's week starts 1 s into period 0 and ends 1 s into period 1.
    assert!(c.period_held(0, 0).as_yoctonear() > near(1));
    assert!(c.period_held(0, 2).as_yoctonear() > 0); // m2's 14 days reach period 2
    assert_eq!(c.period_held(0, 3).as_yoctonear(), 0);
}

#[test]
fn long_subscription_spreads_evenly_over_full_periods() {
    let mut c = setup();
    ctx("m3.testnet", T0_MS, near(7)); // exactly at a period boundary: 30 days = 4 full weeks + 2 days
    c.subscribe(0, 2);
    let m3 = c.get_member(0, acc("m3.testnet")).unwrap();
    let held = m3.subs[0].held.as_yoctonear();
    assert_eq!(held, near(3));
    let ch = c.get_channel(0).unwrap();
    let per_week: Vec<u128> = (0..5).map(|p| c.share(&ch, &m3.subs[0], p)).collect();
    assert_eq!(per_week[1], per_week[2]);
    assert_eq!(per_week[2], per_week[3]);
    assert!(per_week[4] < per_week[3]);
    let total: u128 = per_week.iter().sum();
    assert!(held - total < 10);
}

#[test]
fn extending_starts_after_the_current_subscription() {
    let mut c = setup();
    ctx("m1.testnet", T0_MS + DAY_MS, near(3));
    let until = c.subscribe(0, 0);
    assert_eq!(until, T0_MS + 1000 + 2 * WEEK_MS);
    assert_eq!(c.get_member(0, acc("m1.testnet")).unwrap().subs.len(), 2);
}

#[test]
#[should_panic(expected = "attach at least")]
fn subscribing_needs_the_full_price() {
    let mut c = setup();
    ctx("m3.testnet", T0_MS, near(1));
    c.subscribe(0, 0);
}

#[test]
#[should_panic(expected = "channel is full")]
fn channel_cap_counts_active_subscribers() {
    ctx("owner.testnet", T0_MS, 0);
    let mut c = SealedCalls::new(config());
    ctx("alice.testnet", T0_MS, near(1));
    c.create_channel("Tiny".into(), "".into(), plans(), 1);
    ctx("m1.testnet", T0_MS, near(3));
    c.subscribe(0, 0);
    ctx("m2.testnet", T0_MS, near(3));
    c.subscribe(0, 0);
}

#[test]
fn expired_seat_frees_up() {
    ctx("owner.testnet", T0_MS, 0);
    let mut c = SealedCalls::new(config());
    ctx("alice.testnet", T0_MS, near(1));
    c.create_channel("Tiny".into(), "".into(), plans(), 1);
    ctx("m1.testnet", T0_MS, near(3));
    c.subscribe(0, 0);
    ctx("m2.testnet", T0_MS + WEEK_MS + 1, near(3));
    c.subscribe(0, 0);
    assert_eq!(c.subscribers(0).len(), 1);
}

// ------------------------------------------------------------------ signals

#[test]
fn signal_goes_to_active_subscribers_with_a_key() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS + 10_000, 240, &good_long(), "s1", m1_key());
    let s = c.get_signal(id).unwrap();
    assert_eq!(s.status, SignalStatus::Sealed);
    assert_eq!(s.period, 0);
    assert!(logs_have("signal_posted"));
}

#[test]
#[should_panic(expected = "wrap the signal key to every active subscriber")]
fn signal_must_reach_every_reader() {
    let mut c = setup();
    ctx("m2.testnet", T0_MS, 0);
    c.register_key(0, PK_B.into());
    post(&mut c, T0_MS + 10_000, 240, &good_long(), "s1", m1_key());
}

#[test]
fn expired_subscriber_is_not_a_reader() {
    let mut c = setup();
    // After 8 days m1 (7-day plan) has expired; m2 (no key) is still active.
    let (id, _) = post(&mut c, T0_MS + 8 * DAY_MS, 60, &good_long(), "s1", vec![]);
    assert!(c.get_signal(id).unwrap().wrapped_keys.is_empty());
}

#[test]
#[should_panic(expected = "only the channel's creator posts signals")]
fn only_the_creator_posts() {
    let mut c = setup();
    ctx("m1.testnet", T0_MS, near(1));
    c.post_signal(0, 60, "b".repeat(64), round_for(T0_MS, 60), "x".into(), "y".into(), m1_key());
}

#[test]
#[should_panic(expected = "validity must be")]
fn validity_has_bounds() {
    let mut c = setup();
    post(&mut c, T0_MS, 10, &good_long(), "s1", m1_key());
}

#[test]
#[should_panic(expected = "reveal round opens before validity ends")]
fn reveal_round_cannot_open_early() {
    let mut c = setup();
    ctx("alice.testnet", T0_MS, near(1));
    c.post_signal(0, 240, "b".repeat(64), round_for(T0_MS, 60), "x".into(), "y".into(), m1_key());
}

#[test]
#[should_panic(expected = "daily signal limit reached")]
fn daily_limit() {
    let mut c = setup();
    for i in 0..6 {
        post(&mut c, T0_MS + 10_000 + i, 60, &good_long(), &format!("s{i}"), m1_key());
    }
}

#[test]
#[should_panic(expected = "signal is still valid")]
fn no_reveal_before_validity_ends() {
    let mut c = setup();
    let (id, p) = post(&mut c, T0_MS + 10_000, 240, &good_long(), "s1", m1_key());
    ctx("anyone.testnet", T0_MS + 10_000 + 239 * 60_000, 0);
    c.reveal(id, p);
}

#[test]
#[should_panic(expected = "text does not match the commitment")]
fn reveal_needs_the_committed_text() {
    let mut c = setup();
    let (id, p) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("anyone.testnet", T0_MS + 10_000 + 60 * 60_000, 0);
    c.reveal(id, p.replace("3200", "3300"));
}

#[test]
fn reveal_publishes_the_signal() {
    let mut c = setup();
    let (id, p) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("anyone.testnet", T0_MS + 10_000 + 60 * 60_000, 0);
    c.reveal(id, p);
    let s = c.get_signal(id).unwrap();
    let b = s.body.unwrap();
    assert_eq!(b.side, "long");
    assert_eq!(b.leverage, 5);
    assert_eq!(b.tps, vec!["3200", "3400"]);
    assert_eq!(b.msg, "breakout retest");
    assert!(s.r_bps.is_none());
}

#[test]
fn invalid_committed_signal_scores_minus_100() {
    let mut c = setup();
    // Stop loss above the entry on a long: committed, so it is published, but it scores −100%.
    let bad = body_json("long", 5, "3000", "3050", &["3200"], "3100");
    let (id, p) = post(&mut c, T0_MS + 10_000, 60, &bad, "s1", m1_key());
    ctx("anyone.testnet", T0_MS + 10_000 + 60 * 60_000, 0);
    c.reveal(id, p);
    let s = c.get_signal(id).unwrap();
    assert!(s.body.is_none());
    assert_eq!(s.r_bps, Some(LOSS_BPS));
    assert_eq!(s.outcome.as_deref(), Some("invalid"));
}

#[test]
fn unrevealed_after_grace_scores_minus_100() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("anyone.testnet", T0_MS + 10_000 + 120 * 60_000, 0);
    c.mark_unrevealed(id);
    assert_eq!(c.get_signal(id).unwrap().r_bps, Some(LOSS_BPS));
}

#[test]
fn body_rules() {
    let mk = |venue: &str, net: Option<&str>, side: &str, lev: u32, lo: &str, hi: &str, tps: &[&str], sl: &str| SignalBody {
        market: Market { venue: venue.into(), network: net.map(|n| n.into()), address: "ETH".into(), symbol: "ETH".into() },
        side: side.into(),
        leverage: lev,
        entry_low: lo.into(),
        entry_high: hi.into(),
        tps: tps.iter().map(|t| t.to_string()).collect(),
        sl: sl.into(),
        msg: String::new(),
    };
    assert!(validate_body(&mk("hyperliquid", None, "long", 10, "100", "101", &["110", "120"], "95")).is_ok());
    assert!(validate_body(&mk("hyperliquid", None, "short", 3, "100", "101", &["90", "80"], "105")).is_ok());
    assert!(validate_body(&mk("hyperliquid", None, "short", 3, "100", "101", &["80", "90"], "105")).is_err()); // tps must fall
    assert!(validate_body(&mk("hyperliquid", None, "long", 51, "100", "101", &["110"], "95")).is_err());
    assert!(validate_body(&mk("hyperliquid", None, "long", 2, "102", "101", &["110"], "95")).is_err());
    assert!(validate_body(&mk("hyperliquid", None, "long", 2, "100", "101", &["101"], "95")).is_err());
    assert!(validate_body(&mk("gecko", Some("solana"), "long", 1, "0.00002", "0.000021", &["0.00003"], "0.000015")).is_ok());
    assert!(validate_body(&mk("gecko", Some("solana"), "short", 1, "1", "1", &["0.5"], "2")).is_err());
    assert!(validate_body(&mk("gecko", Some("solana"), "long", 3, "1", "1", &["2"], "0.5")).is_err());
    assert!(validate_body(&mk("gecko", None, "long", 1, "1", "1", &["2"], "0.5")).is_err());
    assert!(validate_body(&mk("hyperliquid", None, "long", 1, "-1", "1", &["2"], "0.5")).is_err());
    assert!(validate_body(&mk("hyperliquid", None, "long", 1, "1e3", "2000", &["3000"], "500")).is_err());
}

// ------------------------------------------------------------------ settlement

#[test]
#[should_panic(expected = "period 0 has not ended")]
fn period_must_end_before_settling() {
    let mut c = setup();
    ctx("anyone.testnet", T0_MS + WEEK_MS - 1, 0);
    c.settle(0);
}

#[test]
#[should_panic(expected = "is still sealed")]
fn sealed_signal_blocks_settlement() {
    let mut c = setup();
    post(&mut c, T0_MS + WEEK_MS - 60 * 60_000, 240, &good_long(), "s1", m1_key());
    ctx("anyone.testnet", T0_MS + WEEK_MS + 1, near(1) / 2);
    c.settle(0);
}

#[test]
fn quiet_period_refunds_subscribers() {
    let mut c = setup();
    ctx("anyone.testnet", T0_MS + WEEK_MS, 0);
    let r = match c.settle(0) {
        PromiseOrValue::Value(Some(r)) => r,
        _ => panic!("expected an immediate result"),
    };
    assert!(!r.released);
    assert_eq!(r.signals, 0);
    let (m1_amt, m1_periods) = c.claimable(0, acc("m1.testnet"));
    let (m2_amt, _) = c.claimable(0, acc("m2.testnet"));
    assert_eq!(m1_periods, vec![0]);
    assert_eq!(m1_amt.as_yoctonear() + m2_amt.as_yoctonear(), r.held.as_yoctonear());
    ctx("m1.testnet", T0_MS + WEEK_MS + 5, 0);
    assert_eq!(c.claim_refund(0), m1_amt);
    assert_eq!(c.claimable(0, acc("m1.testnet")).0.as_yoctonear(), 0);
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn refund_cannot_be_claimed_twice() {
    let mut c = setup();
    ctx("anyone.testnet", T0_MS + WEEK_MS, 0);
    let _ = c.settle(0);
    ctx("m1.testnet", T0_MS + WEEK_MS + 5, 0);
    c.claim_refund(0);
    c.claim_refund(0);
}

fn settle_with(c: &mut SealedCalls, at_ms: u64, results: Vec<SignalScore>) -> PeriodResult {
    ctx("anyone.testnet", at_ms, near(1) / 2);
    let ids: Vec<u64> = results.iter().map(|r| r.id).collect();
    match c.settle(0) {
        PromiseOrValue::Promise(_) => {}
        PromiseOrValue::Value(_) => panic!("expected an OutLayer request"),
    }
    assert!(logs_have("settle_requested"));
    ctx("app.testnet", at_ms + 10_000, 0);
    let p = c.get_channel(0).unwrap().next_period;
    c.on_scores(0, p, ids, ok(results)).expect("scored")
}

#[test]
fn positive_week_releases_the_held_half_to_the_creator() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    let (b, pb) = post(&mut c, T0_MS + 20_000, 60, &body_json("short", 2, "3000", "3010", &["2900"], "3100"), "s2", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, 0);
    c.reveal(a, pa);
    c.reveal(b, pb);
    let held0 = c.period_held(0, 0);
    let before = c.get_channel(0).unwrap().stats.earned;
    let r = settle_with(&mut c, T0_MS + WEEK_MS + 1, vec![score(a, 1500, "tp1"), score(b, -400, "sl")]);
    assert!(r.released);
    assert_eq!(r.signals, 2);
    assert_eq!(r.score_bps, 1100 / 7);
    assert_eq!(r.held, held0);
    let ch = c.get_channel(0).unwrap();
    assert_eq!(ch.stats.earned, before.saturating_add(held0));
    assert_eq!(ch.stats.wins, 1);
    assert_eq!(ch.next_period, 1);
    assert_eq!(c.get_signal(a).unwrap().outcome.as_deref(), Some("tp1"));
    assert_eq!(c.claimable(0, acc("m1.testnet")).0.as_yoctonear(), 0);
}

#[test]
fn negative_week_lets_subscribers_claim() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, 0);
    c.reveal(a, pa);
    let r = settle_with(&mut c, T0_MS + WEEK_MS + 1, vec![score(a, -10_000, "liquidated")]);
    assert!(!r.released);
    let (m1, _) = c.claimable(0, acc("m1.testnet"));
    let (m2, _) = c.claimable(0, acc("m2.testnet"));
    assert_eq!(m1.as_yoctonear() + m2.as_yoctonear(), r.held.as_yoctonear());
}

#[test]
fn periods_settle_in_order_and_levels_carry() {
    let mut c = setup();
    ctx("m3.testnet", T0_MS, near(7));
    c.subscribe(0, 2); // 30 days: periods 0..=4
    let expect: Vec<u128> = (0..5).map(|p| c.period_held(0, p).as_yoctonear()).collect();
    for (p, e) in expect.iter().enumerate() {
        ctx("anyone.testnet", T0_MS + (p as u64 + 1) * WEEK_MS, 0);
        let r = match c.settle(0) {
            PromiseOrValue::Value(Some(r)) => r,
            _ => panic!("expected an immediate result"),
        };
        assert_eq!(r.held.as_yoctonear(), *e, "period {p}");
    }
    let (m3, periods) = c.claimable(0, acc("m3.testnet"));
    assert_eq!(periods, vec![0, 1, 2, 3, 4]);
    assert!(near(3) - m3.as_yoctonear() < 10);
}

#[test]
fn failed_scoring_reopens_the_period() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, 0);
    c.reveal(a, pa);
    ctx("anyone.testnet", T0_MS + WEEK_MS + 1, near(1) / 2);
    let _ = c.settle(0);
    ctx("app.testnet", T0_MS + WEEK_MS + 5, 0);
    assert!(c.on_scores(0, 0, vec![a], Ok(None)).is_none());
    assert!(c.get_period(0, 0).is_none());
    ctx("anyone.testnet", T0_MS + WEEK_MS + 9, near(1) / 2);
    let _ = c.settle(0);
    ctx("app.testnet", T0_MS + WEEK_MS + 15, 0);
    let bad = Ok(Some(ScoreOut { ok: true, results: vec![], error: None }));
    assert!(c.on_scores(0, 0, vec![a], bad).is_none());
    assert!(logs_have("settle_failed"));
}

#[test]
fn invalid_and_unrevealed_settle_without_outlayer() {
    let mut c = setup();
    let (a, _) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("anyone.testnet", T0_MS + 3 * 60 * 60_000, 0);
    c.mark_unrevealed(a);
    ctx("anyone.testnet", T0_MS + WEEK_MS, near(1));
    let r = match c.settle(0) {
        PromiseOrValue::Value(Some(r)) => r,
        _ => panic!("expected an immediate result"),
    };
    assert!(!r.released);
    assert_eq!(r.sum_bps, -10_000);
}

#[test]
fn score_formula() {
    assert_eq!(period_score(&[1000, 1000, 1000]), (3000, 375));
    assert_eq!(period_score(&[]), (0, 0));
    assert_eq!(period_score(&[-10_000, 30_000]).1, 20_000 / 7);
}

// ------------------------------------------------------------------ late access

fn late_reader(c: &mut SealedCalls, at_ms: u64) {
    ctx("m3.testnet", at_ms, near(3));
    c.subscribe(0, 0);
    c.register_key(0, PK_B.into());
}

#[test]
fn creator_shares_a_live_signal_with_a_late_subscriber() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS + 10_000, 240, &good_long(), "s1", m1_key());
    late_reader(&mut c, T0_MS + 60_000);
    ctx("alice.testnet", T0_MS + 70_000, 0);
    let n = c.share_signals(vec![(id, vec![WrappedKey { member: acc("m3.testnet"), key: "w3".into() }, WrappedKey { member: acc("m1.testnet"), key: "again".into() }])]);
    assert_eq!(n, 1); // m1 already had a key: skipped
    let s = c.get_signal(id).unwrap();
    assert_eq!(s.wrapped_keys.len(), 2);
    assert_eq!(s.wrapped_keys[0].key, "wrapped");
    assert!(logs_have("signal_shared"));
}

#[test]
#[should_panic(expected = "only the signal's creator can share it")]
fn only_the_creator_shares() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS + 10_000, 240, &good_long(), "s1", m1_key());
    late_reader(&mut c, T0_MS + 60_000);
    ctx("m1.testnet", T0_MS + 70_000, 0);
    c.share_signals(vec![(id, vec![WrappedKey { member: acc("m3.testnet"), key: "w3".into() }])]);
}

#[test]
#[should_panic(expected = "is not an active subscriber with a key")]
fn sharing_only_to_active_subscribers() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS + 10_000, 240, &good_long(), "s1", m1_key());
    ctx("alice.testnet", T0_MS + 70_000, 0);
    c.share_signals(vec![(id, vec![WrappedKey { member: acc("stranger.testnet"), key: "w".into() }])]);
}

#[test]
#[should_panic(expected = "has ended")]
fn no_sharing_after_validity() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    late_reader(&mut c, T0_MS + 60_000);
    ctx("alice.testnet", T0_MS + 10_000 + 60 * 60_000, 0);
    c.share_signals(vec![(id, vec![WrappedKey { member: acc("m3.testnet"), key: "w3".into() }])]);
}

// ------------------------------------------------------------------ score as soon as signals end

#[test]
fn signals_get_official_scores_before_the_period_settles() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, 0);
    c.reveal(a, pa);
    ctx("keeper.testnet", T0_MS + 2 * 60 * 60_000 + 5, near(1) / 2);
    let _ = c.score_signals(vec![a]);
    assert!(logs_have("scoring_requested"));
    ctx("app.testnet", T0_MS + 2 * 60 * 60_000 + 10_000, 0);
    assert_eq!(c.on_signal_scores(vec![a], ok(vec![score(a, 1500, "tp1")])), 1);
    assert_eq!(c.get_signal(a).unwrap().r_bps, Some(1500));
    // settlement then needs no OutLayer call and uses that score
    ctx("anyone.testnet", T0_MS + WEEK_MS + 1, near(1) / 2);
    let r = match c.settle(0) {
        PromiseOrValue::Value(Some(r)) => r,
        _ => panic!("expected an immediate settlement"),
    };
    assert!(r.released);
    assert_eq!(r.sum_bps, 1500);
}

#[test]
#[should_panic(expected = "already scored")]
fn scoring_twice_is_refused() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, 0);
    c.reveal(a, pa);
    ctx("app.testnet", T0_MS + 2 * 60 * 60_000 + 10_000, 0);
    c.on_signal_scores(vec![a], ok(vec![score(a, 1500, "tp1")]));
    ctx("keeper.testnet", T0_MS + 3 * 60 * 60_000, near(1) / 2);
    let _ = c.score_signals(vec![a]);
}

#[test]
#[should_panic(expected = "is not revealed")]
fn sealed_signals_cannot_be_scored() {
    let mut c = setup();
    let (a, _) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("keeper.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 2);
    let _ = c.score_signals(vec![a]);
}

#[test]
fn failed_scoring_changes_nothing() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, 0);
    c.reveal(a, pa);
    ctx("app.testnet", T0_MS + 2 * 60 * 60_000 + 10_000, 0);
    assert_eq!(c.on_signal_scores(vec![a], Ok(None)), 0);
    assert!(c.get_signal(a).unwrap().r_bps.is_none());
    assert!(logs_have("scoring_failed"));
}
