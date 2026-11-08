import { useEffect, useState } from "react";
import { allSignals, call, claimable, currentPeriod, getChannel, getConfig, getMember, getPeriod, listChannels, periodHeld, subscribers } from "../near";
import { creatorRecord, record, useLoad, useNow } from "../data";
import { channelPath, day, dur, near, nearNum, pct, periodWord, planName, price, when } from "../format";
import { creatorSecret, openWithKey, signalKey, tlockOpen, roundTimeMs, type Opened } from "../crypto";
import { Act, Countdown, LiveCells, LiveLine, McapAtCall, MicroTag, Outcome, Result, SideTag, rangeState } from "../ui";
import { priceOf, venueLabel } from "../markets";
import { GAS_300, NEAR } from "../config";
import type { Channel, PeriodResult, Signal } from "../types";
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
  // For the creator: NEAR still held for periods that haven't settled yet.
  let heldAhead = 0n;
  if (account === ch.creator) {
    const from = ch.created_at_ms + ch.next_period * cfg.period_minutes * 60_000;
    const members = await Promise.all(subs.map(([a]) => getMember(id, a)));
    for (const m of members) for (const sb of m?.subs ?? []) {
      const len = BigInt(sb.end_ms - sb.start_ms), over = BigInt(Math.max(0, sb.end_ms - Math.max(sb.start_ms, from)));
      if (len > 0n) heldAhead += (BigInt(sb.held) * over) / len;
    }
  }
  const channels = await listChannels();
  const whole = channels.filter((c) => c.creator === ch.creator).length > 1
    ? await creatorRecord(ch.creator, channels, (c) => (c.id === id ? Promise.resolve(signals) : allSignals(c.id, c.signal_count)))
    : null;
  return { ch, cfg, signals, subs: subs.length, readers: subs.filter((x) => x[2]).map((x) => x[0]), cur, member, claim, periods, heldAhead, channels, whole };
}

