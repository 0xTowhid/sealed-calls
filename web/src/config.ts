// Which contract and club the app shows. Override with ?contract=…&club=… in the URL.
const q = new URLSearchParams(window.location.search);

export const NETWORK = "testnet" as const;
export const CONTRACT = q.get("contract") ?? (import.meta.env.VITE_CONTRACT as string | undefined) ?? "app.to69.testnet";
export const CLUB = Number(q.get("club") ?? import.meta.env.VITE_CLUB ?? 0);
export const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const EXPLORER = "https://testnet.nearblocks.io";
export const OUTLAYER_EXPLORER = "https://outlayer.fastnear.com";
export const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana";

export const GAS_300 = "300000000000000";
export const GAS_100 = "100000000000000";
export const NEAR = (n: number) => (BigInt(Math.round(n * 1000)) * 10n ** 21n).toString();
