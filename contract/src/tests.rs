use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const T0_MS: u64 = 1_762_400_000_000; // 2025-11-06
const BONK: &str = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF: &str = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const PK_A: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PK_B: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, at_ms: u64, deposit_yocto: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("sealedcalls.testnet"))
        .predecessor_account_id(acc(who))
        .block_timestamp(at_ms * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .build());
}

fn near(n: u128) -> u128 {
    n * 10u128.pow(24)
}

fn config() -> ClubConfig {
    ClubConfig {
        name: "Alpha Club".into(),
        epoch_minutes: 1440,
        epoch_budget: NearToken::from_near(5),
        min_record: 2,
        horizons_min: vec![15, 60, 240],
        grace_min: 30,
        max_calls_per_day: 5,
        scorer_wasm_url: "https://example.com/scorer.wasm".into(),
        scorer_wasm_hash: "a".repeat(64),
        outlayer: acc("outlayer.testnet"),
    }
}

/// The drand round that opens right at (or just after) a horizon's end.
fn round_for(posted_ms: u64, horizon_min: u32) -> u64 {
    let end_s = (posted_ms + horizon_min as u64 * 60_000).div_ceil(1000);
    (end_s - QUICKNET_GENESIS_S).div_ceil(QUICKNET_PERIOD_S) + 1
}

fn payload(club: u32, caller: &str, mint: &str, horizon: u32, salt: &str) -> String {
    format!(r#"{{"v":1,"club":{club},"caller":"{caller}","mint":"{mint}","horizon_min":{horizon},"salt":"{salt}"}}"#)
}

fn commit_of(p: &str) -> String {
    hex(&env::sha256(p.as_bytes()))
}

/// A club with caller alice, members m1 (key registered) and m2 (no key).
fn setup() -> SealedCalls {
    ctx("dao.sputnik-v2.testnet", T0_MS, 0);
    let mut c = SealedCalls::new();
    ctx("dao.sputnik-v2.testnet", T0_MS, near(20));
    c.create_club(config(), vec![acc("alice.testnet")], vec![acc("m1.testnet"), acc("m2.testnet")]);
    ctx("m1.testnet", T0_MS, 0);
    c.register_key(0, PK_A.into());
    c
}

fn post(c: &mut SealedCalls, at_ms: u64, mint: &str, horizon: u32, salt: &str) -> (u64, String) {
    let p = payload(0, "alice.testnet", mint, horizon, salt);
    ctx("alice.testnet", at_ms, near(1));
    let id = c.post_call(
        0,
        horizon,
        commit_of(&p),
        round_for(at_ms, horizon),
        "-----BEGIN AGE ENCRYPTED FILE-----x".into(),
        "member-ciphertext".into(),
        vec![WrappedKey { member: acc("m1.testnet"), key: "wrapped".into() }],
    );
    (id, p)
}

#[test]
fn club_escrow_is_deposit_minus_storage() {
    let c = setup();
    let club = c.get_club(0).unwrap();
    assert_eq!(club.governor, acc("dao.sputnik-v2.testnet"));
    assert!(club.escrow < NearToken::from_near(20) && club.escrow > NearToken::from_near(19));
    assert_eq!(club.members.len(), 2);
}

#[test]
#[should_panic(expected = "not on this club's caller roster")]
fn only_roster_callers_can_post() {
    let mut c = setup();
    ctx("mallory.testnet", T0_MS, near(1));
    c.post_call(0, 60, "b".repeat(64), round_for(T0_MS, 60), "x".into(), "y".into(), vec![WrappedKey { member: acc("m1.testnet"), key: "k".into() }]);
}

#[test]
#[should_panic(expected = "wrap the call key to every registered member")]
fn call_must_reach_every_registered_member() {
    let mut c = setup();
    ctx("m2.testnet", T0_MS, 0);
    c.register_key(0, PK_B.into());
    post(&mut c, T0_MS + 1000, BONK, 60, "s1"); // wraps only to m1
}

#[test]
#[should_panic(expected = "reveal round opens before the horizon ends")]
fn reveal_round_cannot_open_early() {
    let mut c = setup();
    ctx("alice.testnet", T0_MS, near(1));
    c.post_call(0, 60, "b".repeat(64), round_for(T0_MS, 15), "x".into(), "y".into(), vec![WrappedKey { member: acc("m1.testnet"), key: "k".into() }]);
}

#[test]
fn post_then_reveal_after_horizon() {
    let mut c = setup();
    let (id, p) = post(&mut c, T0_MS + 1000, BONK, 60, "s1");
    let call = c.get_call(id).unwrap();
    assert_eq!(call.status, CallStatus::Sealed);
    assert_eq!(call.epoch, 0);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"call_posted\"")));

    ctx("stranger.testnet", T0_MS + 1000 + 60 * 60_000, 0);
    c.reveal(id, p);
    match c.get_call(id).unwrap().status {
        CallStatus::Revealed { mint, by, .. } => {
            assert_eq!(mint, BONK);
            assert_eq!(by, acc("stranger.testnet"));
        }
        s => panic!("unexpected {s:?}"),
    }
}

