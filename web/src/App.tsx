import { useEffect, useState } from "react";
import { signIn, signOut } from "./near";
import { useAccount, useClubData } from "./data";
import { ClubPage } from "./pages/ClubPage";
import { ProfilePage } from "./pages/ProfilePage";
import { FeedPage } from "./pages/FeedPage";
import { PostPage } from "./pages/PostPage";

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
  const { data, error, reload } = useClubData();
  const page = route[0] || "club";

  const link = (to: string, label: string) => (
    <a href={`#/${to}`} className={page === to ? "on" : ""} aria-current={page === to ? "page" : undefined}>{label}</a>
  );

  return (
    <div className="wrap">
      <header className="mast">
        <a className="brand" href="#/">Sealed Calls</a>
        {data && <span className="club-name">{data.club.config.name}</span>}
        <nav className="nav" aria-label="Main">
          {link("club", "Club")}
          {link("feed", "Member feed")}
          {link("post", "Post a call")}
          {account ? (
            <>
              <a href={`#/caller/${account}`} className="acct">{account}</a>
              <button onClick={() => signOut()}>Sign out</button>
            </>
          ) : (
            <button onClick={() => signIn()}>Sign in</button>
          )}
        </nav>
      </header>

      {error && <div className="notice err" role="alert">{error}</div>}
      {!data && !error && <p className="sub">Reading the club from NEAR testnet…</p>}

      {data && page === "club" && <ClubPage data={data} account={account} reload={reload} />}
      {data && page === "caller" && <ProfilePage data={data} caller={route[1] ?? ""} account={account} reload={reload} />}
      {data && page === "feed" && <FeedPage data={data} account={account} reload={reload} />}
      {data && page === "post" && <PostPage data={data} account={account} reload={reload} />}

      <p className="fine" style={{ marginTop: 40 }}>
        Calls can't be edited, deleted or hidden, and become public when they end. Scores are indicative returns for a
        $500 trade. Sealed Calls doesn't stop callers trading against you; it makes their record public and pays them
        only when calls work. NEAR testnet. <a href="https://github.com/0xTowhid/sealed-calls">Source</a>
      </p>
    </div>
  );
}
