import * as pdfjs from 'pdfjs-dist';
import type { Extraction } from '../../types';
import type { PositionedLine, WordBox } from '../../lib/columns';
import { reconstructTable } from '../../lib/columns';
import { isNodeRuntime } from '../../lib/env';

/**
 * pdf.js reader with table reconstruction.
 * - Browser (incl. inside our pipeline worker): pdf.js spawns its own worker
 *   from a bundled asset URL; when `window` is unavailable (worker scope) it
 *   falls back to its in-thread fake worker using the same bundled file.
 * - Node (Vitest): the worker message handler is registered on globalThis, so
 *   pdf.js never needs a Worker implementation or network access.
 */
let workerSetup: Promise<void> | null = null;

/**
 * pdf.js fingerprints documents with `Uint8Array.prototype.toHex()`, which is
 * available in modern browsers but not in every runtime (e.g. Node under Vitest).
 * Polyfill it once, only when missing, so PDF parsing never crashes there.
 */
function ensureUint8ToHex(): void {
  const proto = Uint8Array.prototype as unknown as { toHex?: () => string };
  if (typeof proto.toHex === 'function') return;
  Object.defineProperty(proto, 'toHex', {
    configurable: true,
    writable: true,
    value: function toHex(this: Uint8Array): string {
      let out = '';
      for (let i = 0; i < this.length; i += 1) {
        out += this[i].toString(16).padStart(2, '0');
      }
      return out;
    },
  });
}

function ensurePdfWorker(): Promise<void> {
  if (!workerSetup) {
    workerSetup = (async () => {
      ensureUint8ToHex();
      if (isNodeRuntime()) {
        const specifier = 'pdfjs-dist/build/pdf.worker.min.mjs';
        const mod = (await import(/* @vite-ignore */ specifier)) as {
          WorkerMessageHandler?: unknown;
        };
        if (mod?.WorkerMessageHandler) {
          (globalThis as Record<string, unknown>).pdfjsWorker = mod;
        }
      } else {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).href;
      }
    })();
  }
  return workerSetup;
}

interface PdfTextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

/**
 * Group text items into visual lines and turn each item into positioned words.
 * PDF y grows upward, but the shared table logic sorts lines by ascending y
 * (top first), so we negate y to reconcile the two conventions.
 */
function itemsToLines(items: PdfTextItemLike[]): PositionedLine[] {
  const lines: PositionedLine[] = [];
  for (const item of items) {
    const text = item.str;
    if (!text.trim()) continue;
    const x = item.transform[4];
    const y = -item.transform[5];
    const height = Math.abs(item.height || item.transform[3] || 10) || 10;
    const width = item.width || 0;

    const tokens = text.split(/(\s+)/).filter((token) => token !== '');
    const charWidth = text.length > 0 ? width / text.length : 0;
    let offset = 0;
    const words: WordBox[] = [];
    for (const token of tokens) {
      const tokenWidth = token.length * charWidth;
      if (token.trim() !== '') {
        words.push({
          text: token,
          x0: x + offset,
          x1: x + offset + tokenWidth,
          y0: y - height * 0.2,
          y1: y + height * 0.8,
        });
      }
      offset += tokenWidth;
    }
    if (words.length === 0) continue;

    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - y) <= Math.max(3, height * 0.5)) {
      last.words.push(...words);
    } else {
      lines.push({ y, words });
    }
  }
  return lines;
}

export async function pdfToExtraction(
  bytes: Uint8Array,
  source: string,
  onProgress?: (fraction: number) => void,
): Promise<Extraction> {
  await ensurePdfWorker();

  const data = bytes.slice();
  const task = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });

  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read PDF: ${message}`);
  }

  try {
    const notes: string[] = [];
    const grids: string[][][] = [];
    const textPages: string[] = [];
    let tablePages = 0;

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = (content.items as unknown[]).filter((item: unknown): item is PdfTextItemLike => {
        const candidate = item as PdfTextItemLike;
        return typeof candidate.str === 'string' && Array.isArray(candidate.transform);
      });
      const lines = itemsToLines(items);
      const table = reconstructTable(lines);
      if (table && table.length >= 2) {
        grids.push(table);
        tablePages += 1;
      } else if (lines.length > 0) {
        textPages.push(lines.map((line) => line.words.map((word) => word.text).join(' ')).join('\n'));
      }
      page.cleanup();
      onProgress?.(pageNumber / Math.max(1, doc.numPages));
    }

    if (grids.length > 0) {
      const grid = grids.length === 1 ? grids[0] : grids.flat();
      if (grids.length > 1) notes.push(`${grids.length} pages of tables merged`);
      const failed = doc.numPages - tablePages;
      if (failed > 0) notes.push(`${failed} page(s) without a table layout`);

      const width = Math.max(...grid.map((row) => row.length));
      const rows = grid.map((row) => {
        const out: (string | null)[] = row.slice(0, width);
        while (out.length < width) out.push(null);
        return out;
      });
      const header = rows[0];
      const body = rows.slice(1);
      const headerLooksTextual =
        header.filter((cell) => cell !== null && cell.trim() !== '').length > 0 &&
        header.every((cell) => cell === null || Number.isNaN(Number(cell)));
      const hasHeader = headerLooksTextual && body.length > 0;
      const columns = hasHeader
        ? header.map((cell, index) => (cell === null || cell.trim() === '' ? `col_${index + 1}` : cell.trim()))
        : header.map((_, index) => `col_${index + 1}`);
      if (hasHeader) notes.push('text-layer table detected; first row used as header');
      else notes.push('text-layer table detected; generated column names');

      return {
        kind: 'table',
        source,
        columns,
        rows: hasHeader ? body : rows,
        hasHeader,
        strategy: 'PDF text table',
        notes,
      };
    }

    const text = textPages.join('\n\n').trim();
    if (!text) {
      throw new Error('PDF contains no extractable text (it may be an image-only scan)');
    }
    notes.push('no tabular layout in the text layer – free text parsing');
    return { kind: 'text', source, text, strategy: 'PDF text', notes };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
