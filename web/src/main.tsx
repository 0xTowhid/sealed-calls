import { Buffer } from "buffer";
// Wallet libraries (near-api-js actions) and tlock-js expect Node's global Buffer in the browser.
const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;

import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
