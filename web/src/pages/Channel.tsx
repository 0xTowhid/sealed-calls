import { useEffect, useState } from "react";
import { allSignals, call, signIn, claimable, currentPeriod, channelTags, getChannel, getConfig, getMember, getPeriod, listChannels, periodHeld, subscribers } from "../near";
import { creatorRecord, record, useLoad, useNow } from "../data";
import { channelPath, day, dur, near, nearNum, pct, periodWord, planName, price, when } from "../format";
import { creatorSecret, openWithKey, signalKey, tlockOpen, roundTimeMs, type Opened } from "../crypto";
import { Act, Avatar, KindPicker, KindTags, kindsShown, Countdown, LiveLine, McapAtCall, MicroTag, Outcome, Result, ResultChart, SideTag, rangeState, useLive } from "../ui";
import { priceOf, venueLabel } from "../markets";
import { CONTRACT, EXPLORER, GAS_300, NEAR } from "../config";
import type { Channel, PeriodResult, Signal, SignalBody } from "../types";
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
  const [channels, [tags]] = await Promise.all([listChannels(), channelTags([id])]);
  const whole = channels.filter((c) => c.creator === ch.creator).length > 1
    ? await creatorRecord(ch.creator, channels, (c) => (c.id === id ? Promise.resolve(signals) : allSignals(c.id, c.signal_count)))
    : null;
  return { ch, cfg, signals, subs: subs.length, readers: subs.filter((x) => x[2]).map((x) => x[0]), cur, member, claim, periods, heldAhead, channels, whole, tags: tags ?? [] };
}

