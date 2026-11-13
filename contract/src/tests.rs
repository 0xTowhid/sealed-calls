use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const T0_MS: u64 = 1_762_560_000_000; // 2025-11-08
const WEEK_MS: u64 = 7 * DAY_MS;
const PK_A: &str = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
const PK_B: &str = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=";

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
        grace_min: 1_440,
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
    c.create_channel("Alice Alpha".into(), "ETH and majors".into(), plans(), 25, None);
    ctx("m1.testnet", T0_MS + 1000, near(3));
    c.subscribe(0, 0, None, None);
    c.register_key(0, PK_A.into());
    ctx("m2.testnet", T0_MS + 2000, near(4));
    c.subscribe(0, 1, None, None);
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
    Ok(Some(ScoreOut { ok: true, results, error: None, failed: vec![] }))
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
    c.subscribe(0, 2, None, None);
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
    let until = c.subscribe(0, 0, None, None);
    assert_eq!(until, T0_MS + 1000 + 2 * WEEK_MS);
    assert_eq!(c.get_member(0, acc("m1.testnet")).unwrap().subs.len(), 2);
}

#[test]
#[should_panic(expected = "attach at least")]
fn subscribing_needs_the_full_price() {
    let mut c = setup();
    ctx("m3.testnet", T0_MS, near(1));
    c.subscribe(0, 0, None, None);
}

#[test]
#[should_panic(expected = "channel is full")]
fn channel_cap_counts_active_subscribers() {
    ctx("owner.testnet", T0_MS, 0);
    let mut c = SealedCalls::new(config());
    ctx("alice.testnet", T0_MS, near(1));
    c.create_channel("Tiny".into(), "".into(), plans(), 1, None);
    ctx("m1.testnet", T0_MS, near(3));
    c.subscribe(0, 0, None, None);
    ctx("m2.testnet", T0_MS, near(3));
    c.subscribe(0, 0, None, None);
}

#[test]
fn expired_seat_frees_up() {
    ctx("owner.testnet", T0_MS, 0);
    let mut c = SealedCalls::new(config());
    ctx("alice.testnet", T0_MS, near(1));
    c.create_channel("Tiny".into(), "".into(), plans(), 1, None);
    ctx("m1.testnet", T0_MS, near(3));
    c.subscribe(0, 0, None, None);
    ctx("m2.testnet", T0_MS + WEEK_MS + 1, near(3));
    c.subscribe(0, 0, None, None);
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
    ctx("m2.testnet", T0_MS, near(1) / 10);
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
    ctx("anyone.testnet", T0_MS + 10_000 + 239 * 60_000, near(1) / 10);
    c.reveal(id, p);
}

#[test]
#[should_panic(expected = "text does not match the commitment")]
fn reveal_needs_the_committed_text() {
    let mut c = setup();
    let (id, p) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("anyone.testnet", T0_MS + 10_000 + 60 * 60_000, near(1) / 10);
    c.reveal(id, p.replace("3200", "3300"));
}

#[test]
fn reveal_publishes_the_signal() {
    let mut c = setup();
    let (id, p) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("anyone.testnet", T0_MS + 10_000 + 60 * 60_000, near(1) / 10);
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
    ctx("anyone.testnet", T0_MS + 10_000 + 60 * 60_000, near(1) / 10);
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
    ctx("anyone.testnet", T0_MS + 10_000 + (60 + 1_440) * 60_000 - 1, near(1) / 10);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut c2 = setup(); c2.mark_unrevealed(0) })).is_err());
    ctx("anyone.testnet", T0_MS + 10_000 + (60 + 1_440) * 60_000, near(1) / 10);
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
    assert!(validate_body(&mk("gecko_micro", Some("solana"), "long", 1, "0.00002", "0.000021", &["0.00003"], "0.000015")).is_ok());
    assert!(validate_body(&mk("gecko_micro", Some("solana"), "long", 5, "1", "1", &["2"], "0.5")).is_err());
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
    ctx("anyone.testnet", T0_MS + WEEK_MS - 1, near(1) / 10);
    c.settle(0);
}

#[test]
#[should_panic(expected = "is still sealed")]
fn sealed_signal_blocks_settlement() {
    let mut c = setup();
    post(&mut c, T0_MS + WEEK_MS - 5 * 60 * 60_000, 240, &good_long(), "s1", m1_key());
    ctx("anyone.testnet", T0_MS + WEEK_MS + 1, near(1) / 2);
    c.settle(0);
}

