// Drives the live site as the demo subscriber for scripts/demo.sh (runs under Xvfb; ffmpeg records the screen).
// Prints "mark <name> <ms>" lines so the edit can find each scene.
const fs = require("fs");
const { chromium } = require("playwright");
const [keyFile, ch] = process.argv.slice(2);
const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
const SITE = "https://sealed-calls.vercel.app/?viewas=m1.to69.testnet";
const mark = (n) => console.log(`mark ${n} ${Date.now()}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--kiosk", "--window-position=0,0", "--window-size=1920,1080", "--hide-scrollbars", "--no-first-run", "--disable-infobars"],
  });
  const ctx = await b.newContext({ viewport: null });
  await ctx.addInitScript(([k, c]) => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem(`sc2:key:app.to69.testnet:${c}:m1.to69.testnet`, JSON.stringify(k));
  }, [key, ch]);
  const p = await ctx.newPage();
  const glide = async (dy, steps = 40) => { for (let i = 0; i < steps; i++) { await p.mouse.wheel(0, dy / steps); await wait(25); } };

  // 1. the channel as the public sees it: the call is sealed
  await p.goto(`${SITE}#/@to69.testnet/${ch}`);
  await p.getByText("Every call").first().waitFor({ timeout: 60000 }).catch(() => {});
  await wait(2500);
  mark("channel");
  await wait(3000);
  await p.getByText("Every call").first().scrollIntoViewIfNeeded().catch(() => {});
  await glide(-250, 10);
  mark("channel_sealed_row");
  await wait(5000);

  // 2. the subscriber's feed: the same call, opened with the subscriber's own key
  await p.goto(`${SITE}#/feed`);
  mark("feed_load");
  await p.getByText("Same signal that's locked on-chain").first().waitFor({ timeout: 90000 }).catch(() => mark("feed_no_verify"));
  await wait(1500);
  mark("feed_opened");
  await wait(7000);
  await glide(300);
  await wait(4000);
  await glide(-300);
  await wait(2000);
  mark("end");
  await b.close();
})();
