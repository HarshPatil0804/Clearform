import fs from 'node:fs';
import path from 'node:path';
import { processBytes } from '../src/pipeline/index';
import type { Dataset, ProgressUpdate } from '../src/types';

// jsdom serves modules over an http:// origin, so import.meta.url is not a
// file:// URL. Resolve the samples directory from this process' cwd instead.
export const SAMPLES_DIR = path.resolve(process.cwd(), 'samples');

const MIME: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  xml: 'application/xml',
  yaml: 'text/yaml',
  html: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  eml: 'message/rfc822',
  rtf: 'application/rtf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
};

export function mimeFor(name: string): string {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return MIME[extension] ?? 'application/octet-stream';
}

export function readSample(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(SAMPLES_DIR, name)));
}

export function sampleExists(name: string): boolean {
  return fs.existsSync(path.join(SAMPLES_DIR, name));
}

export function listSamples(): string[] {
  return fs
    .readdirSync(SAMPLES_DIR)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => fs.statSync(path.join(SAMPLES_DIR, name)).isFile())
    .sort();
}

/** Run the full pipeline over a sample file. */
export async function runSample(name: string): Promise<Dataset[]> {
  return processBytes(name, mimeFor(name), readSample(name));
}

/** Run the full pipeline over an in-memory text fixture. */
export async function runText(name: string, text: string): Promise<Dataset[]> {
  return processBytes(name, mimeFor(name), new TextEncoder().encode(text));
}

/** Collect progress events (also proves the pipeline emits updates). */
export async function runWithProgress(name: string): Promise<{ datasets: Dataset[]; events: ProgressUpdate[] }> {
  const events: ProgressUpdate[] = [];
  const datasets = await processBytes(name, mimeFor(name), readSample(name), {
    onProgress: (update) => events.push(update),
  });
  return { datasets, events };
}