#[test]
fn quiet_period_refunds_subscribers() {
    let mut c = setup();
    ctx("anyone.testnet", T0_MS + WEEK_MS, near(1) / 10);
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
    let got = c.claim_refund(0);
    assert!(got < m1_amt && got.as_yoctonear() + near(1) / 100 > m1_amt.as_yoctonear(), "refund minus a little storage: {got}");
    assert_eq!(c.claimable(0, acc("m1.testnet")).0.as_yoctonear(), 0);
}

#[test]
#[should_panic(expected = "nothing to claim")]
fn refund_cannot_be_claimed_twice() {
    let mut c = setup();
    ctx("anyone.testnet", T0_MS + WEEK_MS, near(1) / 10);
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
    c.on_scores(0, p, ids, at_ms, ok(results)).expect("scored")
}

#[test]
fn positive_week_releases_the_held_half_to_the_creator() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    let (b, pb) = post(&mut c, T0_MS + 20_000, 60, &body_json("short", 2, "3000", "3010", &["2900"], "3100"), "s2", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
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
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
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
    c.subscribe(0, 2, None, None); // 30 days: periods 0..=4
    let expect: Vec<u128> = (0..5).map(|p| c.period_held(0, p).as_yoctonear()).collect();
    for (p, e) in expect.iter().enumerate() {
        ctx("anyone.testnet", T0_MS + (p as u64 + 1) * WEEK_MS, near(1) / 10);
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
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
    c.reveal(a, pa);
    ctx("anyone.testnet", T0_MS + WEEK_MS + 1, near(1) / 2);
    let _ = c.settle(0);
    ctx("app.testnet", T0_MS + WEEK_MS + 5, 0);
    assert!(c.on_scores(0, 0, vec![a], T0_MS + WEEK_MS + 1, Ok(None)).is_none());
    assert!(c.get_period(0, 0).is_none());
    ctx("anyone.testnet", T0_MS + WEEK_MS + 9, near(1) / 2);
    let _ = c.settle(0);
    ctx("app.testnet", T0_MS + WEEK_MS + 15, 0);
    let bad = Ok(Some(ScoreOut { ok: true, results: vec![], error: None, failed: vec![] }));
    assert!(c.on_scores(0, 0, vec![a], T0_MS + WEEK_MS + 9, bad).is_none());
    assert!(logs_have("settle_failed"));
}

#[test]
fn invalid_and_unrevealed_settle_without_outlayer() {
    let mut c = setup();
    let (a, _) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("anyone.testnet", T0_MS + 10_000 + (60 + 1_440) * 60_000, near(1) / 10);
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
    c.subscribe(0, 0, None, None);
    c.register_key(0, PK_B.into());
}

#[test]
fn creator_shares_a_live_signal_with_a_late_subscriber() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS + 10_000, 240, &good_long(), "s1", m1_key());
    late_reader(&mut c, T0_MS + 60_000);
    ctx("alice.testnet", T0_MS + 65_000, near(1) / 10);
    c.deposit_storage();
    let credit = c.storage_credit(acc("alice.testnet"));
    ctx("alice.testnet", T0_MS + 70_000, 0);
    let n = c.share_signals(vec![(id, vec![WrappedKey { member: acc("m3.testnet"), key: "w3".into() }, WrappedKey { member: acc("m1.testnet"), key: "again".into() }])]);
    assert_eq!(n, 1); // m1 already had a key: skipped
    let s = c.get_signal(id).unwrap();
    assert_eq!(s.wrapped_keys.len(), 2);
    assert_eq!(s.wrapped_keys[0].key, "wrapped");
    assert!(logs_have("signal_shared"));
    // the storage came out of alice's prepaid credit, not the contract
    assert!(c.storage_credit(acc("alice.testnet")) < credit);
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
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
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
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
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
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
    c.reveal(a, pa);
    ctx("app.testnet", T0_MS + 2 * 60 * 60_000 + 10_000, 0);
    assert_eq!(c.on_signal_scores(vec![a], Ok(None)), 0);
    assert!(c.get_signal(a).unwrap().r_bps.is_none());
    assert!(logs_have("scoring_failed"));
}

