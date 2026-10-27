// @vitest-environment node
// OCR needs a real Node environment: under jsdom, tesseract.js's path resolver
// treats the filesystem path as a URL and percent-encodes spaces in it, so the
// worker thread fails to load and the recognize() promise never settles.
import { describe, expect, it } from 'vitest';
import { runSample } from './helpers';

describe('scanned image (OCR)', () => {
  it('runs OCR and reconstructs a table', async () => {
    const start = Date.now();
    const [ds] = await runSample('scanned_table.png');
    const ms = Date.now() - start;
    console.log(`OCR ${ms}ms cols=${JSON.stringify(ds.columns)} rows=${ds.rows.length}`);

    expect(ds.rows.length).toBeGreaterThan(0);
    expect(ds.columns.length).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
