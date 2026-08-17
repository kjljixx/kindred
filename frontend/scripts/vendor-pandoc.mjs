import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src = resolve(root, "node_modules", "pandoc-wasm", "src", "pandoc.wasm");
const dest = resolve(root, "public", "pandoc.wasm");

if (!existsSync(src)) {
  console.error(
    "pandoc.wasm not found in pandoc-wasm package. Run: npm rebuild pandoc-wasm",
  );
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`Copied pandoc.wasm → ${dest}`);