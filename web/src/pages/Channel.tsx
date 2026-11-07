import { useState } from "react";
import { allSignals, call, claimable, currentPeriod, getChannel, getConfig, getMember, getPeriod, periodHeld, subscribers } from "../near";
import { record, useLoad, useNow } from "../data";
import { day, dur, near, nearNum, pct, periodWord, planName, price, when } from "../format";
import { tlockOpen, roundTimeMs } from "../crypto";
import { Act, Outcome, Result, SideTag } from "../ui";
import { venueLabel } from "../markets";
import { GAS_300, NEAR } from "../config";
import type { PeriodResult, Signal } from "../types";
import { isSealed, opensAt } from "../types";

async function load(id: number, account: string | null) {
  const ch = await getChannel(id);
  if (!ch) throw new Error(`Channel ${id} doesn't exist.`);
  const [cfg, signals, subs, cur, member, claim] = await Promise.all([
    getConfig(),
    allSignals(id, ch.signal_count),
    subscribers(id),
    currentPeriod(id),
    account ? getMember(id, account) : Promise.resolve(null),
    account ? claimable(id, account) : Promise.resolve(null),
  ]);
  const from = Math.max(0, cur - 7);
  const periods = await Promise.all(
    Array.from({ length: cur - from + 1 }, (_, i) => cur - i).map(async (p) => {
      const [r, held] = await Promise.all([getPeriod(id, p), periodHeld(id, p)]);
      return { p, r, held, signals: signals.filter((s) => s.period === p).length };
    }),
  );
  return { ch, cfg, signals, subs: subs.length, cur, member, claim, periods };
}

