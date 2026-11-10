// Which contract the app shows. Override with ?contract=… in the URL.
const q = new URLSearchParams(window.location.search);

export const NETWORK = "testnet" as const;
export const CONTRACT = q.get("contract") ?? (import.meta.env.VITE_CONTRACT as string | undefined) ?? "app.to69.testnet";

export const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.lava.build"];
export const EXPLORER = "https://testnet.nearblocks.io";
export const GT = "https://api.geckoterminal.com/api/v2";
export const HL = "https://api.hyperliquid.xyz/info";
export const HL_TAKER_FEE = 0.00045;

export const GAS_300 = "300000000000000";
/** Wallets reserve prepaid gas × gas price up front (refunded after), so keep small calls small. */
export const GAS_50 = "50000000000000";
export const GAS_100 = "100000000000000";
/** NEAR amount (decimal) -> yocto string. */
export const NEAR = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();
