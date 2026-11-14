import { useEffect, useState } from "react";
import { allSignals, channelTags, getConfig, listChannels, subscribers } from "../near";
import { record, useLoad, useNow } from "../data";
import { countdown, near, nearNum, outcomeText, pct, periodWord, planName, price } from "../format";
import { Avatar, KindTags, kindsShown, Ticks } from "../ui";
import { CONTRACT, EXPLORER } from "../config";
import { isSealed, opensAt } from "../types";
import { mcapAtCall, usdShort } from "../markets";
import type { Channel, Config, Signal } from "../types";

type Kind = "perp" | "dex" | "micro";
type Row = { ch: Channel; signals: Signal[]; subs: number; rec: ReturnType<typeof record>; kinds: Set<Kind>; tags: string[]; active: number };

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

export async function loadAll(): Promise<{ cfg: Config; rows: Row[] }> {
  const [cfg, channels] = await Promise.all([getConfig(), listChannels()]);
  const tags = await channelTags(channels.map((c) => c.id));
  const rows = await Promise.all(
    channels.map(async (ch, i) => {
      const [signals, subs] = await Promise.all([allSignals(ch.id, ch.signal_count), subscribers(ch.id)]);
      const now = Date.now();
      return { ch, signals, subs: subs.length, active: subs.filter((x) => Number(x[1]) > now).length, rec: record(ch, signals), kinds: kindsOf(tags[i] ?? [], signals), tags: tags[i] ?? [] };
    }),
  );
  rows.sort((a, b) => (b.rec.score_bps ?? -1e9) - (a.rec.score_bps ?? -1e9) || b.rec.scored - a.rec.scored);
  return { cfg, rows };
}