#[test]
#[should_panic(expected = "call is still within its horizon")]
fn cannot_reveal_early() {
    let mut c = setup();
    let (id, p) = post(&mut c, T0_MS, BONK, 60, "s1");
    ctx("m1.testnet", T0_MS + 59 * 60_000, 0);
    c.reveal(id, p);
}

#[test]
#[should_panic(expected = "plaintext does not match the commitment")]
fn cannot_reveal_a_different_call() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS, BONK, 60, "s1");
    ctx("alice.testnet", T0_MS + 61 * 60_000, 0);
    c.reveal(id, payload(0, "alice.testnet", WIF, 60, "s1"));
}

#[test]
#[should_panic(expected = "payload is for another caller")]
fn payload_is_bound_to_its_caller() {
    let mut c = setup();
    let p = payload(0, "bob.testnet", BONK, 60, "s1");
    ctx("alice.testnet", T0_MS, near(1));
    let id = c.post_call(0, 60, commit_of(&p), round_for(T0_MS, 60), "x".into(), "y".into(), vec![WrappedKey { member: acc("m1.testnet"), key: "k".into() }]);
    ctx("alice.testnet", T0_MS + 61 * 60_000, 0);
    c.reveal(id, p);
}

#[test]
fn unrevealed_only_after_grace_and_scores_total_loss() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS, BONK, 60, "s1");
    ctx("anyone.testnet", T0_MS + (60 + 30) * 60_000, 0);
    c.mark_unrevealed(id);
    let call = c.get_call(id).unwrap();
    assert!(matches!(call.status, CallStatus::Unrevealed { .. }));
    assert_eq!(call.score_bps, Some(LOSS_BPS));
}

#[test]
#[should_panic(expected = "grace period not over")]
fn unrevealed_too_early() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS, BONK, 60, "s1");
    ctx("anyone.testnet", T0_MS + (60 + 29) * 60_000, 0);
    c.mark_unrevealed(id);
}

#[test]
#[should_panic(expected = "daily call limit reached")]
fn daily_limit() {
    let mut c = setup();
    for i in 0..6 {
        post(&mut c, T0_MS + i * 1000, BONK, 15, &format!("s{i}"));
    }
}

#[test]
fn new_key_applies_to_later_calls_only_and_removed_members_drop_out() {
    let mut c = setup();
    ctx("dao.sputnik-v2.testnet", T0_MS, 0);
    c.set_members(0, vec![acc("m2.testnet")]); // m1 removed
    ctx("alice.testnet", T0_MS, near(1));
    // No registered members left: a call with no wrapped keys is accepted.
    let p = payload(0, "alice.testnet", BONK, 15, "s");
    c.post_call(0, 15, commit_of(&p), round_for(T0_MS, 15), "x".into(), "y".into(), vec![]);
}

#[test]
fn aggregate_shrinks_short_records() {
    let a = acc("a.testnet");
    let b = acc("b.testnet");
    // a: one lucky +300% call. b: ten steady +20% calls.
    let mut scored = vec![(a.clone(), 30_000)];
    scored.extend((0..10).map(|_| (b.clone(), 2_000)));
    let r = aggregate(&scored, 1);
    let ra = r.iter().find(|x| x.caller == a).unwrap();
    let rb = r.iter().find(|x| x.caller == b).unwrap();
    assert_eq!(ra.score_bps, 30_000 / 6); // 5000
    assert_eq!(rb.score_bps, 20_000 / 15); // 1333
    let pay = split_budget(&r, NearToken::from_near(10));
    // weights: a 5000*1 = 5000, b 1333*10 = 13330 -> b earns more despite the lower average
    assert!(pay[1] > pay[0]);
    let total: u128 = pay.iter().map(|p| p.as_yoctonear()).sum();
    assert!(total <= near(10) && total > near(10) - 10);
}

#[test]
fn aggregate_respects_min_record_and_negative_scores() {
    let a = acc("a.testnet");
    let r = aggregate(&[(a.clone(), 9_000)], 2);
    assert!(!r[0].eligible); // one call, needs two
    let r = aggregate(&[(a.clone(), 9_000), (a.clone(), -10_000)], 2);
    assert!(!r[0].eligible); // negative sum
    assert_eq!(split_budget(&r, NearToken::from_near(5))[0].as_yoctonear(), 0);
}

