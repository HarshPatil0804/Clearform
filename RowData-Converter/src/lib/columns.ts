/**
 * Shared table-reconstruction helpers: turn a set of positioned text lines
 * (OCR words or PDF text items) into a grid by finding recurring column edges.
 */

export interface WordBox {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface PositionedLine {
  y: number;
  words: WordBox[];
}

const EDGE_BIN = 6;
const MIN_SHARED_LINES = 2;

/**
 * Find x positions where a column boundary recurs across several lines.
 * Returns sorted edge positions (in the same coordinate space as the words).
 *
 * Strategy: cluster the left edges (x0) of words. Cells in the same column
 * share a near-identical left edge across rows, so a left edge that recurs on
 * many lines marks the start of a column. This is far more robust than
 * averaging inter-word gaps, which breaks when one cell contains a space
 * (e.g. a "UNIT PRICE" header) or when column gaps vary in size. A left edge
 * seen on only a few lines (a stray word) is discarded.
 */
export function findColumnEdges(lines: PositionedLine[], minShare = 0.35): number[] {
  const usable = lines.filter((line) => line.words.length >= 2);
  if (usable.length < 2) return [];

  // Map each left-edge bin to the set of line indexes that start a word there.
  const bins = new Map<number, Set<number>>();
  usable.forEach((line, lineIndex) => {
    const seenInLine = new Set<number>();
    const words = [...line.words].sort((a, b) => a.x0 - b.x0);
    for (const word of words) {
      const bin = Math.floor(word.x0 / EDGE_BIN);
      if (seenInLine.has(bin)) continue;
      seenInLine.add(bin);
      if (!bins.has(bin)) bins.set(bin, new Set());
      bins.get(bin)!.add(lineIndex);
    }
  });

  // A column start must recur across enough lines to be a real column.
  const needed = Math.max(MIN_SHARED_LINES, Math.ceil(usable.length * minShare));
  const starts: number[] = [];
  for (const [bin, lineIndexes] of bins) {
    if (lineIndexes.size >= needed) starts.push(bin * EDGE_BIN + EDGE_BIN / 2);
  }
  starts.sort((a, b) => a - b);

  // Merge column starts that sit within one bin of each other.
  const merged: number[] = [];
  for (const start of starts) {
    const last = merged[merged.length - 1];
    if (last === undefined || start - last > EDGE_BIN * 1.5) merged.push(start);
    else merged[merged.length - 1] = Math.round((last + start) / 2);
  }

  // Edges are the boundaries *between* columns: drop the first column start
  // and place each remaining boundary just before its column begins, so a word
  // sitting exactly on the start opens a new cell while the prior cell closes.
  return merged.slice(1).map((start) => start - 1);
}

/** Split positioned lines into cell strings using the given column edges. */
export function splitByEdges(lines: PositionedLine[], edges: number[]): string[][] {
  return lines.map((line) => {
    const words = [...line.words].sort((a, b) => a.x0 - b.x0);
    const cells: string[] = [];
    let current: string[] = [];
    let edgeIndex = 0;
    for (const word of words) {
      const mid = (word.x0 + word.x1) / 2;
      while (edgeIndex < edges.length && mid > edges[edgeIndex]) {
        cells.push(current.join(' ').trim());
        current = [];
        edgeIndex += 1;
      }
      current.push(word.text);
    }
    cells.push(current.join(' ').trim());
    return cells;
  });
}

/**
 * Reconstruct a table from positioned lines. Returns null when the layout is
 * not tabular (fewer than two recurring columns).
 */
export function reconstructTable(
  lines: PositionedLine[],
  opts: { minHeight?: number } = {},
): string[][] | null {
  const ordered = [...lines].sort((a, b) => a.y - b.y);
  const edges = findColumnEdges(ordered);
  if (edges.length === 0) return null;
  const grid = splitByEdges(ordered, edges);
  const widths = new Set(grid.map((row) => row.filter((cell) => cell !== '').length));
  const wide = grid.filter((row) => row.filter((cell) => cell !== '').length >= 2);
  if (wide.length < Math.min(3, ordered.length) || widths.size === 0) return null;
  if (opts.minHeight && ordered.length < opts.minHeight) return null;
  return grid;
}

/**
 * Fallback: rebuild a grid from plain text by splitting on runs of 2+ spaces.
 * Works for monospaced/aligned text output (logs, OCR text, aligned tables).
 */
export function gridFromWhitespace(text: string): string[][] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, '    ').trim())
    .filter((line) => line.trim() !== '');
  return lines.map((line) => line.split(/\s{2,}/).map((cell) => cell.trim()));
}

/** True when the whitespace grid looks like a real table (≥2 columns in most rows). */
export function gridLooksTabular(grid: string[][]): boolean {
  if (grid.length < 2) return false;
  const columnCounts = grid.map((row) => row.filter((cell) => cell !== '').length);
  const multiColumn = columnCounts.filter((count) => count >= 2).length;
  return multiColumn >= 2 && multiColumn >= Math.ceil(grid.length * 0.5);
}
