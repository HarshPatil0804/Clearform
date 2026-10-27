#!/usr/bin/env node
/**
 * Copies the Tesseract OCR runtime (worker + wasm core) out of node_modules and
 * into public/ so the app can run OCR with zero network requests after load.
 * No-op when tesseract.js is not installed yet (e.g. during first install).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'tess');

const workerSrc = join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
const coreDir = join(root, 'node_modules', 'tesseract.js-core');

if (!existsSync(workerSrc)) {
  console.log('[copy-ocr-assets] tesseract.js not installed yet, skipping.');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(workerSrc, join(outDir, 'worker.min.js'));

// LSTM-only builds match the default OEM used by the app. The wasm binary is
// embedded in the .wasm.js files, so no sibling .wasm files are required.
const wanted = ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'];
let copied = 0;
if (existsSync(coreDir)) {
  for (const name of readdirSync(coreDir)) {
    if (wanted.includes(name)) {
      copyFileSync(join(coreDir, name), join(outDir, name));
      copied += 1;
    }
  }
}
console.log(`[copy-ocr-assets] worker.min.js + ${copied} core file(s) -> public/tess`);
