import { useEffect, useState } from "react";
import { signIn, signOut } from "./near";
import { useAccount } from "./data";
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
  const page = route[0] || "explore";
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
      {page === "c" && <ChannelPage id={Number(route[1] ?? 0)} account={account} />}
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
