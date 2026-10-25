#!/usr/bin/env node
/**
 * Copies the ONNX style models from the GP1 frontend into web/public/models so
 * they are not duplicated in git (spec D7). Runs automatically before dev/build.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "frontend", "public", "models");
const dest = join(here, "..", "public", "models");

if (!existsSync(src)) {
  console.warn(`[sync-models] source folder not found: ${src} (skipping)`);
  process.exit(0);
}
mkdirSync(dest, { recursive: true });

let copied = 0;
for (const file of readdirSync(src)) {
  if (!file.endsWith(".onnx")) continue;
  const from = join(src, file);
  const to = join(dest, file);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied++;
}
console.log(`[sync-models] ${copied} model(s) copied to public/models`);
