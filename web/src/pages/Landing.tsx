import { useEffect, useRef, useState } from "react";
import { useLoad } from "../data";
import { nearNum, outcomeText, pct, price, day } from "../format";
import { loadAll } from "./Explore";
import type { Signal } from "../types";
import "../landing.css";

const REPO = "https://github.com/0xTowhid/sealed-calls";
const X = "https://x.com/0xTowhid";
const APP = "#/";

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const clamp = (x: number) => Math.max(0, Math.min(1, x));

/** Adds `in` to the element the first time it scrolls into view. */
function useInView<T extends HTMLElement>(threshold = 0.25) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (reduced() || !("IntersectionObserver" in window)) return setSeen(true);
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, threshold]);
  return [ref, seen] as const;
}

/** Counts up to `to` once `go` turns true. */
function useCount(to: number, go: boolean, ms = 1200) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!go) return;
    if (reduced()) return setV(to);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = clamp((t - t0) / ms);
      setV(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, go, ms]);
  return v;
}

function scrollTo(id: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault(); // hash links would change the app's route
    document.getElementById(id)?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth" });
  };
}

const label = (s: Signal) => (s.body ? `${s.body.side.toUpperCase()} ${s.body.market.symbol}${s.body.leverage > 1 ? ` ${s.body.leverage}x` : ""}` : "Unrevealed call");
const venueName = (s: Signal) =>
  !s.body ? "" : s.body.market.venue === "hyperliquid" ? "Hyperliquid" : `${(s.body.market.network ?? "").replace(/^\w/, (c) => c.toUpperCase())} DEX`;
const stampText = (s: Signal) => {
  const o = (s.outcome ?? "").split(" ")[0];
  if (o === "not_filled") return "not filled";
  if (o === "liquidated") return "liquidated";
  return pct(s.r_bps);
};
const stampKind = (s: Signal) => ((s.r_bps ?? 0) > 0 ? "w" : (s.r_bps ?? 0) < 0 ? "l" : "z");

// ------------------------------------------------------------------ the envelope (hero)

function Envelope({ ex, p, to }: { ex: Signal | undefined; p: number; to: string }) {
  const f = clamp(p / 0.25); // flap
  const c = clamp((p - 0.25) / 0.35); // call slides out
  const s = clamp((p - 0.66) / 0.12); // result stamp
  const commit = ex ? `${ex.commit.slice(0, 4)}…${ex.commit.slice(-4)}`.toUpperCase() : "9F3C…A71E";
  const posted = ex ? new Date(ex.posted_at_ms) : new Date();
  const hh = `${String(posted.getUTCHours()).padStart(2, "0")}:${String(posted.getUTCMinutes()).padStart(2, "0")} UTC`;
  const b = ex?.body;
  return (
    <div className="env" style={{ ["--f" as string]: f, ["--c" as string]: c, ["--s" as string]: s }}>
      <div className="back" />
      <div className={`flap ${f > 0.5 ? "open" : ""}`} />
      <div className="callc">
        <h3><span className={b?.side === "short" ? "short" : ""}>{b ? b.side.toUpperCase() : "LONG"}</span> {b ? `${b.market.symbol}${b.leverage > 1 ? ` ${b.leverage}x` : ""}` : "BTC 5x"}</h3>
        {b && (
          <div className="g mono">
            <span>entry {price(b.entry_low)}–{price(b.entry_high)}</span>
            {b.tps[0] && <span>TP {price(b.tps[0])}</span>}
            <span>SL {price(b.sl)}</span>
          </div>
        )}
        {ex && <small>{outcomeText(ex.outcome)} · scored on NEAR</small>}
      </div>
      <div className="front" />
      <div className="addr"><small>to: subscribers of</small><b>{to}</b></div>
      <div className="pstamp"><span>SEALED<br />CALL<br />№ {ex ? String(ex.id).padStart(4, "0") : "0412"}</span></div>
      <svg className="postmark" viewBox="0 0 128 128" aria-hidden="true">
        <defs><path id="pm" d="M64,64 m-48,0 a48,48 0 1,1 96,0 a48,48 0 1,1 -96,0" /></defs>
        <circle cx="64" cy="64" r="58" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="64" cy="64" r="36" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <text fontFamily="Geist Mono, monospace" fontSize="10.5" fill="currentColor"><textPath href="#pm">NEAR TESTNET · SHA256 {commit} ·</textPath></text>
        <text x="64" y="60" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="11" fontWeight="600" fill="currentColor">{day(posted.getTime()).toUpperCase()}</text>
        <text x="64" y="75" textAnchor="middle" fontFamily="Geist Mono, monospace" fontSize="10" fill="currentColor">{hh}</text>
      </svg>
      <div className="wax" aria-hidden="true"><i>NEAR</i></div>
      {ex && <div className={`big-stamp mono ${stampKind(ex)}`}>{stampText(ex)}</div>}
    </div>
  );
}

