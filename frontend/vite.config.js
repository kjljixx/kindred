import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "/static/",
  publicDir: "public",
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.js"],
  },
  plugins: [
    {
      name: "stylesheet-before-entry-module",
      transformIndexHtml: {
        order: "post",
        handler(html) {
          const stylesheetFirst = html.replace(
            /\s*(<script type="module" crossorigin src="[^"]+"><\/script>)\s*(<link rel="stylesheet" crossorigin href="[^"]+">)/,
            "\n  $2\n  $1",
          );
          return stylesheetFirst.replace(
            /(<link rel="stylesheet" crossorigin href="([^"]+\.css)">)/,
            '<link rel="preload" href="$2" as="style" fetchpriority="high">\n  $1',
          );
        },
      },
    },
  ],
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
    exclude: ["pandoc-wasm", "docshift"],
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8765",
    },
  },
});
