#!/usr/bin/env node
/**
 * Builds the Neural Style Studio front end into public/studio/ (generated, git-ignored):
 *   studio/index.html               ← web/studio/index.html (the designer's page, plugged in)
 *   studio/engine.js                ← src/studio/engine.ts            (window.NS)
 *   studio/style-preview-worker.js  ← src/workers/style-preview-worker.ts (module worker)
 *   studio/ort/*.wasm               ← onnxruntime-web runtime binaries
 * Runs automatically before `npm run dev` and `npm run build`.
 */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "studio");
mkdirSync(join(out, "ort"), { recursive: true });

const common = {
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ["es2022"],
  tsconfig: join(root, "tsconfig.json"),
  logLevel: "warning",
  legalComments: "none",
};

await Promise.all([
  build({ ...common, entryPoints: [join(root, "src/studio/engine.ts")], outfile: join(out, "engine.js"), format: "iife" }),
  build({
    ...common,
    entryPoints: [join(root, "src/workers/style-preview-worker.ts")],
    outfile: join(out, "style-preview-worker.js"),
    format: "esm",
  }),
]);

copyFileSync(join(root, "studio", "index.html"), join(out, "index.html"));

const ortDist = join(root, "node_modules", "onnxruntime-web", "dist");
let copied = 0;
for (const f of readdirSync(ortDist)) {
  // runtime binaries + their JS glue (loaded on demand by the bundled runtime)
  if (!/^ort-wasm.*\.(wasm|mjs)$/.test(f)) continue;
  const to = join(out, "ort", f);
  if (existsSync(to) && statSync(to).size === statSync(join(ortDist, f)).size) continue;
  copyFileSync(join(ortDist, f), to);
  copied++;
}
console.log(`[build-studio] engine + worker built, index.html copied, ${copied} ORT runtime file(s) updated`);
