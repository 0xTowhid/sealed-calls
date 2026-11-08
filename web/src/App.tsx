import { lazy, Suspense, useEffect, useState } from "react";
import { listChannels, signIn, signOut } from "./near";
import { useAccount, useLoad } from "./data";
import { slug } from "./format";
import { Explore } from "./pages/Explore";
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

export default function App() {
  const route = useRoute();
  const account = useAccount();
  const channels = useLoad(listChannels, [], 60_000, "channels").data;
  const mine = channels?.filter((c) => c.creator === account) ?? [];
  const at = route[0]?.startsWith("@") ? route[0].slice(1) : null;
  const page = at ? (at === account ? "mine" : "c") : route[0] || "explore";
  // /#/@creator/<slug or id>: one channel; /#/@creator: the creator's page (or their only channel)
  const theirs = at ? channels?.filter((c) => c.creator === at) ?? [] : [];
  const pick = at && route[1] ? theirs.find((c) => slug(c.name) === route[1] || String(c.id) === route[1]) : theirs.length === 1 ? theirs[0] : undefined;
  const link = (to: string, href: string, label: string) => (
    <a href={href} className={page === to ? "on" : ""} aria-current={page === to ? "page" : undefined}>{label}</a>
  );

  return (
    <div className="wrap">
      <header className="mast">
        <a className="brand" href="#/">Sealed Calls</a>
        <nav className="nav" aria-label="Main">
          {link("explore", "#/", "Explore")}
          {link("feed", "#/feed", "My feed")}
          {mine.length > 0 && link("mine", `#/@${account}`, mine.length > 1 ? "My channels" : "My channel")}
          {link("desk", "#/desk", "Creator desk")}
          {account ? (
            <>
              <span className="acct">{account}</span>
              <button onClick={() => signOut()}>Sign out</button>
            </>
          ) : (
            <button onClick={() => signIn()}>Connect wallet</button>
          )}
        </nav>
      </header>

      <Suspense fallback={<p className="empty">Loading…</p>}>
      {page === "explore" && <Explore />}
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

      <p className="fine foot">
        Signals can't be edited, deleted or hidden, and become public when they end. Results are indicative: they replay each signal on public
        candles (Hyperliquid, GeckoTerminal) with fees, leverage and, for DEX tokens, the price impact of a $500 trade. Sealed Calls doesn't stop
        creators trading against subscribers; it makes their record public and pays them in full only when signals work. NEAR testnet.{" "}
        <a href="https://github.com/0xTowhid/sealed-calls">Source</a>
      </p>
    </div>
  );
}
