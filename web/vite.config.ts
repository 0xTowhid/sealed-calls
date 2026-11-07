import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the build works under GitHub Pages' /sealed-calls/ path; routes use the URL hash.
export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { global: "globalThis" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