export function ChannelPage({ id, account }: { id: number; account: string | null }) {
  const { data, error, reload } = useLoad(() => load(id, account), [id, account], 20_000, `channel:${id}:${account}`);
  const now = useNow(5000);
  const [plan, setPlan] = useState<number | null>(null);
  if (error) return <div className="notice err">{error}</div>;
  if (!data) return <p className="empty">Reading the channel from NEAR testnet…</p>;
  const { ch, cfg, signals, subs, readers, cur, member, claim, periods, heldAhead, channels, whole } = data;
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
          <div className="owner-head">
            <div>
              <div className="sub0 small">{ch.creator} · creator since {day(ch.created_at_ms)}{isCreator && <> · <span className="only">YOUR CHANNEL</span></>}</div>
              <h1 className="display m">{ch.name}{whole && rec.scored === 0 && <> <span className="newch">NEW CHANNEL</span></>}</h1>
              {ch.about && <p className="lede">{ch.about}</p>}
            </div>
            {isCreator && <a className="btn" href="#/desk">+ New signal</a>}
          </div>
          {isCreator && <ShareRow ch={ch} path={channelPath(ch, channels)} />}
          {whole && (
            <div className="whole">
              <b>{isCreator ? "Your" : "This creator's"} full record, across {whole.per.length} channels</b>
              <div className="row">
                <div><b>{whole.rec.signals}</b><span>signals</span></div>
                <div><b className={(whole.rec.score_bps ?? 0) > 0 ? "gain" : (whole.rec.score_bps ?? 0) < 0 ? "loss" : ""}>{pct(whole.rec.score_bps)}</b><span>score</span></div>
                <div><b>{whole.rec.periodsSettled ? `${whole.rec.periodsEarned} of ${whole.rec.periodsSettled}` : "—"}</b><span>{word}s earned</span></div>
                <div><b>{whole.per.length}</b><span>channels</span></div>
              </div>
              <table className="wk" style={{ marginTop: 10 }}>
                <thead><tr><th>Channel</th><th className="n">Signals</th><th className="n">Score</th><th className="n">{word[0].toUpperCase() + word.slice(1)}s earned</th></tr></thead>
                <tbody>
                  {whole.per.map((p) => (
                    <tr key={p.ch.id}><td><a href={channelPath(p.ch, channels)}><b>{p.ch.name}</b></a>{p.ch.id === ch.id ? " (this one)" : ""}</td><td className="n">{p.rec.signals}</td><td className={`n ${(p.rec.score_bps ?? 0) > 0 ? "gain" : (p.rec.score_bps ?? 0) < 0 ? "loss" : ""}`}>{pct(p.rec.score_bps)}</td><td className="n">{p.rec.periodsSettled ? `${p.rec.periodsEarned} of ${p.rec.periodsSettled}` : "—"}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="small" style={{ marginTop: 8 }}>A new channel never hides an old record.</div>
            </div>
          )}
          {isCreator && (
            <div className="money">
              <div><b>{nearNum(ch.stats.earned).toLocaleString(undefined, { maximumFractionDigits: 3 })}</b><span>NEAR paid to you</span></div>
              <div><b>{nearNum(heldAhead).toLocaleString(undefined, { maximumFractionDigits: 3 })}</b><span>NEAR held for coming {word}s</span></div>
              <div><b className={ch.stats.periods_released ? "gain" : ""}>{ch.stats.periods_released}</b><span>{word}s earned of {ch.stats.periods_released + ch.stats.periods_refunded} settled</span></div>
              <div><b>{subs} / {ch.max_members}</b><span>subscribers</span></div>
            </div>
          )}
          <div className="bigstats">
            <div><b>{rec.signals}</b><span>signals</span></div>
            <div><b>{rec.winRate == null ? "—" : `${rec.winRate}%`}</b><span>win rate (filled)</span></div>
            <div><b className={(rec.score_bps ?? 0) > 0 ? "gain" : (rec.score_bps ?? 0) < 0 ? "loss" : ""}>{pct(rec.score_bps)}</b><span>score</span></div>
            {!isCreator && <div><b>{rec.periodsSettled ? `${rec.periodsEarned} of ${rec.periodsSettled}` : "—"}</b><span>{word}s earned</span></div>}
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
                        <td>{b ? <><b className="mk">{b.market.symbol}</b> <span className="venue">{venueLabel(b.market)}</span>{b.market.venue === "gecko_micro" && <> <MicroTag /></>}<McapAtCall b={b} fill={s.fill_price} /></> : <b>{isSealed(s) ? "sealed" : "—"}</b>}</td>
                        <td>{b ? <SideTag b={b} /> : "—"}</td>
                        <td>{b ? `${price(b.entry_low)}–${price(b.entry_high)}` : "—"}</td>
                        <td>{b ? b.tps.map(price).join(" · ") : "—"}</td>
                        <td>{b ? price(b.sl) : "—"}</td>
                        <td>{dur(s.valid_min)}</td>
                        {b && s.r_bps == null && !isSealed(s) ? (
                          <LiveCells b={b} postedMs={s.posted_at_ms} validMin={s.valid_min} />
                        ) : (
                          <>
                        <td>
                          {due ? (
                            drandReady ? <Act className="btn small" label="Reveal now" busyLabel="Opening…" run={() => reveal(s)} /> : <span className="out s">opening…</span>
                          ) : (
                            <Outcome s={s} />
                          )}
                        </td>
                        <td className="n"><Result s={s} /></td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="fine">Results include fees and leverage. Fills, TPs and SL use candle closes; liquidation uses wicks. Anyone can reveal a signal once it ends. “(est.)” rows are replayed in your browser on the same candles; OutLayer writes the official result when the day settles.</p>
        </section>
      </div>

      <div>
        {isCreator && <OwnerLive signals={signals} readers={readers} account={account!} now={now} />}
        {isCreator && <EditChannel ch={ch} onDone={reload} />}
        {!isCreator && <section className="sheet">
          <h2>{active ? "Your subscription" : "Subscribe"}</h2>
          {active && <p className="notice ok-n">Active until <b>{when(member!.until_ms)}</b>. Signals appear in <a href="#/feed">My feed</a>. You can extend below.</p>}
          {(
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
        </section>}

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

// ------------------------------------------------------------------ creator view

const appUrl = () => window.location.href.split("#")[0].split("?")[0];

function ShareRow({ ch, path }: { ch: Channel; path: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${appUrl()}${path}`;
  const text = `My trading signals are sealed on @NEARProtocol: subscribers see them first, everyone sees the scored result after. Nothing can be deleted. ${url}`;
  return (
    <div className="share">
      <span className="sub0 small">Share your channel</span>
      <code className="url">{url.replace(/^https?:\/\//, "")}</code>
      <button className="btn ghost small" onClick={async () => { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? "Copied" : "Copy link"}</button>
      <a className="btn ghost small" href={`https://x.com/intent/post?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">Post on X</a>
    </div>
  );
}

function OwnerLive({ signals, readers, account, now }: { signals: Signal[]; readers: string[]; account: string; now: number }) {
  const live = signals.filter((s) => isSealed(s) && opensAt(s) > now);
  const [open, setOpen] = useState<Record<number, Opened | null>>({});
  const [prices, setPrices] = useState<Record<number, number | null>>({});
  useEffect(() => {
    const secret = creatorSecret(account);
    if (!secret) return;
    for (const s of live) {
      if (s.id in open) continue;
      signalKey(secret, s.commit).then((k) => openWithKey(s, k)).then((o) => setOpen((x) => ({ ...x, [s.id]: o })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.map((s) => s.id).join(","), account]);
  useEffect(() => {
    const tick = () => Object.entries(open).forEach(([id, o]) => o?.body && priceOf(o.body.market).then((p) => setPrices((x) => ({ ...x, [Number(id)]: p }))));
    tick();
    const t = setInterval(tick, 20_000);
    return () => clearInterval(t);
  }, [open]);
  return (
    <section className="sheet">
      <div className="row-between"><h2>Your live signals</h2><span className="only">ONLY YOU</span></div>
      <p className="sub">Decrypted with your creator key, in this browser.</p>
      {live.length === 0 && <p className="sub0">Nothing live. <a href="#/desk">Post a signal</a>.</p>}
      {live.map((s) => {
        const o = open[s.id];
        const b = o?.body;
        const have = s.wrapped_keys.filter((w) => readers.includes(w.member)).length;
        return (
          <div className="card fresh mini" key={s.id}>
            <div className="tape" />
            <div className="hd"><span>{when(s.posted_at_ms)}</span><span>public in <Countdown to={opensAt(s)} now={now} /></span></div>
            <div className="bd">
              {b ? (
                <>
                  <div className="face m"><div className="tok">{b.market.venue !== "hyperliquid" ? <><span className="long">BUY</span> {b.market.symbol}{b.market.venue === "gecko_micro" && <> <MicroTag /></>}</> : <><span className={b.side}>{b.side.toUpperCase()}</span> {b.market.symbol} · {b.leverage}x</>}</div></div>
                  <div className="levels">
                    <div><span>{b.side === "short" ? "Sell" : "Buy"}</span><b>{price(b.entry_low)}–{price(b.entry_high)}</b></div>
                    <div><span>TP</span><b>{b.tps.map(price).join(" · ")}</b></div>
                    <div><span>SL</span><b>{price(b.sl)}</b></div>
                    <div><span>Now</span><b>{prices[s.id] != null ? price(String(Number(prices[s.id]!.toPrecision(6)))) : "—"}</b></div>
                  </div>
                  <LiveLine b={b} postedMs={s.posted_at_ms} validMin={s.valid_min} />
                  <div className="small" style={{ marginTop: 10 }}>
                    <span className={have >= readers.length ? "gain" : "loss"}><b>{have >= readers.length ? "✓ " : ""}{have} of {readers.length} subscribers</b></span> have it
                    {prices[s.id] != null && <> · {rangeState(b, prices[s.id]!)}</>}
                  </div>
                </>
              ) : o === null ? (
                <p className="sub0">Posted from another browser or before late access: this browser's creator key can't open it. It opens for everyone when it ends.</p>
              ) : creatorSecret(account) ? (
                <p className="sub0">Decrypting…</p>
              ) : (
                <p className="sub0">This browser has no creator key. Post from here, or paste your key on the <a href="#/desk">creator desk</a>.</p>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

const DURATIONS = [7, 14, 30, 180, 365];

function EditChannel({ ch, onDone }: { ch: Channel; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(ch.name);
  const [about, setAbout] = useState(ch.about);
  const [max, setMax] = useState(String(ch.max_members));
  const days = [...new Set([...DURATIONS, ...ch.plans.map((p) => p.days)])].sort((a, b) => a - b).slice(0, 6);
  const [prices, setPrices] = useState<Record<number, string>>(Object.fromEntries(days.map((d) => [d, (() => { const p = ch.plans.find((x) => x.days === d); return p ? String(nearNum(p.price)) : ""; })()])));
  return (
    <section className="sheet">
      <h2>Subscribe</h2>
      <p className="sub">Visitors see your plans here: {ch.plans.map((p) => `${near(p.price)} / ${planName(p.days)}`).join(", ")}.</p>
      {!open ? (
        <button className="btn ghost wide" onClick={() => setOpen(true)}>Edit plans and description</button>
      ) : (
        <div>
          <label htmlFor="en">Channel name</label>
          <input id="en" type="text" maxLength={48} value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="ea">What you post</label>
          <textarea id="ea" maxLength={400} value={about} onChange={(e) => setAbout(e.target.value)} />
          <label>Prices in NEAR <span className="sub0">(empty = no such plan; new prices apply to new subscriptions)</span></label>
          <div className="plan-edit">
            {days.map((d) => (
              <div key={d}><span>{planName(d)}</span><input type="text" inputMode="decimal" value={prices[d] ?? ""} onChange={(e) => setPrices({ ...prices, [d]: e.target.value })} /></div>
            ))}
          </div>
          <label htmlFor="em">Most subscribers at once</label>
          <input id="em" type="text" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))} />
          <div className="two" style={{ marginTop: 14 }}>
            <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            <Act label="Save changes" busyLabel="Waiting for the wallet…" disabled={!name.trim() || !days.some((d) => Number(prices[d]) > 0)}
              run={async () => {
                const plans = days.filter((d) => Number(prices[d]) > 0).map((d) => ({ days: d, price: NEAR(Number(prices[d])) }));
                await call("update_channel", { channel: ch.id, name: name.trim(), about: about.trim(), plans, max_members: Math.min(100, Math.max(1, Number(max) || 1)) });
                setOpen(false);
                onDone();
              }} />
          </div>
        </div>
      )}
    </section>
  );
}