export function ChannelPage({ id, account }: { id: number; account: string | null }) {
  const { data, error, reload } = useLoad(() => load(id, account), [id, account], 20_000, `channel:${id}:${account}`);
  const now = useNow(5000);
  const [plan, setPlan] = useState<number | null>(null);
  const [show, setShow] = useState<"all" | "won" | "lost" | "sealed">("all");
  const [copied, setCopied] = useState(false);
  if (error) return <div className="notice err">{error}</div>;
  if (!data) return <p className="empty">Reading the channel from NEAR testnet…</p>;
  const { ch, cfg, signals, subs, readers, cur, member, claim, periods, heldAhead, channels, whole, tags } = data;
  const rec = record(ch, signals);
  const word = periodWord(cfg.period_minutes);
  const Word = word[0].toUpperCase() + word.slice(1);
  const periodMs = cfg.period_minutes * 60_000;
  const sel = plan ?? 0;
  const p = ch.plans[sel];
  const half = p ? BigInt(p.price) / 2n : 0n;
  const active = member && member.until_ms > now;
  const isCreator = account === ch.creator;
  const cls = (b: number | null | undefined) => ((b ?? 0) > 0 ? "gain" : (b ?? 0) < 0 ? "loss" : "");
  const theirs = channels.filter((c) => c.creator === ch.creator);
  const counts = {
    all: signals.length,
    won: signals.filter((s) => (s.r_bps ?? 0) > 0).length,
    lost: signals.filter((s) => (s.r_bps ?? 0) < 0).length,
    sealed: signals.filter((s) => isSealed(s)).length,
  };
  const shown = signals.filter((s) => show === "all" || (show === "won" ? (s.r_bps ?? 0) > 0 : show === "lost" ? (s.r_bps ?? 0) < 0 : isSealed(s)));
  const total = signals.filter((s) => s.r_bps != null).reduce((a, s) => a + (s.r_bps ?? 0), 0);
  const link = `${window.location.href.split("#")[0].split("?")[0]}${channelPath(ch, channels)}`;

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
    <>
      <div className="crumbs">
        <a href="#/">Leaderboard</a> / {theirs.length > 1 && <><a href={`#/@${ch.creator}`}>{ch.creator}</a> / </>}<b>{ch.name}</b>
      </div>
      <div className="ch">
        <div>
          <section className="panel prof">
            <div className="prof-top">
              <Avatar id={ch.creator} />
              <div style={{ minWidth: 0 }}>
                <h1>{ch.name}</h1>
                <div className="meta">
                  <a href={`#/@${ch.creator}`} style={{ textDecoration: "none" }}>{ch.creator}</a><span>·</span><span>since {day(ch.created_at_ms)}</span>
                  <KindTags kinds={kindsShown(tags, signals)} />
                  {whole && rec.scored === 0 && <span className="newch">New channel</span>}
                  {isCreator && <span className="only">Your channel</span>}
                </div>
              </div>
              <div className="act">
                {isCreator ? (
                  <a className="btn" href="#/desk">+ New call</a>
                ) : (
                  <>
                    <button className="btn ghost small" onClick={async () => { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? "Copied" : "Share"}</button>
                    <a className="btn ghost small" href={`${EXPLORER}/address/${ch.creator}`} target="_blank" rel="noreferrer">On explorer ↗</a>
                  </>
                )}
              </div>
            </div>
            {ch.about && <p className="about">{ch.about}</p>}
            {isCreator && <ShareRow ch={ch} path={channelPath(ch, channels)} />}
            {isCreator && (
              <div className="money">
                <div><b>{nearNum(ch.stats.earned).toLocaleString(undefined, { maximumFractionDigits: 3 })}</b><span>NEAR paid to you</span></div>
                <div><b>{nearNum(heldAhead).toLocaleString(undefined, { maximumFractionDigits: 3 })}</b><span>NEAR held for coming {word}s</span></div>
                <div><b className={ch.stats.periods_released ? "gain" : ""}>{ch.stats.periods_released}</b><span>{word}s earned of {ch.stats.periods_released + ch.stats.periods_refunded} settled</span></div>
                <div><b>{subs} / {ch.max_members}</b><span>subscribers</span></div>
              </div>
            )}
            <div className="stats4">
              <div><span>Score</span><b className={cls(rec.score_bps)}>{pct(rec.score_bps)}</b></div>
              <div><span>Calls won</span><b>{rec.winRate == null ? "—" : `${rec.winRate}%`}</b>{rec.filled > 0 && <small>{rec.wins} of {rec.filled} filled</small>}</div>
              <div><span>{Word}s paid</span><b>{rec.periodsSettled ? `${rec.periodsEarned} of ${rec.periodsSettled}` : "—"}</b></div>
              <div><span>Subscribers</span><b>{subs}</b><small>of {ch.max_members}</small></div>
            </div>
            {whole && (
              <div className="whole">
                <b>{isCreator ? "Your" : "This trader's"} full record, across {whole.per.length} channels</b>
                <div className="row">
                  <span><b>{whole.rec.signals}</b> calls</span>
                  <span>score <b className={cls(whole.rec.score_bps)}>{pct(whole.rec.score_bps)}</b></span>
                  <span><b>{whole.rec.periodsSettled ? `${whole.rec.periodsEarned} of ${whole.rec.periodsSettled}` : "—"}</b> {word}s paid</span>
                </div>
                <table className="wk">
                  <thead><tr><th>Channel</th><th className="n">Calls</th><th className="n">Score</th><th className="n">{Word}s paid</th></tr></thead>
                  <tbody>
                    {whole.per.map((x) => (
                      <tr key={x.ch.id}><td><a href={channelPath(x.ch, channels)}>{x.ch.name}</a>{x.ch.id === ch.id ? <span className="ink3">this channel</span> : ""}</td><td className="n">{x.rec.signals}</td><td className={`n ${cls(x.rec.score_bps)}`}>{pct(x.rec.score_bps)}</td><td className="n">{x.rec.periodsSettled ? `${x.rec.periodsEarned} of ${x.rec.periodsSettled}` : "—"}</td></tr>
                    ))}
                  </tbody>
                </table>
                <div className="small ink3" style={{ marginTop: 8 }}>A new channel never hides an old record.</div>
              </div>
            )}
          </section>

          <section className="panel chart">
            <div className="chart-h">
              <h3>Result, call by call</h3><span className="sub0">each call's result added up, after fees</span>
              {rec.scored > 0 && <span className={`last ${cls(total)}`}>{pct(total)}</span>}
            </div>
            <ResultChart signals={signals} />
          </section>

          <section className="panel rec">
            <div className="rec-h">
              <h3>Every call</h3><span className="sub0">permanent · newest first</span>
              <div className="chips" role="group" aria-label="Show">
                {(["all", "won", "lost", "sealed"] as const).map((k) => (
                  <button key={k} aria-pressed={show === k} onClick={() => setShow(k)}>{{ all: "All", won: "Won", lost: "Lost", sealed: "Sealed" }[k]} <span className="ink3">{counts[k]}</span></button>
                ))}
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="empty" style={{ padding: "8px 16px 20px" }}>{signals.length === 0 ? (isCreator ? <>No calls yet. <a href="#/desk">Post the first one</a>.</> : "No calls yet.") : "Nothing here."}</p>
            ) : (
              <div className="scroll">
                <table className="record">
                  <thead><tr><th>Market</th><th>Side</th><th>Entry · TP · SL</th><th>Outcome</th><th className="n">Result</th></tr></thead>
                  <tbody>
                    {shown.map((s) => {
                      const b = s.body;
                      const due = isSealed(s) && now >= opensAt(s);
                      const drandReady = now >= roundTimeMs(s.reveal_round);
                      const outcome = due ? (
                        drandReady ? <Act className="btn small" label="Reveal now" busyLabel="Opening…" run={() => reveal(s)} /> : <span className="out s">opening…</span>
                      ) : (
                        <Outcome s={s} />
                      );
                      return (
                        <tr key={s.id} className={isSealed(s) ? "sealed" : ""}>
                          <td className="mkc">
                            {b ? (
                              <><b className="mk">{b.market.symbol}</b>{b.market.venue === "gecko_micro" && <> <MicroTag /></>}<span className="venue">{venueLabel(b.market)} · {when(s.posted_at_ms)} · valid {dur(s.valid_min)}</span><McapAtCall b={b} fill={s.fill_price} /></>
                            ) : (
                              <><b className="mk" style={{ display: "inline-flex", alignItems: "center" }}>{isSealed(s) ? <><span className="lock" />Sealed call</> : "—"}</b><span className="venue">{when(s.posted_at_ms)} · valid {dur(s.valid_min)}</span></>
                            )}
                          </td>
                          <td className="sidec">{b ? <SideTag b={b} /> : <span className="ink3">—</span>}<span className="out-m">{b && s.r_bps == null && !isSealed(s) ? <LiveOutcome b={b} s={s} /> : outcome}</span></td>
                          <td className="lvlc">
                            {b ? (
                              <div className="lvl"><i>{b.side === "short" ? "Sell" : "Buy"}</i>{price(b.entry_low)}–{price(b.entry_high)} · <i>TP</i>{b.tps.map(price).join(" / ")} · <i>SL</i>{price(b.sl)}</div>
                            ) : isSealed(s) ? (
                              <span className="sub0 small">{due ? "ended, opening" : <>opens in <Countdown to={opensAt(s)} now={now} /> · subscribers can read it now</>}</span>
                            ) : <span className="ink3">—</span>}
                          </td>
                          {b && s.r_bps == null && !isSealed(s) ? (
                            <LiveTds b={b} s={s} />
                          ) : (
                            <>
                              <td className="outc">{outcome}</td>
                              <td className="n resc"><Result s={s} /></td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="fine">Results include fees and leverage. Fills, TPs and SL use candle closes; liquidation uses wicks. “est.” rows are replayed in your browser on the same candles until OutLayer writes the official result.</p>
          </section>
        </div>

        <aside className="aside">
          {isCreator && <OwnerLive signals={signals} readers={readers} account={account!} now={now} />}
          {isCreator && <EditChannel ch={ch} tags={tags} onDone={reload} />}
          {!isCreator && (
            <section className="sheet">
              <h2>{active ? "Your subscription" : "Subscribe"}</h2>
              {active ? (
                <p className="notice ok-n" style={{ margin: "10px 0 0" }}>Active until <b>{when(member!.until_ms)}</b>. Calls appear in your <a href="#/feed">feed</a>. You can extend below.</p>
              ) : (
                <p className="sub" style={{ margin: 0 }}>Every call reaches your feed the moment it's posted.</p>
              )}
              <div className="plans" role="radiogroup" aria-label="Plans">
                {ch.plans.map((pl, i) => (
                  <button key={i} role="radio" aria-pressed={i === sel} aria-checked={i === sel} onClick={() => setPlan(i)}>
                    <span className="radio" />{planName(pl.days)}<span className="r">{nearNum(pl.price).toLocaleString(undefined, { maximumFractionDigits: 2 })} NEAR</span>
                  </button>
                ))}
              </div>
              {account ? (
                <Act className="btn wide" label={`${active ? "Extend" : "Subscribe"} · ${near(p.price)}`} busyLabel="Waiting for the wallet…" run={subscribe} />
              ) : (
                <button className="btn wide" onClick={() => signIn()}>Connect wallet to subscribe</button>
              )}
              <div className="splitbox">
                <div className="split" aria-hidden><i /><i /></div>
                <div className="split-k"><span>{near(half)} to the trader now</span><span>{near(BigInt(p.price) - half)} held</span></div>
                <p>The held half is paid out {word} by {word}, only for {word}s the calls make money. The rest comes back to you. {subs} of {ch.max_members} seats taken · +0.05 NEAR storage, mostly refunded.</p>
              </div>
              {claim && BigInt(claim[0]) > 0n && (
                <div className="pay">
                  <span>You can claim back <b>{near(claim[0])}</b> from {claim[1].length} {word}{claim[1].length > 1 ? "s" : ""} the trader didn't earn.</span>
                  <Act className="btn small" label="Claim" run={async () => { await call("claim_refund", { channel: id }); await reload(); }} />
                </div>
              )}
            </section>
          )}

          <section className="sheet">
            <div className="row-between"><h2>{Word} by {word}</h2><span className="small ink3">the held half</span></div>
            <div style={{ marginTop: 8 }}>
              {periods.map(({ p: n, r, held, signals: k }) => (
                <PeriodRow key={n} p={n} r={r} held={held} n={k} start={ch.created_at_ms + n * periodMs} periodMs={periodMs} cur={cur} next={ch.next_period} />
              ))}
            </div>
            {ch.next_period < cur && (
              <div style={{ marginTop: 12 }}>
                <Act className="btn ghost small" label={`Settle ${day(ch.created_at_ms + ch.next_period * periodMs)}`} busyLabel="Scoring on OutLayer…"
                  run={async () => { await call("settle", { channel: id }, NEAR(0.5), GAS_300); await new Promise((r) => setTimeout(r, 15_000)); await reload(); }} />
                <p className="fine">Anyone can settle an ended {word} once its calls are revealed. Attaches 0.5 NEAR for OutLayer; the unused part comes back.</p>
              </div>
            )}
          </section>

          <section className="panel proof">
            <span>Verified on NEAR</span>
            <a href={`${EXPLORER}/address/${CONTRACT}`} target="_blank" rel="noreferrer">Contract {CONTRACT}<span>↗</span></a>
            <a href={`${EXPLORER}/address/outlayer.testnet`} target="_blank" rel="noreferrer">Scoring jobs on OutLayer<span>↗</span></a>
            <a href="https://github.com/0xTowhid/sealed-calls" target="_blank" rel="noreferrer">Scorer and contract source<span>↗</span></a>
          </section>
        </aside>
      </div>
    </>
  );
}

function LiveTds({ b, s }: { b: SignalBody; s: Signal }) {
  const l = useLive(b, s.posted_at_ms, s.valid_min);
  if (!l) return <><td className="outc"><span className="out s">scoring…</span></td><td className="n resc ink3">…</td></>;
  const r = l.fill == null ? 0 : l.r ?? 0;
  return (
    <>
      <td className="outc"><span className="out n" title="Replayed in your browser on public candles; OutLayer writes the official result.">{l.fill == null ? "not filled" : l.outcome} · est.</span></td>
      <td className={`n resc ${r > 0 ? "gain" : r < 0 ? "loss" : "ink3"}`} title="Unofficial until scored">≈ {r === 0 ? "0%" : pct(Math.round(r * 10000))}</td>
    </>
  );
}

function LiveOutcome({ b, s }: { b: SignalBody; s: Signal }) {
  const l = useLive(b, s.posted_at_ms, s.valid_min);
  return <span className="out n">{l ? `${l.fill == null ? "not filled" : l.outcome} · est.` : "scoring…"}</span>;
}

function PeriodRow({ p, r, held, n, start, periodMs, cur, next }: { p: number; r: PeriodResult | null; held: string; n: number; start: number; periodMs: number; cur: number; next: number }) {
  const label = periodMs >= 7 * 86_400_000 ? `${day(start)}–${day(start + periodMs - 1)}` : periodMs >= 86_400_000 ? day(start) : when(start);
  const settled = r?.status === "Settled";
  const k = settled ? r!.signals : n;
  return (
    <div className="day-row">
      <span>{p === cur ? "Today" : label} · <span className="ink3">{k} call{k === 1 ? "" : "s"} · {near(settled ? r!.held : held)}</span></span>
      <span className={`num ${settled ? (r!.score_bps > 0 ? "gain" : r!.score_bps < 0 ? "loss" : "") : "ink3"}`}>{settled ? pct(r!.score_bps) : "—"}</span>
      {settled ? (r!.released ? <span className="pill win">Paid</span> : <span className="pill lose">Refunded</span>) : <span className="pill">{p === cur ? "Open" : p >= next ? "To settle" : "Settling"}</span>}
    </div>
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

function EditChannel({ ch, tags, onDone }: { ch: Channel; tags: string[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<string[]>(tags);
  const [name, setName] = useState(ch.name);
  const [about, setAbout] = useState(ch.about);
  const [max, setMax] = useState(String(ch.max_members));
  const days = [...new Set([...DURATIONS, ...ch.plans.map((p) => p.days)])].sort((a, b) => a - b).slice(0, 6);
  const [prices, setPrices] = useState<Record<number, string>>(Object.fromEntries(days.map((d) => [d, (() => { const p = ch.plans.find((x) => x.days === d); return p ? String(nearNum(p.price)) : ""; })()])));
  return (
    <section className="sheet">
      <h2>Plans and settings</h2>
      <p className="sub">Visitors see your plans here: {ch.plans.map((p) => `${near(p.price)} / ${planName(p.days)}`).join(", ")}.</p>
      {!open ? (
        <button className="btn ghost wide" onClick={() => { setKinds(tags); setOpen(true); }}>Edit plans, kinds and description</button>
      ) : (
        <div>
          <label htmlFor="en">Channel name</label>
          <input id="en" type="text" maxLength={48} value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor="ea">What you post</label>
          <textarea id="ea" maxLength={400} value={about} onChange={(e) => setAbout(e.target.value)} />
          <KindPicker value={kinds} onChange={setKinds} />
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
                await call("update_channel", { channel: ch.id, name: name.trim(), about: about.trim(), plans, max_members: Math.min(100, Math.max(1, Number(max) || 1)), tags: kinds },
                  // a small storage deposit only when the kinds change; the rest is refunded
                  kinds.join() === tags.join() ? "0" : NEAR(0.01));
                setOpen(false);
                onDone();
              }} />
          </div>
        </div>
      )}
    </section>
  );
}