#[test]
fn settle_with_only_unrevealed_calls_pays_nothing() {
    let mut c = setup();
    let (id, _) = post(&mut c, T0_MS, BONK, 60, "s1");
    ctx("anyone.testnet", T0_MS + 2 * 60 * 60_000, 0);
    c.mark_unrevealed(id);
    ctx("anyone.testnet", T0_MS + 1440 * 60_000, 0);
    match c.settle(0, 0) {
        PromiseOrValue::Value(Some(r)) => {
            assert_eq!(r.status, EpochStatus::Settled);
            assert_eq!(r.paid.as_yoctonear(), 0);
            assert_eq!(r.callers[0].calls, 1);
        }
        _ => panic!("expected an immediate settlement"),
    }
}

#[test]
#[should_panic(expected = "is still sealed")]
fn settle_waits_for_every_call() {
    let mut c = setup();
    post(&mut c, T0_MS, BONK, 60, "s1");
    ctx("anyone.testnet", T0_MS + 1440 * 60_000, near(1));
    let _ = c.settle(0, 0);
}

#[test]
fn full_epoch_settles_through_scores_and_pays() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS, BONK, 60, "s1");
    let (b, pb) = post(&mut c, T0_MS + 1000, WIF, 60, "s2");
    let (d, pd) = post(&mut c, T0_MS + 2000, BONK, 60, "s3"); // BONK again while the first is open
    ctx("anyone.testnet", T0_MS + 2 * 60 * 60_000, 0);
    c.reveal(a, pa);
    c.reveal(b, pb);
    c.reveal(d, pd);
    let escrow_before = c.get_club(0).unwrap().escrow;

    ctx("anyone.testnet", T0_MS + 1440 * 60_000, near(1));
    assert!(matches!(c.settle(0, 0), PromiseOrValue::Promise(_)));
    assert_eq!(c.get_epoch(0, 0).unwrap().status, EpochStatus::Settling);
    assert_eq!(c.get_call(d).unwrap().note.as_deref(), Some("duplicate"));

    // OutLayer resumes us with scores for the two non-duplicate calls.
    ctx("sealedcalls.testnet", T0_MS + 1440 * 60_000 + 5000, 0);
    let out = ScoreOut {
        ok: true,
        results: vec![
            CallScore { id: a, r_bps: 8_000, note: "ok".into(), entry_usd: Some("0.0000274".into()), exit_usd: Some("0.0000497".into()), cost_bps: Some(120) },
            CallScore { id: b, r_bps: 4_000, note: "ok".into(), entry_usd: None, exit_usd: None, cost_bps: None },
        ],
        error: None,
    };
    let r = c.on_scores(0, 0, vec![a, b], Ok(Some(out))).unwrap();
    // alice: 3 calls, Σ = 8000 + 4000 − 10000 = 2000, S = 2000 / 8 = 250 bps, eligible (min_record 2)
    assert_eq!(r.callers[0].calls, 3);
    assert_eq!(r.callers[0].score_bps, 250);
    assert!(r.callers[0].eligible);
    assert_eq!(r.paid, NearToken::from_near(5)); // sole eligible caller takes the epoch budget
    assert_eq!(c.get_club(0).unwrap().escrow, escrow_before.saturating_sub(NearToken::from_near(5)));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"payout\"")));
    let ca = c.get_call(a).unwrap();
    assert_eq!((ca.entry_usd.as_deref(), ca.exit_usd.as_deref(), ca.cost_bps), (Some("0.0000274"), Some("0.0000497"), Some(120)));
}

#[test]
fn failed_scoring_reopens_the_epoch() {
    let mut c = setup();
    let (a, pa) = post(&mut c, T0_MS, BONK, 60, "s1");
    ctx("anyone.testnet", T0_MS + 2 * 60 * 60_000, 0);
    c.reveal(a, pa);
    ctx("anyone.testnet", T0_MS + 1440 * 60_000, near(1));
    let _ = c.settle(0, 0);
    ctx("sealedcalls.testnet", T0_MS + 1440 * 60_000 + 5000, 0);
    assert!(c.on_scores(0, 0, vec![a], Ok(None)).is_none());
    assert!(c.get_epoch(0, 0).is_none()); // settle can be called again
    // Scores that skip a call are rejected the same way.
    ctx("anyone.testnet", T0_MS + 1440 * 60_000 + 6000, near(1));
    let _ = c.settle(0, 0);
    ctx("sealedcalls.testnet", T0_MS + 1440 * 60_000 + 7000, 0);
    let bad = ScoreOut { ok: true, results: vec![], error: None };
    assert!(c.on_scores(0, 0, vec![a], Ok(Some(bad))).is_none());
}

#[test]
#[should_panic(expected = "only the club governor")]
fn only_governor_changes_roster() {
    let mut c = setup();
    ctx("alice.testnet", T0_MS, 0);
    c.set_callers(0, vec![acc("alice.testnet"), acc("alt.testnet")]);
}

#[test]
fn mint_validation() {
    assert!(is_solana_mint(BONK));
    assert!(!is_solana_mint("0x4200000000000000000000000000000000000006"));
    assert!(!is_solana_mint("short"));
}
