import { useEffect, useState } from "react";
import { allSignals, getConfig, listChannels, subscribers } from "../near";
import { record, useLoad } from "../data";
import { near, pct, periodWord, planName } from "../format";
import { TickLegend, Ticks } from "../ui";
import { mcapAtCall, usdShort } from "../markets";
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
  const { data, error } = useLoad(loadAll, [], 30_000, "explore");
  const [filter, setFilter] = useState<"all" | "perp" | "dex" | "micro">("all");
  const word = data ? periodWord(data.cfg.period_minutes) : "week";
  const venueOf = { perp: "hyperliquid", dex: "gecko", micro: "gecko_micro" } as const;
  // Ranked by creator (account), on all their channels together: a new channel can't wash a record.
  const groups = new Map<string, Row[]>();
  for (const r of data?.rows ?? []) groups.set(r.ch.creator, [...(groups.get(r.ch.creator) ?? []), r]);
  const creators = [...groups.entries()]
    .map(([creator, chans]) => {
      const all = chans.flatMap((c) => c.signals);
      const sigs = filter === "all" ? all : all.filter((s) => s.body?.market.venue === venueOf[filter]);
      const rec = record(chans[0].ch, sigs);
      const earned = chans.reduce((a, c) => a + c.ch.stats.periods_released, 0);
      const settled = chans.reduce((a, c) => a + c.ch.stats.periods_released + c.ch.stats.periods_refunded, 0);
      const plans = chans.flatMap((c) => c.ch.plans);
      const cheapest = [...plans].sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : 1))[0];
      return { creator, chans, sigs, rec, earned, settled, cheapest, subs: chans.reduce((a, c) => a + c.subs, 0) };
    })
    .filter((g) => filter === "all" || g.sigs.length > 0)
    .sort((a, b) => (b.rec.score_bps ?? -1e9) - (a.rec.score_bps ?? -1e9) || b.rec.scored - a.rec.scored);
  const rows = creators;
  const microRows = filter === "micro" ? creators : [];

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
          <span className="sub0 small">Creators ranked on all their channels together. Score: total result ÷ (signals + 5)</span>
        </div>
        <div className="chips" role="group" aria-label="Filter">
          {(["all", "perp", "dex", "micro"] as const).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{{ all: "All", perp: "Perps", dex: "DEX tokens", micro: "Micro-caps" }[f]}</button>
          ))}
        </div>
        {error && <div className="notice err">{error}</div>}
        {!data && !error && <p className="empty">Reading creators from NEAR testnet…</p>}
        {data && rows.length === 0 && (
          <p className="empty">No creators yet. <a href="#/desk">Open the creator desk</a> to start a channel.</p>
        )}
        {filter === "micro" && microRows.length > 0 && (
          <div className="scroll">
            <table className="creators">
              <thead><tr><th /><th>Creator</th><th>Micro-cap signals, oldest → newest</th><th className="n">Micro-cap signals</th><th className="n">Win rate</th><th className="n">Micro-cap score</th><th className="n">Avg mcap at call</th></tr></thead>
              <tbody>
                {microRows.map((r, i) => (
                  <tr key={r.creator} onClick={() => (window.location.hash = `#/@${r.creator}`)} className="click">
                    <td className="rank">{i + 1}</td>
                    <td><a href={`#/@${r.creator}`} className="cname">{r.creator}</a><div className="sub0 small">{r.chans.map((c) => c.ch.name).join(" · ")}</div></td>
                    <td><Ticks signals={r.sigs} /></td>
                    <td className="n">{r.sigs.length}</td>
                    <td className="n">{r.rec.winRate == null ? "—" : `${r.rec.winRate}%`}</td>
                    <td className={`n score ${(r.rec.score_bps ?? 0) > 0 ? "gain" : (r.rec.score_bps ?? 0) < 0 ? "loss" : ""}`}>{pct(r.rec.score_bps)}</td>
                    <td className="n"><AvgMcap signals={r.sigs} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fine">Ranked only on micro-cap signals (pools under the normal liquidity floor, scored with stricter rules). The “All” tab ranks everything together.</p>
          </div>
        )}
        {filter === "micro" && data && microRows.length === 0 && <p className="empty">No micro-cap signals yet.</p>}
        {filter !== "micro" && rows.length > 0 && (
          <div className="scroll">
            <table className="creators">
              <thead>
                <tr><th /><th>Creator</th><th>Every signal, oldest → newest</th><th className="n">Channels</th><th className="n">Signals</th><th className="n">Win rate</th><th className="n">Score</th><th className="n">{word[0].toUpperCase() + word.slice(1)}s earned</th><th className="n">Subscribers</th><th className="n">From</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.creator} onClick={() => (window.location.hash = `#/@${r.creator}`)} className="click">
                    <td className="rank">{i + 1}</td>
                    <td><a href={`#/@${r.creator}`} className="cname">{r.chans.length === 1 ? r.chans[0].ch.name : r.creator}</a><div className="sub0 small">{r.chans.length === 1 ? r.creator : r.chans.map((c) => c.ch.name).join(" · ")}</div></td>
                    <td><Ticks signals={r.sigs} /></td>
                    <td className="n">{r.chans.length}</td>
                    <td className="n">{r.rec.signals}</td>
                    <td className="n">{r.rec.winRate == null ? "—" : `${r.rec.winRate}%`}</td>
                    <td className={`n score ${(r.rec.score_bps ?? 0) > 0 ? "gain" : (r.rec.score_bps ?? 0) < 0 ? "loss" : ""}`}>{pct(r.rec.score_bps)}</td>
                    <td className="n">{r.settled ? `${r.earned} of ${r.settled}` : "—"}</td>
                    <td className="n">{r.subs}</td>
                    <td className="n">{r.cheapest ? <><b>{near(r.cheapest.price)}</b><div className="sub0 small">{planName(r.cheapest.days)}</div></> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <TickLegend />
      </section>
    </>
  );
}

function AvgMcap({ signals }: { signals: Signal[] }) {
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    const done = signals.filter((s) => s.body);
    Promise.all(done.map((s) => mcapAtCall(s.body!.market, Number(s.fill_price ?? 0) || (Number(s.body!.entry_low) + Number(s.body!.entry_high)) / 2)))
      .then((xs) => { const ok = xs.filter((x): x is number => x != null); setV(ok.length ? ok.reduce((a, x) => a + x, 0) / ok.length : null); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals.map((s) => s.id).join(",")]);
  return <>{v == null ? "—" : usdShort(v)}</>;
}
