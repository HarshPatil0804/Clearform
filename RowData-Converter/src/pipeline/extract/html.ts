import type { Cell, Extraction } from '../../types';
import { cleanText } from '../../lib/strings';
import { generatedNames, looksLikeHeaderRow, padRows } from '../../lib/table';

/**
 * DOM-less HTML reader. Regex based on purpose: this module has to run inside
 * a Web Worker (no DOMParser) and under Node tests, and real-world HTML tables
 * are regular enough for tag matching.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  pound: '£',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const value = NAMED_ENTITIES[entity.toLowerCase()];
    return value !== undefined ? value : match;
  });
}

function cleanCell(fragment: string): string {
  const withoutTags = fragment.replace(/<[^>]*>/g, ' ');
  return cleanText(decodeEntities(withoutTags)).replace(/\s+/g, ' ').trim();
}

/** Every `<table>` in the document, as a grid of trimmed cell strings. */
export function parseHtmlTables(html: string): string[][][] {
  const tables: string[][][] = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const rows: string[][] = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(tableMatch[1])) !== null) {
      const cells: string[] = [];
      const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
        cells.push(cleanCell(cellMatch[2]));
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

/** Visible text of an HTML document: block tags become line breaks. */
export function htmlToText(html: string): string {
  let s = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/?(p|div|br|hr|tr|h[1-6]|li|ul|ol|section|article|header|footer|table|thead|tbody|tfoot)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

export function htmlToExtraction(html: string, source: string): Extraction {
  const notes: string[] = [];
  const tables = parseHtmlTables(html);

  if (tables.length > 0) {
    let best = tables[0];
    for (const table of tables) {
      const score = table.length * (table[0]?.length ?? 0);
      const bestScore = best.length * (best[0]?.length ?? 0);
      if (score > bestScore) best = table;
    }
    if (tables.length > 1) notes.push(`${tables.length} tables found; using the largest`);

    const width = Math.max(...best.map((row) => row.length));
    const padded: Cell[][] = padRows(
      best.map((row) => row.map((cell) => cell as Cell)),
      width,
    );
    const hasHeader = looksLikeHeaderRow(padded[0], padded.slice(1));
    const columns = hasHeader
      ? (padded[0] as string[]).map((cell, index) => (cell === null ? `col_${index + 1}` : String(cell)))
      : generatedNames(width);
    notes.push(hasHeader ? 'header row detected in <table>' : 'no header row – generated column names');

    if (padded.length >= 2) {
      return {
        kind: 'table',
        source,
        columns,
        rows: hasHeader ? padded.slice(1) : padded,
        hasHeader,
        strategy: 'HTML table',
        notes,
      };
    }
  }

  const text = htmlToText(html);
  if (!text.trim()) {
    return { kind: 'text', source, text: '', strategy: 'HTML document', notes: [...notes, 'no visible text in document'] };
  }
  return { kind: 'text', source, text, strategy: 'HTML document', notes };
}
