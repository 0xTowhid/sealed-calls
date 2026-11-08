import { useEffect, useState } from "react";
import { allSignals, channelTags, getConfig, listChannels, subscribers } from "../near";
import { record, useLoad } from "../data";
import { near, pct, periodWord, planName } from "../format";
import { KindTags, kindsShown, TickLegend, Ticks } from "../ui";
import { mcapAtCall, usdShort } from "../markets";
import type { Channel, Config, Signal } from "../types";

type Kind = "perp" | "dex" | "micro";
type Row = { ch: Channel; signals: Signal[]; subs: number; rec: ReturnType<typeof record>; kinds: Set<Kind>; tags: string[] };

const KIND_OF = { hyperliquid: "perp", gecko: "dex", gecko_micro: "micro" } as const;
const TAG_KIND: Record<string, Kind> = { perps: "perp", dex: "dex", micro: "micro" };

/** Which tabs a channel belongs to: what the creator declared, plus every kind it has actually
 *  revealed. Nothing declared → the kinds it has revealed; nothing revealed yet → all kinds. */
function kindsOf(tags: string[], signals: Signal[]): Set<Kind> {
  const shown = new Set<Kind>(signals.flatMap((s) => (s.body ? [KIND_OF[s.body.market.venue]] : [])));
  const declared = tags.map((t) => TAG_KIND[t]).filter(Boolean);
  if (declared.length) return new Set([...declared, ...shown]);
  return shown.size ? shown : new Set<Kind>(["perp", "dex", "micro"]);
}

async function loadAll(): Promise<{ cfg: Config; rows: Row[] }> {
  const [cfg, channels] = await Promise.all([getConfig(), listChannels()]);
  const tags = await channelTags(channels.map((c) => c.id));
  const rows = await Promise.all(
    channels.map(async (ch, i) => {
      const [signals, subs] = await Promise.all([allSignals(ch.id, ch.signal_count), subscribers(ch.id)]);
      return { ch, signals, subs: subs.length, rec: record(ch, signals), kinds: kindsOf(tags[i] ?? [], signals), tags: tags[i] ?? [] };
    }),
  );
  rows.sort((a, b) => (b.rec.score_bps ?? -1e9) - (a.rec.score_bps ?? -1e9) || b.rec.scored - a.rec.scored);
  return { cfg, rows };
}

export function Explore() {
  const { data, error } = useLoad(loadAll, [], 30_000, "explore");
  const [filter, setFilter] = useState<"all" | "perp" | "dex" | "micro">("all");
  const word = data ? periodWord(data.cfg.period_minutes) : "week";
  // Ranked by creator (account), on all their channels together: a new channel can't wash a record.
  const groups = new Map<string, Row[]>();
  for (const r of data?.rows ?? []) groups.set(r.ch.creator, [...(groups.get(r.ch.creator) ?? []), r]);
  const creators = [...groups.entries()]
    .map(([creator, chans]) => {
      // In a category tab: only the channels that post that kind, ranked on that kind's signals.
      // Sealed signals have no public kind yet; they still count in the All tab.
      const inTab = filter === "all" ? chans : chans.filter((c) => c.kinds.has(filter));
      const all = chans.flatMap((c) => c.signals);
      const sigs = filter === "all" ? all : all.filter((s) => s.body && KIND_OF[s.body.market.venue] === filter);
      const rec = record(chans[0].ch, sigs);
      const earned = chans.reduce((a, c) => a + c.ch.stats.periods_released, 0);
      const settled = chans.reduce((a, c) => a + c.ch.stats.periods_released + c.ch.stats.periods_refunded, 0);
      const plans = chans.flatMap((c) => c.ch.plans);
      const cheapest = [...plans].sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : 1))[0];
      return { creator, chans, inTab, sigs, rec, earned, settled, cheapest, subs: chans.reduce((a, c) => a + c.subs, 0) };
    })
    .filter((g) => g.inTab.length > 0 || g.sigs.length > 0)
    .sort((a, b) => (b.rec.score_bps ?? -1e9) - (a.rec.score_bps ?? -1e9) || b.rec.scored - a.rec.scored);
  const rows = creators;
  const microRows = filter === "micro" ? creators : [];
  const tabName = { all: "", perp: "perp", dex: "DEX token", micro: "micro-cap" }[filter];

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
          filter === "all"
            ? <p className="empty">No creators yet. <a href="#/desk">Open the creator desk</a> to start a channel.</p>
            : <p className="empty">No channels post {tabName} signals yet. <a href="#/desk">Start one on the creator desk</a>.</p>
        )}
        {filter === "micro" && microRows.length > 0 && (
          <div className="scroll">
            <table className="creators">
              <thead><tr><th /><th>Creator</th><th>Micro-cap signals, oldest → newest</th><th className="n">Micro-cap signals</th><th className="n">Win rate</th><th className="n">Micro-cap score</th><th className="n">Avg mcap at call</th></tr></thead>
              <tbody>
                {microRows.map((r, i) => (
                  <tr key={r.creator} onClick={() => (window.location.hash = `#/@${r.creator}`)} className="click">
                    <td className="rank">{i + 1}</td>
                    <td><a href={`#/@${r.creator}`} className="cname">{r.creator}</a><div className="sub0 small">{r.inTab.map((c) => c.ch.name).join(" · ")}</div></td>
                    <td>{r.sigs.length ? <Ticks signals={r.sigs} /> : <span className="sub0 small">None ended yet</span>}</td>
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
                    <td><a href={`#/@${r.creator}`} className="cname">{r.chans.length === 1 ? r.chans[0].ch.name : r.creator}</a>{r.chans.length === 1 && <KindTags kinds={kindsShown(r.chans[0].tags, r.chans[0].signals)} />}<div className="sub0 small">{r.chans.length === 1 ? r.creator : r.inTab.map((c, j) => <span key={c.ch.id}>{j ? " · " : ""}{c.ch.name}<KindTags kinds={kindsShown(c.tags, c.signals)} /></span>)}</div></td>
                    <td>{r.sigs.length || filter === "all" ? <Ticks signals={r.sigs} /> : <span className="sub0 small">None ended yet</span>}</td>
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
