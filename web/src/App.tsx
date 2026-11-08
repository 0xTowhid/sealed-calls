import { useEffect, useState } from "react";
import { listChannels, signIn, signOut } from "./near";
import { useAccount, useLoad } from "./data";
import { Explore } from "./pages/Explore";
import { ChannelPage } from "./pages/Channel";
import { Feed } from "./pages/Feed";
import { Desk } from "./pages/Desk";

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
  const channels = useLoad(listChannels, [], 60_000).data;
  const mine = channels?.find((c) => c.creator === account) ?? null;
  const at = route[0]?.startsWith("@") ? route[0].slice(1) : null;
  const page = at ? (at === account ? "mine" : "c") : route[0] === "mine" ? "mine" : route[0] || "explore";
  const atId = at ? channels?.find((c) => c.creator === at)?.id : undefined;
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
          {mine && link("mine", `#/@${mine.creator}`, "My channel")}
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

      {page === "explore" && <Explore />}
      {page === "c" && !at && <ChannelPage id={Number(route[1] ?? 0)} account={account} />}
      {(at || page === "mine") && (() => {
        const id = at ? atId : mine?.id;
        if (!channels) return <p className="empty">Reading channels…</p>;
        if (id == null) return <div className="notice">{at ? `${at} doesn't have a channel yet.` : <>You don't have a channel yet. <a href="#/desk">Start one</a>.</>}</div>;
        return <ChannelPage id={id} account={account} />;
      })()}
      {page === "feed" && <Feed account={account} />}
      {page === "desk" && <Desk account={account} />}

      <p className="fine foot">
        Signals can't be edited, deleted or hidden, and become public when they end. Results are indicative: they replay each signal on public
        candles (Hyperliquid, GeckoTerminal) with fees, leverage and, for DEX tokens, the price impact of a $500 trade. Sealed Calls doesn't stop
        creators trading against subscribers; it makes their record public and pays them in full only when signals work. NEAR testnet.{" "}
        <a href="https://github.com/0xTowhid/sealed-calls">Source</a>
      </p>
    </div>
  );
}