#[test]
fn channel_tags_declared_by_creator() {
    let mut c = setup();
    assert_eq!(c.channel_tags(vec![0]), vec![Vec::<String>::new()]); // default: all kinds
    ctx("alice.testnet", T0_MS + 5000, near(1));
    let id = c.create_channel("Alice Memes".into(), "".into(), plans(), 10, Some(vec!["micro".into(), "dex".into(), "dex".into()]));
    assert_eq!(c.channel_tags(vec![0, id]), vec![vec![], vec!["micro".to_string(), "dex".to_string()]]);
    // None keeps tags; all three = all kinds
    c.update_channel(id, "Alice Memes".into(), "".into(), plans(), 10, None);
    assert_eq!(c.channel_tags(vec![id])[0].len(), 2);
    c.update_channel(id, "Alice Memes".into(), "".into(), plans(), 10, Some(vec!["perps".into(), "dex".into(), "micro".into()]));
    assert!(c.channel_tags(vec![id])[0].is_empty());
}

#[test]
#[should_panic(expected = "tags: perps, dex or micro")]
fn channel_tags_reject_unknown() {
    let mut c = setup();
    ctx("alice.testnet", T0_MS + 5000, near(1));
    c.create_channel("X".into(), "".into(), plans(), 10, Some(vec!["nft".into()]));
}

#[test]
#[should_panic(expected = "only the creator")]
fn channel_tags_creator_only() {
    let mut c = setup();
    ctx("m1.testnet", T0_MS + 5000, near(1));
    c.update_channel(0, "Hack".into(), "".into(), plans(), 10, Some(vec!["perps".into()]));
}

// ------------------------------------------------------------------ audit fixes (Nov 13)

fn panics<F: FnOnce()>(f: F) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

#[test]
fn f2_grace_is_at_least_a_day() {
    ctx("owner.testnet", T0_MS, 0);
    let mut cfg = config();
    cfg.grace_min = 30;
    assert!(panics(|| { SealedCalls::new(cfg); }));
}

#[test]
fn f1_sharing_needs_the_creators_storage_credit() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS + 10_000, 240, &good_long(), "s1", m1_key());
    late_reader(&mut c, T0_MS + 60_000);
    ctx("alice.testnet", T0_MS + 70_000, 0);
    assert!(panics(|| { c.share_signals(vec![(id, vec![WrappedKey { member: acc("m3.testnet"), key: "w3".into() }])]); }));
}

#[test]
fn f1_storage_credit_can_be_withdrawn() {
    let mut c = setup();
    ctx("alice.testnet", T0_MS, near(1));
    let credit = c.deposit_storage();
    assert!(credit.as_yoctonear() > near(1) * 99 / 100);
    ctx("alice.testnet", T0_MS, 0);
    assert_eq!(c.withdraw_storage(None), credit);
    assert_eq!(c.storage_credit(acc("alice.testnet")).as_yoctonear(), 0);
}

#[test]
fn f1_plans_cannot_be_free() {
    ctx("owner.testnet", T0_MS, 0);
    let mut c = SealedCalls::new(config());
    ctx("alice.testnet", T0_MS, near(1));
    assert!(panics(|| { c.create_channel("x".into(), "".into(), vec![Plan { days: 7, price: NearToken::from_yoctonear(0) }], 25, None); }));
}

#[test]
fn f1_reveal_and_register_pay_their_own_storage() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, 0);
    assert!(panics(|| { c.reveal(a, pa.clone()); }));
    ctx("m3.testnet", T0_MS, near(3));
    c.subscribe(0, 0, None, None);
    ctx("m3.testnet", T0_MS, 0);
    assert!(panics(|| { c.register_key(0, PK_B.into()); }));
}

#[test]
fn f3_config_changes_wait_a_day_and_outlayer_is_fixed() {
    let mut c = setup();
    ctx("owner.testnet", T0_MS + 1, 0);
    let mut cfg = config();
    cfg.min_signals = 3;
    c.set_config(cfg.clone());
    assert_eq!(c.get_config().min_signals, 1);
    assert!(c.pending_config().is_some());
    ctx("anyone.testnet", T0_MS + DAY_MS, 0);
    assert!(panics(|| { let mut c2 = setup(); c2.apply_config() }));
    ctx("anyone.testnet", T0_MS + 1 + DAY_MS, 0);
    c.apply_config();
    assert_eq!(c.get_config().min_signals, 3);
    ctx("owner.testnet", T0_MS + 2 * DAY_MS, 0);
    let mut evil = config();
    evil.outlayer = acc("evil.testnet");
    assert!(panics(|| { c.set_config(evil) }));
}

