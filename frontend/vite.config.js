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
      name: "markdown-wasm-url",
      transform(source, id) {
        if (!id.replaceAll("\\", "/").endsWith("/markdown-wasm/dist/markdown.es.js")) return;
        // The package's ESM loader assumes /markdown.wasm; use Vite's asset URL instead.
        const filename = 'W="markdown.wasm"';
        if (!source.includes(filename)) throw new Error("markdown-wasm loader changed");
        return 'import wasmUrl from "markdown-wasm/dist/markdown.wasm?url";\n'
          + source.replace(filename, "W=wasmUrl");
      },
    },
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
    exclude: ["pandoc-wasm", "docshift", "markdown-wasm"],
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8765",
    },
  },
});
