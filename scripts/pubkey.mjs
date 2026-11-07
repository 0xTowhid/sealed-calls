// Prints the NEAR public key (ed25519:...) for a private key passed in $SK. Never prints the private key.
import { createPrivateKey, createPublicKey } from "node:crypto";

const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const d58 = (s) => {
  let n = 0n;
  for (const ch of s) {
    const i = A.indexOf(ch);
    if (i < 0) throw new Error("private key is not base58");
    n = n * 58n + BigInt(i);
  }
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  const z = [...s].findIndex((c) => c !== "1");
  return Buffer.concat([Buffer.alloc(z < 0 ? s.length : z), Buffer.from(h, "hex")]);
};
const e58 = (b) => {
  let n = BigInt("0x" + Buffer.from(b).toString("hex"));
  let s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x === 0) s = "1" + s; else break; }
  return s;
};

const sk = (process.env.SK ?? "").trim();
if (!sk.startsWith("ed25519:")) { console.error("NEAR_PRIVATE_KEY must start with ed25519:"); process.exit(1); }
const raw = d58(sk.slice(8));
if (raw.length !== 64 && raw.length !== 32) { console.error(`NEAR_PRIVATE_KEY decodes to ${raw.length} bytes, expected 64`); process.exit(1); }
const seed = raw.subarray(0, 32);
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const pub = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
if (raw.length === 64 && Buffer.compare(raw.subarray(32), pub) !== 0) { console.error("NEAR_PRIVATE_KEY is corrupted: its two halves don't match"); process.exit(1); }
console.log("ed25519:" + e58(pub));