#[test]
fn f6_bad_keys_are_refused() {
    assert!(valid_x25519(PK_A));
    assert!(!valid_x25519("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")); // all zero
    assert!(!valid_x25519("AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")); // small order
    assert!(!valid_x25519("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!=")); // not base64
    assert!(!valid_x25519("AQID")); // wrong length
}

#[test]
fn f15_rotating_a_key_drops_old_wraps_on_live_signals() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS + 10_000, 240, &good_long(), "s1", m1_key());
    ctx("m1.testnet", T0_MS + 60_000, near(1) / 10);
    c.register_key(0, PK_B.into());
    assert!(c.get_signal(id).unwrap().wrapped_keys.is_empty());
    // …so the creator can share it again to the new key
    ctx("alice.testnet", T0_MS + 65_000, near(1) / 10);
    c.deposit_storage();
    ctx("alice.testnet", T0_MS + 70_000, 0);
    assert_eq!(c.share_signals(vec![(id, vec![WrappedKey { member: acc("m1.testnet"), key: "new".into() }])]), 1);
}

#[test]
fn f7_too_many_unscored_signals_must_be_scored_first() {
    ctx("owner.testnet", T0_MS, 0);
    let mut cfg = config();
    cfg.max_signals_per_day = 20;
    let mut c = SealedCalls::new(cfg);
    ctx("alice.testnet", T0_MS, near(1));
    c.create_channel("A".into(), "".into(), plans(), 25, None);
    let mut ids = vec![];
    for i in 0..11 {
        let p = payload(60, &good_long(), &format!("s{i}"));
        ctx("alice.testnet", T0_MS + 10_000 + i, near(1));
        let id = c.post_signal(0, 60, commit_of(&p), round_for(T0_MS + 10_000 + i, 60), "ct".into(), "m".into(), vec![]);
        ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
        c.reveal(id, p);
        ids.push(id);
    }
    ctx("anyone.testnet", T0_MS + WEEK_MS + 1, near(1) / 2);
    assert!(panics(|| { c.settle(0); }));
}

#[test]
fn f7_a_settlement_that_never_returns_can_be_restarted() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
    c.reveal(a, pa);
    ctx("anyone.testnet", T0_MS + WEEK_MS + 1, near(1) / 2);
    let _ = c.settle(0);
    ctx("anyone.testnet", T0_MS + WEEK_MS + 60_000, near(1) / 2);
    assert!(panics(|| { let _ = c.settle(0); }));
    let t2 = T0_MS + WEEK_MS + 1 + SETTLE_TIMEOUT_MS;
    ctx("anyone.testnet", t2, near(1) / 2);
    let _ = c.settle(0);
    // the first (stale) answer arrives late: its score is kept but it does not finish the period
    ctx("app.testnet", t2 + 5, 0);
    assert!(c.on_scores(0, 0, vec![a], T0_MS + WEEK_MS + 1, ok(vec![score(a, 500, "tp1")])).is_none());
    assert_eq!(c.get_signal(a).unwrap().r_bps, Some(500));
    assert_eq!(c.get_channel(0).unwrap().next_period, 0);
    // the current one finishes it
    let r = c.on_scores(0, 0, vec![a], t2, ok(vec![score(a, -500, "sl")])).expect("settled");
    assert!(r.released);
}

#[test]
fn f11_partly_failed_scoring_keeps_what_was_scored() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    let (b, pb) = post(&mut c, T0_MS + 20_000, 60, &good_long(), "s2", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
    c.reveal(a, pa);
    c.reveal(b, pb);
    ctx("app.testnet", T0_MS + 2 * 60 * 60_000 + 10, 0);
    let out = Ok(Some(ScoreOut { ok: true, results: vec![score(a, 300, "tp1")], error: None, failed: vec![b] }));
    assert_eq!(c.on_signal_scores(vec![a, b], out), 1);
    assert_eq!(c.get_signal(a).unwrap().r_bps, Some(300));
    assert_eq!(c.get_signal(b).unwrap().r_bps, None);
    assert!(check_scores(&[a, b], &[score(a, 1, "x")], &[a]).is_err());
}

