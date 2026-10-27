#!/usr/bin/env node
/**
 * Downloads the Tesseract English language data into public/tessdata/ once, so
 * OCR works offline. Safe to re-run; it skips the file when already present.
 */
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'tessdata');
const outFile = join(outDir, 'eng.traineddata.gz');

if (existsSync(outFile)) {
  console.log('[fetch-ocr-data] eng.traineddata.gz already present.');
  process.exit(0);
}

const sources = [
  'https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz',
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_fast/eng.traineddata.gz',
  'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast/eng.traineddata.gz',
];

mkdirSync(outDir, { recursive: true });

let lastError = null;
for (const url of sources) {
  try {
    console.log(`[fetch-ocr-data] downloading from ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tmp = outFile + '.part';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100_000) throw new Error(`suspiciously small (${buf.length} bytes)`);
    writeFileSync(tmp, buf);
    renameSync(tmp, outFile);
    console.log(`[fetch-ocr-data] saved ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    process.exit(0);
  } catch (err) {
    lastError = err;
    console.warn(`[fetch-ocr-data] failed: ${err.message}`);
    if (existsSync(outFile + '.part')) unlinkSync(outFile + '.part');
  }
}

console.error(`[fetch-ocr-data] could not download language data: ${lastError?.message}`);
console.error('[fetch-ocr-data] run `npm run prepare:assets` when online; OCR needs this file.');
process.exit(1);
