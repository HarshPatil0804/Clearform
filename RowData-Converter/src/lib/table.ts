import type { Cell } from '../types';
import { cleanText, isNullSentinel } from './strings';
import { parseNumberValue } from './numbers';
import { parseDateValue } from './dates';

/**
 * Shared table helpers used by extractors and the cleaning stage.
 */

/**
 * Heuristic header detection: the candidate header row holds short, unique
 * text labels while the body below usually carries typed (numeric/date) values.
 */
export function looksLikeHeaderRow(header: Cell[], body: Cell[][]): boolean {
  const nonEmpty = header.filter((cell) => !isNullSentinel(cell));
  if (nonEmpty.length === 0) return false;
  if (!header.every((cell) => cell === null || typeof cell === 'string')) return false;

  const keys = nonEmpty.map((cell) => cleanText(String(cell)).trim().toLowerCase());
  if (new Set(keys).size !== keys.length) return false;

  // If the candidate header itself carries numbers/dates it is data, not labels.
  const headerTyped =
    nonEmpty.filter((cell) => {
      if (typeof cell !== 'string') return false;
      return parseNumberValue(cell) !== null || parseDateValue(cell) !== null;
    }).length / nonEmpty.length;
  if (headerTyped > 0) return false;

  if (body.length === 0) return true;

  // Strong signal: body carries numbers/dates while the header is all text.
  let typed = 0;
  let counted = 0;
  for (const row of body.slice(0, 25)) {
    for (const cell of row) {
      if (isNullSentinel(cell)) continue;
      counted += 1;
      if (typeof cell !== 'string') typed += 1;
      else if (parseNumberValue(cell) !== null) typed += 1;
      else if (parseDateValue(cell) !== null) typed += 1;
    }
  }
  if (counted > 0 && typed / counted >= 0.5) return true;

  // All-text body: labels are short, sentence-like strings are not.
  const short = keys.filter((key) => key.length <= 40 && !/[.:;]$/.test(key));
  return short.length >= keys.length * 0.8;
}

/** Pad / truncate every row so the matrix matches the column count. */
export function padRows(rows: Cell[][], width: number): Cell[][] {
  return rows.map((row) => {
    const out = row.slice(0, width);
    while (out.length < width) out.push(null);
    return out;
  });
}

/** Deterministic placeholder names for header-less data. */
export function generatedNames(width: number): string[] {
  return Array.from({ length: width }, (_, index) => `col_${index + 1}`);
}