export function ChannelPage({ id, account }: { id: number; account: string | null }) {
  const { data, error, reload } = useLoad(() => load(id, account), [id, account], 20_000);
  const now = useNow(5000);
  const [plan, setPlan] = useState<number | null>(null);
  if (error) return <div className="notice err">{error}</div>;
  if (!data) return <p className="empty">Reading the channel from NEAR testnet…</p>;
  const { ch, cfg, signals, subs, cur, member, claim, periods } = data;
  const rec = record(ch, signals);
  const word = periodWord(cfg.period_minutes);
  const periodMs = cfg.period_minutes * 60_000;
  const sel = plan ?? Math.min(2, ch.plans.length - 1);
  const p = ch.plans[sel];
  const half = p ? BigInt(p.price) / 2n : 0n;
  const periodsCovered = p ? Math.max(1, (p.days * 1440) / cfg.period_minutes) : 1;
  const active = member && member.until_ms > now;
  const isCreator = account === ch.creator;

  const subscribe = async () => {
    const deposit = (BigInt(p.price) + BigInt(NEAR(0.05))).toString();
    await call("subscribe", { channel: id, plan: sel }, deposit);
    await reload();
  };
  const reveal = async (s: Signal) => {
    const o = await tlockOpen(s);
    if (!o.matches) throw new Error("The timelocked copy doesn't match the commitment; a subscriber can reveal from their copy.");
    await call("reveal", { signal_id: s.id, plaintext: o.plaintext });
    await reload();
  };

  return (
    <div className="g-main">
      <div>
        <section className="sheet">
          <div className="sub0 small">{ch.creator} · creator since {day(ch.created_at_ms)}</div>
          <h1 className="display m">{ch.name}</h1>
          {ch.about && <p className="lede">{ch.about}</p>}
          <div className="bigstats">
            <div><b>{rec.signals}</b><span>signals</span></div>
            <div><b>{rec.winRate == null ? "—" : `${rec.winRate}%`}</b><span>win rate (filled)</span></div>
            <div><b className={(rec.score_bps ?? 0) > 0 ? "gain" : (rec.score_bps ?? 0) < 0 ? "loss" : ""}>{pct(rec.score_bps)}</b><span>score</span></div>
            <div><b>{rec.periodsSettled ? `${rec.periodsEarned} of ${rec.periodsSettled}` : "—"}</b><span>{word}s earned</span></div>
            <div><b>{rec.notFilled}</b><span>never filled</span></div>
          </div>
        </section>

        <section className="sheet">
          <h2>Every signal</h2>
          <p className="sub">Sealed signals appear when they end. Nothing here can be edited or removed.</p>
          {signals.length === 0 ? (
            <p className="empty">No signals yet.</p>
          ) : (
            <div className="scroll">
              <table className="record">
                <thead><tr><th>Posted</th><th>Market</th><th>Side</th><th>Entry</th><th>TP</th><th>SL</th><th>Valid</th><th>Outcome</th><th className="n">Result</th></tr></thead>
                <tbody>
                  {signals.map((s) => {
                    const b = s.body;
                    const due = isSealed(s) && now >= opensAt(s);
                    const drandReady = now >= roundTimeMs(s.reveal_round);
                    return (
                      <tr key={s.id} className={isSealed(s) ? "sealed" : ""}>
                        <td>{when(s.posted_at_ms)}</td>
                        <td>{b ? <><b className="mk">{b.market.symbol}</b> <span className="venue">{venueLabel(b.market)}</span></> : <b>{isSealed(s) ? "sealed" : "—"}</b>}</td>
                        <td>{b ? <SideTag b={b} /> : "—"}</td>
                        <td>{b ? `${price(b.entry_low)}–${price(b.entry_high)}` : "—"}</td>
                        <td>{b ? b.tps.map(price).join(" · ") : "—"}</td>
                        <td>{b ? price(b.sl) : "—"}</td>
                        <td>{dur(s.valid_min)}</td>
                        <td>
                          {due ? (
                            drandReady ? <Act className="btn small" label="Reveal now" busyLabel="Opening…" run={() => reveal(s)} /> : <span className="out s">opening…</span>
                          ) : (
                            <Outcome s={s} />
                          )}
                        </td>
                        <td className="n"><Result s={s} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="fine">Results include fees and leverage. Fills, TPs and SL use candle closes; liquidation uses wicks. Anyone can reveal a signal once it ends.</p>
        </section>
      </div>

      <div>
        <section className="sheet">
          <h2>{active ? "Your subscription" : "Subscribe"}</h2>
          {active && <p className="notice ok-n">Active until <b>{when(member!.until_ms)}</b>. Signals appear in <a href="#/feed">My feed</a>. You can extend below.</p>}
          {isCreator ? (
            <p className="sub">This is your channel. Post from the <a href="#/desk">creator desk</a>.</p>
          ) : (
            <>
              <div className="plans" role="group" aria-label="Plans">
                {ch.plans.map((pl, i) => (
                  <button key={i} aria-pressed={i === sel} onClick={() => setPlan(i)}>
                    <b>{nearNum(pl.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>
                    <span>{planName(pl.days)}</span>
                  </button>
                ))}
              </div>
              <div className="sub0 small">Prices in NEAR, set by the creator. {subs} of {ch.max_members} seats taken.</div>
              <div className="split" aria-hidden><i /><i className="held" /></div>
              <dl className="kv">
                <dt>Now</dt><dd><b>{near(half)}</b> to {ch.name}</dd>
                <dt>Held</dt><dd><b>{near(BigInt(p.price) - half)}</b>, about {near((BigInt(p.price) - half) / BigInt(Math.ceil(periodsCovered)))} per {word}</dd>
                <dt>Each {word}</dt><dd>The creator gets that {word}'s part if the {word} is positive. Otherwise it's yours to claim back</dd>
              </dl>
              {account ? (
                <Act className="btn wide" label={`${active ? "Extend" : "Subscribe"} for ${near(p.price)}`} busyLabel="Waiting for the wallet…" run={subscribe} />
              ) : (
                <p className="hint">Connect a wallet to subscribe.</p>
              )}
              <p className="fine center">Signals posted before you join open for you when they open for everyone. Adds 0.05 NEAR for storage; the unused part comes back.</p>
            </>
          )}
          {claim && BigInt(claim[0]) > 0n && (
            <div className="pay">
              <span>You can claim back <b>{near(claim[0])}</b> from {claim[1].length} {word}{claim[1].length > 1 ? "s" : ""} the creator didn't earn.</span>
              <Act className="btn small" label="Claim" run={async () => { await call("claim_refund", { channel: id }); await reload(); }} />
            </div>
          )}
        </section>

        <section className="sheet">
          <h2>{word[0].toUpperCase() + word.slice(1)} by {word}</h2>
          <table className="wk">
            <thead><tr><th>{word[0].toUpperCase() + word.slice(1)}</th><th className="n">Signals</th><th className="n">Score</th><th className="n">Held</th><th className="n">Went to</th></tr></thead>
            <tbody>
              {periods.map(({ p, r, held, signals: n }) => (
                <PeriodRow key={p} p={p} r={r} held={held} n={n} start={ch.created_at_ms + p * periodMs} periodMs={periodMs} cur={cur} next={ch.next_period} />
              ))}
            </tbody>
          </table>
          {ch.next_period < cur && (
            <div style={{ marginTop: 12 }}>
              <Act className="btn ghost small" label={`Settle ${word} ${day(ch.created_at_ms + ch.next_period * periodMs)}`} busyLabel="Scoring on OutLayer…"
                run={async () => { await call("settle", { channel: id }, NEAR(0.5), GAS_300); await new Promise((r) => setTimeout(r, 15_000)); await reload(); }} />
              <p className="fine">Anyone can settle an ended {word} once its signals are revealed. Attaches 0.5 NEAR for OutLayer; the unused part comes back.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function PeriodRow({ p, r, held, n, start, periodMs, cur, next }: { p: number; r: PeriodResult | null; held: string; n: number; start: number; periodMs: number; cur: number; next: number }) {
  const label = periodMs >= 7 * 86_400_000 ? `${day(start)}–${day(start + periodMs - 1)}` : periodMs >= 86_400_000 ? day(start) : when(start);
  const settled = r?.status === "Settled";
  return (
    <tr>
      <td>{label}</td>
      <td className="n">{settled ? r!.signals : n}</td>
      <td className={`n ${settled ? (r!.score_bps > 0 ? "gain" : r!.score_bps < 0 ? "loss" : "") : ""}`}>{settled ? pct(r!.score_bps) : "—"}</td>
      <td className="n">{near(settled ? r!.held : held)}</td>
      <td className="n">{settled ? <b>{r!.released ? "Creator" : "Subscribers"}</b> : <span className="sub0">{p === cur ? "open" : p >= next ? "to settle" : "settling"}</span>}</td>
    </tr>
  );
}