function Hero({ ex, to }: { ex: Signal | undefined; to: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(() => (reduced() ? 1 : 0));
  useEffect(() => {
    if (reduced()) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = stage.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const span = r.height - window.innerHeight;
        setP(clamp(-r.top / Math.max(1, span)));
      });
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on); window.removeEventListener("resize", on); cancelAnimationFrame(raf); };
  }, []);
  return (
    <header className="hero">
      <div className="lwrap">
        <div className="kicker mono">trading calls, sealed on NEAR</div>
        <h1>Sealed before<br />the move. <span className="o">Opened</span><br />after.</h1>
      </div>
      <div className="stage" ref={stage}>
        <div className="pin">
          <Envelope ex={ex} p={p} to={to} />
          <div className={`lhint mono ${p > 0.05 ? "gone" : ""}`}>scroll to open</div>
        </div>
      </div>
      <div className="lwrap">
        <p className="llede">Traders sell access to their calls. Each one is sealed on NEAR when it's posted, opened for everyone when it ends, and scored on real market data. Traders get paid only when they win.</p>
        <div className="cta"><a className="lbtn ink" href={APP}>Open the app</a><a className="lbtn ghost" href="#how" onClick={scrollTo("how")}>See how it works</a></div>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ sections

function Record({ sigs }: { sigs: Signal[] }) {
  const [ref, seen] = useInView<HTMLDivElement>(0.2);
  return (
    <section id="record" className="lsec">
      <div className="lwrap split2">
        <div>
          <h2>Every letter gets opened. Even the bad ones.</h2>
          <p className="p">Paid signal groups delete their losers and screenshot their winners. Here nothing can be deleted: each call opens on schedule and its result is stamped on the trader's public record.</p>
          <a className="lbtn ghost sm" href={APP}>See the full record</a>
        </div>
        <div className={`stack ${seen ? "in" : ""}`} ref={ref}>
          {sigs.length === 0 && <p className="p">The first calls are still sealed. Check back when they open.</p>}
          {sigs.map((s, i) => (
            <a className="letter" key={s.id} href={APP} style={{ ["--i" as string]: i }}>
              <span className="torn" />
              <div>
                <div className="what">{label(s)}</div>
                <div className="when mono">opened {day(s.posted_at_ms + s.valid_min * 60_000)} · {venueName(s)}</div>
              </div>
              <span className={`lres mono ${stampKind(s)}`}>{stampText(s)}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function Countdown({ go }: { go: boolean }) {
  const [n, setN] = useState(3);
  useEffect(() => {
    if (!go) return;
    if (reduced()) return setN(0);
    const t = setInterval(() => setN((x) => (x > 0 ? x - 1 : 0)), 700);
    return () => clearInterval(t);
  }, [go]);
  return <span className="clock mono">00:00:0{n}</span>;
}

function How() {
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  return (
    <section id="how" className="lsec dark">
      <div className="lwrap">
        <h2>One call, start to finish</h2>
        <p className="p">Nobody can change a call once it's sealed. Not the trader, not us.</p>
        <div className={`life ${seen ? "in" : ""}`} ref={ref}>
          <div className="ls"><div className="ill"><div className="me"><span className="w" /></div></div><h4>Seal</h4><p>The trader writes the call. It's encrypted in their browser; only its fingerprint goes on NEAR.</p><span className="t mono">sha256 → NEAR</span></div>
          <div className="ls"><div className="ill"><div className="me"><span className="w" /></div><div className="keys"><i /><i /><i /><i /></div></div><h4>Deliver</h4><p>Every subscriber gets their own key and reads the call right away.</p><span className="t mono">one key per subscriber</span></div>
          <div className="ls"><div className="ill"><div className="me open"><div className="lcard">LONG BTC 5x</div></div><Countdown go={seen} /></div><h4>Open</h4><p>When the call ends, a time-lock opens it for everyone. It can't stay hidden.</p><span className="t mono">drand time-lock</span></div>
          <div className="ls"><div className="ill"><div className="me open"><div className="lcard">LONG BTC 5x</div></div><span className="bigst mono">+7.4%</span></div><h4>Stamp</h4><p>A scoring job replays it on real candles and writes the result to NEAR.</p><span className="t mono">OutLayer, on-chain</span></div>
        </div>
        <div className="lmoney">
          <div><b className="mono">50%</b><span>of every subscription goes to the trader right away.</span></div>
          <div><b className="mono">50%</b><span>stays in the vault, day by day. Winning days release it to the trader; losing days return it to subscribers.</span></div>
        </div>
      </div>
    </section>
  );
}

function Stat({ to, go, digits = 0, label }: { to: number; go: boolean; digits?: number; label: string }) {
  const v = useCount(to, go);
  return <div><b className="mono">{v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}</b><span>{label}</span></div>;
}

function Ledger({ k }: { k: { calls: number; traders: number; subs: number; paid: number; back: number } | null }) {
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  const go = seen && !!k;
  return (
    <section id="progress" className="lsec">
      <div className="lwrap">
        <h2>Postmarked so far</h2>
        <p className="p">Built during NEAR Hackathon 2026 and running on testnet with real calls. Numbers are live from the contract.</p>
        <div className="ledger" ref={ref}>
          <div className="row">
            <Stat to={k?.calls ?? 0} go={go} label="calls sealed" />
            <Stat to={k?.traders ?? 0} go={go} label="traders" />
            <Stat to={k?.subs ?? 0} go={go} label="active subscribers" />
            <Stat to={k?.paid ?? 0} go={go} digits={2} label="NEAR paid to traders" />
            <Stat to={k?.back ?? 0} go={go} digits={2} label="NEAR returned to subscribers" />
          </div>
          <ul>
            <li><div>Contract live on testnet<em>58 tests, open source</em></div></li>
            <li><div>On-chain scoring<em>Hyperliquid perps and DEX tokens</em></div></li>
            <li><div>Security audit<em>21 findings, all addressed</em></div></li>
            <li><div>Late subscribers<em>get live calls automatically</em></div></li>
            <li><div>Micro-cap mode<em>stricter rules for small pools</em></div></li>
            <li><div>Full loop on testnet<em>seal → deliver → open → stamp → pay</em></div></li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function Next() {
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  return (
    <section id="next" className="lsec tight">
      <div className="lwrap">
        <h2>Still in the mail</h2>
        <div className={`next ${seen ? "in" : ""}`} ref={ref}>
          <div className="nx now"><div className="when mono">NOW</div><b>Mainnet</b><p>A locked contract and real subscriptions.</p></div>
          <div className="nx"><div className="when mono">NEXT</div><b>Proof of real trades</b><p>Match calls to the trader's private NEAR Intents trades, so results come from real fills.</p></div>
          <div className="nx"><div className="when mono">LATER</div><b>Rules by vote</b><p>Scoring and payouts governed by a DAO.</p></div>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ page

export function Landing() {
  const { data } = useLoad(loadAll, [], 60_000, "explore");
  const rows = data?.rows ?? [];
  const sigs = rows.flatMap((r) => r.signals);
  const opened = sigs.filter((s) => s.body && s.r_bps != null).sort((a, b) => b.posted_at_ms + b.valid_min * 60_000 - (a.posted_at_ms + a.valid_min * 60_000));
  const ex = opened.find((s) => (s.r_bps ?? 0) > 0) ?? opened[0];
  const k = data
    ? {
        calls: rows.reduce((a, r) => a + r.ch.signal_count, 0),
        traders: new Set(rows.map((r) => r.ch.creator)).size,
        subs: rows.reduce((a, r) => a + r.active, 0),
        paid: rows.reduce((a, r) => a + nearNum(r.ch.stats.earned), 0),
        back: rows.reduce((a, r) => a + nearNum(r.ch.stats.refundable), 0),
      }
    : null;
  useEffect(() => { document.title = "Sealed Calls: trading calls sealed on NEAR"; }, []);
  return (
    <div className="lp">
      <nav className="lnav">
        <div className="lwrap">
          <a className="llogo" href="#" onClick={scrollTo("top")}><span className="seal-s" />Sealed Calls</a>
          <div className="r">
            <a href="#record" onClick={scrollTo("record")}>The record</a>
            <a href="#how" onClick={scrollTo("how")}>How it works</a>
            <a href="#progress" onClick={scrollTo("progress")}>Progress</a>
            <a href="#next" onClick={scrollTo("next")}>Next</a>
            <a className="lbtn ink" href={APP}>Open app</a>
          </div>
        </div>
      </nav>
      <div id="top" />
      <Hero ex={ex} to={rows.find((r) => r.ch.id === ex?.channel)?.ch.name ?? "your favourite trader"} />
      <Record sigs={opened.slice(0, 5)} />
      <How />
      <Ledger k={k} />
      <Next />
      <div className="final">
        <div className="lwrap">
          <h2>Read the whole record before you pay.</h2>
          <div className="cta"><a className="lbtn ink" href={APP}>Open the app</a><a className="lbtn ghost" href={REPO} target="_blank" rel="noreferrer">Read the code</a></div>
        </div>
      </div>
      <footer className="lfoot"><div className="lwrap"><span>Sealed Calls · NEAR Hackathon 2026</span><a href={REPO} target="_blank" rel="noreferrer">GitHub</a><a href={X} target="_blank" rel="noreferrer">X</a></div></footer>
    </div>
  );
}