#[test]
fn f13_filled_reads_the_first_word() {
    assert!(was_filled("tp1"));
    assert!(was_filled("expired (15m)"));
    for o in ["not_filled", "not_filled (15m)", "no_data", "no_trades", "no_pool_at_post", "invalid", "unrevealed", "below_floor", "no_market", ""] {
        assert!(!was_filled(o), "{o}");
    }
}

#[test]
fn f10_f14_release_needs_filled_calls_and_any_positive_total() {
    // +3 bps total: the rounded score is 0 but the record is positive -> released
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
    c.reveal(a, pa);
    assert!(settle_with(&mut c, T0_MS + WEEK_MS + 1, vec![score(a, 3, "expired")]).released);
    // a never-filled call doesn't count towards min_signals
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS + 10_000, 60, &good_long(), "s1", m1_key());
    ctx("m1.testnet", T0_MS + 2 * 60 * 60_000, near(1) / 10);
    c.reveal(a, pa);
    assert!(!settle_with(&mut c, T0_MS + WEEK_MS + 1, vec![score(a, 0, "not_filled")]).released);
}

#[test]
fn f12_subscribe_refuses_a_changed_plan() {
    let mut c = setup();
    ctx("alice.testnet", T0_MS, near(1) / 10);
    c.update_channel(0, "Alice Alpha".into(), "".into(), vec![Plan { days: 1, price: NearToken::from_near(2) }], 25, None);
    ctx("m3.testnet", T0_MS + 5, near(3));
    assert!(panics(|| { c.subscribe(0, 0, Some(7), Some(NearToken::from_near(2))); }));
    c.subscribe(0, 0, Some(1), Some(NearToken::from_near(2)));
}

#[test]
fn f16_signals_count_in_the_period_they_end() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS + WEEK_MS - 60 * 60_000, 240, &good_long(), "s1", m1_key());
    assert_eq!(c.get_signal(id).unwrap().period, 1);
    // period 0 can settle without waiting for it
    ctx("anyone.testnet", T0_MS + WEEK_MS + 1, near(1) / 10);
    assert!(matches!(c.settle(0), PromiseOrValue::Value(Some(_))));
}

#[test]
fn f21_daily_limit_is_per_creator() {
    let mut c = setup();
    ctx("alice.testnet", T0_MS, near(1));
    c.create_channel("Second".into(), "".into(), plans(), 25, None);
    for i in 0..5 {
        post(&mut c, T0_MS + 10_000 + i, 60, &good_long(), &format!("s{i}"), m1_key());
    }
    let p = payload(60, &good_long(), "x").replace("\"channel\":0", "\"channel\":1");
    ctx("alice.testnet", T0_MS + 20_000, near(1));
    assert!(panics(|| { c.post_signal(1, 60, commit_of(&p), round_for(T0_MS + 20_000, 60), "ct".into(), "m".into(), vec![]); }));
}

#[test]
fn f8_failed_refund_can_be_claimed_again() {
    let mut c = setup();
    ctx("anyone.testnet", T0_MS + WEEK_MS, near(1) / 10);
    let _ = c.settle(0);
    ctx("m1.testnet", T0_MS + WEEK_MS + 5, 0);
    let (_, periods) = c.claimable(0, acc("m1.testnet"));
    c.claim_refund(0);
    assert_eq!(c.claimable(0, acc("m1.testnet")).0.as_yoctonear(), 0);
    ctx("app.testnet", T0_MS + WEEK_MS + 6, 0);
    c.on_refund_paid(0, acc("m1.testnet"), periods, Err(PromiseError::Failed));
    assert!(c.claimable(0, acc("m1.testnet")).0.as_yoctonear() > 0);
    // a failed payout is owed and can be withdrawn
    c.on_paid(acc("alice.testnet"), NearToken::from_near(1), Err(PromiseError::Failed));
    assert_eq!(c.owed(acc("alice.testnet")), NearToken::from_near(1));
    ctx("alice.testnet", T0_MS + WEEK_MS + 7, 0);
    assert_eq!(c.withdraw_owed(), NearToken::from_near(1));
    assert_eq!(c.owed(acc("alice.testnet")).as_yoctonear(), 0);
}
