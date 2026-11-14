import { Buffer } from "buffer";
// Wallet libraries (near-api-js actions) and tlock-js expect Node's global Buffer in the browser.
const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;

// Theme before the first paint: the saved choice, else the system setting.
try {
  const t = localStorage.getItem("theme") ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = t;
} catch { document.documentElement.dataset.theme = "light"; }

import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
