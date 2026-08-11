import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "/static/",
  publicDir: "public",
  build: {
    outDir: resolve(__dirname, "../src/kindred/static/dist"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  resolve: {
    alias: {
      "pandoc-wasm/src/core.js": resolve(
        __dirname,
        "node_modules/pandoc-wasm/src/core.js",
      ),
    },
  },
  optimizeDeps: {
    exclude: ["pandoc-wasm"],
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8765",
    },
  },
});