export function Explore({ account }: { account?: string | null }) {
  const { data, error } = useLoad(loadAll, [], 30_000, "explore");
  const now = useNow(1000);
  const [filter, setFilter] = useState<"all" | "perp" | "dex" | "micro">("all");
  const word = data ? periodWord(data.cfg.period_minutes) : "day";
  // Ranked by creator (account), on all their channels together: a new channel can't wash a record.
  const groups = new Map<string, Row[]>();
  for (const r of data?.rows ?? []) groups.set(r.ch.creator, [...(groups.get(r.ch.creator) ?? []), r]);
  const rows = [...groups.entries()]
    .map(([creator, chans]) => {
      // In a category tab: only the channels that post that kind, ranked on that kind's signals.
      const inTab = filter === "all" ? chans : chans.filter((c) => c.kinds.has(filter));
      const all = chans.flatMap((c) => c.signals);
      const sigs = filter === "all" ? all : all.filter((s) => s.body && KIND_OF[s.body.market.venue] === filter);
      const rec = record(chans[0].ch, sigs);
      const earned = chans.reduce((a, c) => a + c.ch.stats.periods_released, 0);
      const settled = chans.reduce((a, c) => a + c.ch.stats.periods_released + c.ch.stats.periods_refunded, 0);
      const plans = chans.flatMap((c) => c.ch.plans);
      const cheapest = [...plans].sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : 1))[0];
      const sealed = all.filter((x) => isSealed(x)).length;
      const kinds = [...new Set(chans.flatMap((c) => kindsShown(c.tags, c.signals)))];
      const anyAll = chans.some((c) => kindsShown(c.tags, c.signals).length === 0);
      return { creator, chans, inTab, sigs, rec, earned, settled, cheapest, sealed, kinds: anyAll ? [] : kinds, subs: chans.reduce((a, c) => a + c.active, 0) };
    })
    .filter((g) => g.inTab.length > 0 || g.sigs.length > 0)
    .sort((a, b) => (b.rec.score_bps ?? -1e9) - (a.rec.score_bps ?? -1e9) || b.rec.scored - a.rec.scored);
  const tabName = { all: "", perp: "perp", dex: "DEX token", micro: "micro-cap" }[filter];

  // Real numbers for the strip and a real call for the explainer, when there is one.
  const chans = data?.rows ?? [];
  const allSigs = chans.flatMap((r) => r.signals);
  const kpi = {
    calls: chans.reduce((a, r) => a + r.ch.signal_count, 0),
    traders: new Set(chans.map((r) => r.ch.creator)).size,
    subs: chans.reduce((a, r) => a + r.active, 0),
    paid: chans.reduce((a, r) => a + nearNum(r.ch.stats.earned), 0),
    back: chans.reduce((a, r) => a + nearNum(r.ch.stats.refundable), 0),
  };
  const scoredBodies = [...allSigs].filter((s) => s.body && s.r_bps != null).sort((a, b) => b.posted_at_ms - a.posted_at_ms);
  const example = scoredBodies.find((s) => s.r_bps !== 0) ?? scoredBodies[0];
  const liveSealed = [...allSigs].filter((s) => isSealed(s) && opensAt(s) > now).sort((a, b) => opensAt(a) - opensAt(b))[0];
  const name = (r: (typeof rows)[number]) => (r.chans.length === 1 ? r.chans[0].ch.name : r.creator);
  const sub = (r: (typeof rows)[number]) => (r.chans.length === 1 ? r.creator : `${r.chans.length} channels`);
  const meta = (r: (typeof rows)[number]) =>
    filter !== "all" && !r.sigs.length ? "none ended yet"
      : r.rec.scored === 0 ? `new trader${r.sealed ? ` · ${r.sealed} sealed` : ""}`
        : `${r.rec.scored} ended${r.rec.winRate != null ? ` · ${r.rec.winRate}% won` : ""}${r.cheapest ? ` · from ${near(r.cheapest.price)}/${planName(r.cheapest.days)}` : ""}`;

  return (
    <>
      <section className="intro">
        <div className="panel say">
          <span className="eyebrow"><span className="dot" />Trading signals with an on-chain track record</span>
          <h1>Signal groups where the losing calls stay public.</h1>
          <p>Subscribe to a trader's calls, like a Telegram group. Every call is sealed when it's posted, opened when it ends and scored on real prices. Traders keep the full fee only when their calls make money.</p>
          <div className="ctas">
            <a className="btn" href="#leaderboard" onClick={(e) => { e.preventDefault(); document.getElementById("leaderboard")?.scrollIntoView({ behavior: "smooth" }); }}>Find a trader</a>
            <a className="btn ghost" href={account ? "#/desk" : "#/desk"}>Start a channel</a>
          </div>
        </div>
        <div className="panel steps">
          <h3><span>How one call works</span>{example?.body && <span className="num">{example.body.market.symbol} · {example.body.market.venue === "hyperliquid" ? `${example.body.leverage}x ${example.body.side}` : "spot buy"}</span>}</h3>
          <div className="flow3">
            <div className="s1">
              <span className="n"><span>1 · Posted</span>{example && <span>{new Date(example.posted_at_ms).toTimeString().slice(0, 5)}</span>}</span>
              <b><span className="lock" />Sealed</b>
              <p>Only subscribers can read it. It can't be edited or deleted.</p>
              {liveSealed ? <span className="cd" title="A real sealed call on the board">{countdown(opensAt(liveSealed), now)}</span> : <span className="cd">locked</span>}
            </div>
            <div className="s2">
              <span className="n"><span>2 · Ended</span><span>public</span></span>
              <b>Opened for everyone</b>
              <p>Anyone can check the call against the market.</p>
              {example?.body && (
                <div className="lv">
                  <span>{example.body.side === "short" ? "Sell" : "Buy"}</span><span>{price(example.body.entry_low)}–{price(example.body.entry_high)}</span>
                  <span>TP</span><span>{example.body.tps.map(price).join(" · ")}</span>
                  <span>SL</span><span>{price(example.body.sl)}</span>
                </div>
              )}
            </div>
            <div className={`s3 ${example && (example.r_bps ?? 0) < 0 ? "lost" : example && example.r_bps === 0 ? "flat" : ""}`}>
              <span className="n"><span>3 · Scored</span><span>real candles</span></span>
              <b>{example ? outcomeText(example.outcome) || "Scored" : "Scored"}</b>
              <p>{!example || (example.r_bps ?? 0) > 0 ? "Winning days release the held half of subscriptions to the trader." : "Losing days: subscribers claim the held half back."}</p>
              {example && <span className={`big3 ${(example.r_bps ?? 0) < 0 ? "loss" : (example.r_bps ?? 0) === 0 ? "ink3" : ""}`}>{example.r_bps === 0 ? "0%" : pct(example.r_bps)}</span>}
            </div>
          </div>
        </div>
      </section>

      <section className="panel kpis">
        <div><span>Calls posted</span><b>{data ? kpi.calls : "—"}</b></div>
        <div><span>Traders</span><b>{data ? kpi.traders : "—"}</b></div>
        <div><span>Active subscribers</span><b>{data ? kpi.subs : "—"}</b></div>
        <div><span>Paid to traders</span><b>{data ? kpi.paid.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}<small>NEAR</small></b></div>
        <div><span>Returned to subscribers</span><b>{data ? kpi.back.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}<small>NEAR</small></b></div>
      </section>

      <div className="lb-head" id="leaderboard">
        <h2>Leaderboard</h2>
        <div className="chips" role="group" aria-label="Markets">
          {(["all", "perp", "dex", "micro"] as const).map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{{ all: "All", perp: "Perps", dex: "DEX tokens", micro: "Micro-caps" }[f]}</button>
          ))}
        </div>
        <span className="sort">Ranked by score: total result ÷ (calls + 5), which dampens a few lucky calls (a single +300% call still scores +50%)</span>
      </div>
      {error && <div className="notice err">{error}</div>}
      <section className="panel">
        {!data && !error && <p className="empty" style={{ padding: 20 }}>Reading traders from NEAR testnet…</p>}
        {data && rows.length === 0 && (
          <p className="empty" style={{ padding: 20 }}>{filter === "all" ? <>No traders yet. <a href="#/desk">Start a channel</a>.</> : <>No channels post {tabName} calls yet. <a href="#/desk">Start one</a>.</>}</p>
        )}
        {rows.length > 0 && (
          <>
            <ol className="clist">
              {rows.map((r) => (
                <li key={r.creator}>
                  <a href={`#/@${r.creator}`}>
                    <span className="who"><Avatar id={r.creator} size={30} /><span><b>{name(r)}</b><small>{sub(r)}</small></span></span>
                    <span className={`score ${(r.rec.score_bps ?? 0) > 0 ? "gain" : (r.rec.score_bps ?? 0) < 0 ? "loss" : "ink3"}`}>{pct(r.rec.score_bps)}</span>
                    <span className="meta"><Ticks signals={r.sigs} /><span>{meta(r)}</span><span className="chev" aria-hidden>›</span></span>
                  </a>
                </li>
              ))}
            </ol>
            <div className="scroll desk-only">
              <table className="lb">
                <thead><tr><th /><th>Trader</th><th>Markets</th><th>{filter === "all" ? "Last calls" : `${tabName[0].toUpperCase() + tabName.slice(1)} calls`}</th><th className="n">Won</th><th className="n">{word[0].toUpperCase() + word.slice(1)}s paid</th><th className="n">Subscribers</th><th className="n">Score</th><th className="n">{filter === "micro" ? "Avg mcap at call" : "From"}</th><th /></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.creator} className="click" onClick={() => (window.location.hash = `#/@${r.creator}`)}>
                      <td className="rk">{i + 1}</td>
                      <td><div className="who"><Avatar id={r.creator} /><div><b>{name(r)}</b><small>{r.chans.length === 1 ? r.creator : r.inTab.map((c) => c.ch.name).join(" · ")}</small></div></div></td>
                      <td><div className="kinds"><KindTags kinds={r.kinds} />{r.rec.scored === 0 && <span className="newch">New</span>}</div></td>
                      <td>{r.sigs.length ? <Ticks signals={r.sigs} /> : <span className="ink3 small">none ended yet</span>}</td>
                      <td className="n">{r.rec.winRate == null ? "—" : `${r.rec.winRate}%`}</td>
                      <td className="n">{r.settled ? `${r.earned} of ${r.settled}` : "—"}</td>
                      <td className="n">{r.subs}</td>
                      <td className={`n score ${(r.rec.score_bps ?? 0) > 0 ? "gain" : (r.rec.score_bps ?? 0) < 0 ? "loss" : "ink3"}`}>{pct(r.rec.score_bps)}</td>
                      <td className="n">{filter === "micro" ? <AvgMcap signals={r.sigs} /> : r.cheapest ? <>{nearNum(r.cheapest.price).toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="ink3">NEAR / {planName(r.cheapest.days)}</span></> : "—"}</td>
                      <td className="n"><a className="btn ghost small" href={`#/@${r.creator}`} onClick={(e) => e.stopPropagation()}>View</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="lb-foot">
          <span className="legend"><span><i className="w" />won</span><span><i className="l" />lost</span><span><i className="d" />−100%</span><span><i className="n" />not filled</span><span><i className="s" />sealed</span></span>
          <a className="r" href={`${EXPLORER}/address/${CONTRACT}`} target="_blank" rel="noreferrer">Contract {CONTRACT} ↗</a>
        </div>
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
