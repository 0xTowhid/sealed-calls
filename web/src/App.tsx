import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { balanceOf, call, listChannels, owedTo, pendingConfig, signIn, signOut } from "./near";
import { useAccount, useLoad } from "./data";
import { nearNum, slug } from "./format";
import { Avatar, Info } from "./ui";
import { CONTRACT, CONTRACT_OVERRIDDEN, EXPLORER } from "./config";
import { Explore } from "./pages/Explore";
// The landing page is the site's front door (no hash); every app page lives under "#/".
const Landing = lazy(() => import("./pages/Landing").then((m) => ({ default: m.Landing })));
// Pages that need the crypto libraries (drand timelock, libsodium) load on demand.
const ChannelPage = lazy(() => import("./pages/Channel").then((m) => ({ default: m.ChannelPage })));
const Feed = lazy(() => import("./pages/Feed").then((m) => ({ default: m.Feed })));
const CreatorPage = lazy(() => import("./pages/Creator").then((m) => ({ default: m.CreatorPage })));
const Desk = lazy(() => import("./pages/Desk").then((m) => ({ default: m.Desk })));

function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => { setHash(window.location.hash); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
}

function Wallet({ account, hasChannel }: { account: string | null; hasChannel: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const bal = useLoad(() => (account ? balanceOf(account) : Promise.resolve(null)), [account], 30_000, `bal:${account}`).data;
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  if (!account) return <button className="chip connect" onClick={() => signIn()}>Connect wallet</button>;
  return (
    <div className="wallet" ref={ref}>
      <button className="chip" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Avatar id={account} />{account}
        {bal != null && <span className="bal">{nearNum(bal).toLocaleString(undefined, { maximumFractionDigits: 2 })} NEAR</span>}
      </button>
      {open && (
        <div className="menu">
          <div className="who"><b>{account}</b>NEAR testnet</div>
          {hasChannel && <a href={`#/@${account}`} onClick={() => setOpen(false)}>My channels</a>}
          <a href="#/feed" onClick={() => setOpen(false)}>My feed</a>
          <a href={`${EXPLORER}/address/${account}`} target="_blank" rel="noreferrer">View on explorer ↗</a>
          <button onClick={() => signOut()}>Disconnect</button>
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [t, setT] = useState(() => document.documentElement.dataset.theme ?? "light");
  const flip = () => {
    const n = t === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = n;
    try { localStorage.setItem("theme", n); } catch { /* private mode */ }
    setT(n);
  };
  return (
    <button className="theme" onClick={flip} aria-label={t === "dark" ? "Switch to light theme" : "Switch to dark theme"} title={t === "dark" ? "Light theme" : "Dark theme"}>
      {t === "dark" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" /></svg>
      )}
    </button>
  );
}

export default function App() {
  const route = useRoute();
  const front = window.location.hash === "" || window.location.hash === "#";
  const account = useAccount();
  const channels = useLoad(listChannels, [], 60_000, "channels").data;
  const mine = channels?.filter((c) => c.creator === account) ?? [];
  const at = route[0]?.startsWith("@") ? route[0].slice(1) : null;
  const page = at ? (at === account ? "mine" : "c") : route[0] || "explore";
  // /#/@creator/<slug or id>: one channel; /#/@creator: the creator's page (or their only channel)
  const theirs = at ? channels?.filter((c) => c.creator === at) ?? [] : [];
  const pick = at && route[1] ? theirs.find((c) => slug(c.name) === route[1] || String(c.id) === route[1]) : theirs.length === 1 ? theirs[0] : undefined;
  const links: [string, string, string][] = [
    ["explore", "#/", "Explore"],
    ["feed", "#/feed", "Feed"],
    ...(mine.length ? [["mine", `#/@${account}`, mine.length > 1 ? "My channels" : "My channel"] as [string, string, string]] : []),
    ["desk", "#/desk", "Creator desk"],
  ];
  const nav = (cls: string) => (
    <nav className={cls} aria-label="Main">
      {links.map(([to, href, label]) => (
        <a key={to} href={href} className={page === to || (to === "explore" && page === "c") ? "on" : ""} aria-current={page === to ? "page" : undefined}>{label}</a>
      ))}
    </nav>
  );

  if (front) return <Suspense fallback={null}><Landing /></Suspense>;
  return (
    <>
      <header className="bar">
        <div className="bar-in">
          <a className="logo" href={window.location.pathname} title="Sealed Calls home"><i /><span>Sealed Calls</span></a>
          {nav("tabs")}
          <div className="bar-r">
            <a className="chip net" href={`${EXPLORER}/address/${CONTRACT}`} target="_blank" rel="noreferrer" title={`Contract ${CONTRACT}`}><span className="dot" />NEAR Testnet</a>
            <ThemeToggle />
            <Wallet account={account} hasChannel={mine.length > 0} />
          </div>
        </div>
      </header>
      {nav("mtabs")}

      <main className="wrap">
        {CONTRACT_OVERRIDDEN && (
          <div className="notice err" role="alert">
            This page is showing contract <b>{CONTRACT}</b>, set by the link you opened, not the official Sealed Calls contract. Don't subscribe or pay here unless you trust it. <a href={window.location.pathname}>Open the official one</a>.
          </div>
        )}
        <Owed account={account} />
        <PendingConfig />
        <Suspense fallback={<p className="empty">Loading…</p>}>
          {page === "explore" && <Explore account={account} />}
          {page === "c" && !at && <ChannelPage id={Number(route[1] ?? 0)} account={account} />}
          {at && (() => {
            if (!channels) return <p className="empty">Reading channels…</p>;
            if (!theirs.length) return <div className="notice">{at === account ? <>You don't have a channel yet. <a href="#/desk">Start one</a>.</> : `${at} doesn't have a channel yet.`}</div>;
            if (pick) return <ChannelPage id={pick.id} account={account} />;
            return <CreatorPage creator={at} account={account} />;
          })()}
          {page === "feed" && <Feed account={account} />}
          {page === "desk" && <Desk account={account} newChannel={route[1] === "new"} />}
        </Suspense>

        <footer className="foot">
          <p>
            Results are indicative returns for a $500 trade.
            <Info tip="Calls can't be edited, deleted or hidden, and become public when they end. Results are replayed on public candles (Hyperliquid, GeckoTerminal) with fees and leverage. Sealed Calls doesn't stop traders trading against subscribers; it makes their record public and pays them in full only when calls work." />
          </p>
          <p>
            <a href={`${EXPLORER}/address/${CONTRACT}`} target="_blank" rel="noreferrer">{CONTRACT}</a> · NEAR testnet ·{" "}
            <a href="https://github.com/0xTowhid/sealed-calls" target="_blank" rel="noreferrer">Source</a>
          </p>
        </footer>
      </main>
    </>
  );
}

/** NEAR whose payout transfer failed and is kept for the account (withdraw_owed). */
function Owed({ account }: { account: string | null }) {
  const { data: owed, reload } = useLoad(async () => (account ? owedTo(account) : "0"), [account]);
  if (!account || !owed || owed === "0") return null;
  return (
    <div className="notice ok-n">
      {nearNum(owed).toLocaleString(undefined, { maximumFractionDigits: 4 })} NEAR is owed to you (a payout transfer didn't go through).{" "}
      <button className="btn small" onClick={async () => { await call("withdraw_owed", {}); await reload(); }}>Withdraw</button>
    </div>
  );
}

/** Config changes are delayed a day so everyone sees them coming. */
function PendingConfig() {
  const { data: p } = useLoad(pendingConfig, []);
  if (!p) return null;
  return (
    <div className="notice">
      A rules change is scheduled on the contract for {new Date(p.eta_ms).toUTCString()} (scorer {p.config.scorer_wasm_hash.slice(0, 10)}…, grace {Math.round(p.config.grace_min / 60)} h, at least {p.config.min_signals} filled call{p.config.min_signals === 1 ? "" : "s"} per paid {p.config.period_minutes >= 10080 ? "week" : "day"}).
    </div>
  );
}
