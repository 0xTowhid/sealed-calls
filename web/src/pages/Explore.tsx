import { useState } from "react";
import { allSignals, getConfig, listChannels, subscribers } from "../near";
import { record, useLoad } from "../data";
import { near, pct, periodWord, planName } from "../format";
import { TickLegend, Ticks } from "../ui";
import type { Channel, Config, Signal } from "../types";

type Row = { ch: Channel; signals: Signal[]; subs: number; rec: ReturnType<typeof record> };

async function loadAll(): Promise<{ cfg: Config; rows: Row[] }> {
  const [cfg, channels] = await Promise.all([getConfig(), listChannels()]);
  const rows = await Promise.all(
    channels.map(async (ch) => {
      const [signals, subs] = await Promise.all([allSignals(ch.id, ch.signal_count), subscribers(ch.id)]);
      return { ch, signals, subs: subs.length, rec: record(ch, signals) };
    }),
  );
  rows.sort((a, b) => (b.rec.score_bps ?? -1e9) - (a.rec.score_bps ?? -1e9) || b.rec.scored - a.rec.scored);
  return { cfg, rows };
}

export function Explore() {
  const { data, error } = useLoad(loadAll, [], 30_000);
  const [filter, setFilter] = useState<"all" | "perp" | "dex">("all");
  const word = data ? periodWord(data.cfg.period_minutes) : "week";
  const rows = (data?.rows ?? []).filter(
    (r) => filter === "all" || r.signals.some((s) => s.body && (filter === "perp" ? s.body.market.venue === "hyperliquid" : s.body.market.venue === "gecko")),
  );

  return (
    <>
      <div className="hero">
        <section className="sheet">
          <h1 className="display">Trading signals with a record nobody can edit.</h1>
          <p className="lede">
            Subscribers get each signal the second it's posted. When it ends, everyone sees it, scored on real prices: fills, TPs, SL,
            leverage, fees. Creators earn half of every subscription up front, and the other half only for {word}s their signals make money.
          </p>
          <div className="chips static">
            <span>Perps on Hyperliquid</span><span>Spot &amp; memecoins on any DEX chain</span><span>Long &amp; short</span><span>Settled on NEAR</span>
          </div>
        </section>
        <section className="sheet">
          <h2>Where your money goes</h2>
          <div className="split" aria-hidden><i /><i className="held" /></div>
          <div className="split-k"><span><b>50%</b> to the creator now</span><span><b>50%</b> held, {word} by {word}</span></div>
          <div className="flow">
            <div><b className="mono">Every {word}</b><span>The creator's signals from that {word} are scored.</span></div>
            <div><b className="mono">Positive</b><span>That {word}'s held half goes to the creator.</span></div>
            <div><b className="mono">Negative</b><span>You claim that {word}'s half back, or if the creator posted nothing.</span></div>
          </div>
        </section>
      </div>

      <section className="sheet">
        <div className="row-between">
          <h2>Creators</h2>
          <span className="sub0 small">Ranked by score: total result ÷ (signals + 5)</span>
        </div>
        <div className="chips" role="group" aria-label="Filter">
          {(["all", "perp", "dex"] as const).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "perp" ? "Perps" : "DEX tokens"}</button>
          ))}
        </div>
        {error && <div className="notice err">{error}</div>}
        {!data && !error && <p className="empty">Reading creators from NEAR testnet…</p>}
        {data && rows.length === 0 && (
          <p className="empty">No creators yet. <a href="#/desk">Open the creator desk</a> to start a channel.</p>
        )}
        {rows.length > 0 && (
          <div className="scroll">
            <table className="creators">
              <thead>
                <tr><th /><th>Creator</th><th>Every signal, oldest → newest</th><th className="n">Signals</th><th className="n">Win rate</th><th className="n">Score</th><th className="n">{word[0].toUpperCase() + word.slice(1)}s earned</th><th className="n">Subscribers</th><th className="n">From</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const cheapest = [...r.ch.plans].sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : 1))[0];
                  return (
                    <tr key={r.ch.id} onClick={() => (window.location.hash = `#/c/${r.ch.id}`)} className="click">
                      <td className="rank">{i + 1}</td>
                      <td><a href={`#/c/${r.ch.id}`} className="cname">{r.ch.name}</a><div className="sub0 small">{r.ch.creator}{r.ch.about ? ` · ${r.ch.about.length > 64 ? r.ch.about.slice(0, 62).replace(/\s+\S*$/, "") + "…" : r.ch.about}` : ""}</div></td>
                      <td><Ticks signals={r.signals} /></td>
                      <td className="n">{r.rec.signals}</td>
                      <td className="n">{r.rec.winRate == null ? "—" : `${r.rec.winRate}%`}</td>
                      <td className={`n score ${(r.rec.score_bps ?? 0) > 0 ? "gain" : (r.rec.score_bps ?? 0) < 0 ? "loss" : ""}`}>{pct(r.rec.score_bps)}</td>
                      <td className="n">{r.rec.periodsSettled ? `${r.rec.periodsEarned} of ${r.rec.periodsSettled}` : "—"}</td>
                      <td className="n">{r.subs} / {r.ch.max_members}</td>
                      <td className="n">{cheapest ? <><b>{near(cheapest.price)}</b><div className="sub0 small">{planName(cheapest.days)}</div></> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TickLegend />
      </section>
    </>
  );
}
