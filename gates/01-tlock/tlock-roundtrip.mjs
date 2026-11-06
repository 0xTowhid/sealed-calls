// Gate (a): can we seal a call to a future drand round and open it once the round passes?
// Run: npm install && node tlock-roundtrip.mjs
// PASS = all three checks print OK.
import { timelockEncrypt, timelockDecrypt, roundAt, mainnetClient, Buffer } from "tlock-js";
import { createHash, randomBytes } from "node:crypto";

const client = mainnetClient();
const info = await client.chain().info();
console.log(`drand chain: period=${info.period}s scheme=${info.schemeID} genesis=${info.genesis_time}`);
if (info.period !== 3) console.log("NOTE: expected quicknet (3 s rounds); embargo math in the contract assumes the period printed above.");

// The same shape a real call will have: payload + salt, committed by hash.
const payload = JSON.stringify({ asset: "hl:ETH", side: "long", horizon_min: 240, note: "gate test" });
const salt = randomBytes(16).toString("hex");
const plaintext = Buffer.from(`${payload}|${salt}`);
const commit = createHash("sha256").update(plaintext).digest("hex");

// Check 1: a round already in the past decrypts.
const pastRound = roundAt(Date.now() - 10_000, info);
const ctPast = await timelockEncrypt(pastRound, plaintext, client);
const opened = await timelockDecrypt(ctPast, client);
const ok1 = createHash("sha256").update(opened).digest("hex") === commit;
console.log(`1. past round ${pastRound}: decrypted and matches commitment -> ${ok1 ? "OK" : "FAIL"}`);

// Check 2: a round 60 s ahead must NOT decrypt yet.
const futureRound = roundAt(Date.now() + 60_000, info);
const ctFuture = await timelockEncrypt(futureRound, plaintext, client);
let ok2 = false;
try { await timelockDecrypt(ctFuture, client); } catch (e) { ok2 = true; console.log(`   (refused as expected: ${String(e.message).slice(0, 80)})`); }
console.log(`2. future round ${futureRound}: refuses to decrypt early -> ${ok2 ? "OK" : "FAIL"}`);

// Check 3: wait for that round, then it opens. Prints the ciphertext size we will store on chain.
console.log(`   ciphertext size: ${ctFuture.length} bytes (stored on chain per call)`);
const waitMs = Math.max(0, (info.genesis_time + futureRound * info.period) * 1000 - Date.now()) + 4000;
console.log(`   waiting ${Math.round(waitMs / 1000)} s for round ${futureRound}...`);
await new Promise((r) => setTimeout(r, waitMs));
const later = await timelockDecrypt(ctFuture, client);
const ok3 = createHash("sha256").update(later).digest("hex") === commit;
console.log(`3. same round after it passed: opens and matches -> ${ok3 ? "OK" : "FAIL"}`);

console.log(ok1 && ok2 && ok3 ? "\nGATE (a) PASS" : "\nGATE (a) FAIL — see the line marked FAIL");
