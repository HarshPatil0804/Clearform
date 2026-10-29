import type { Cell, RejectedRow } from '../types';
import { looksLikeHeaderRow } from '../lib/table';

/**
 * R1 – junk row detection, run before anything else touches the data.
 *
 * Title lines, export-date lines, blank rows, error rows (ERR_*, SYSTEM
 * ALERT) and summary/total lines are moved to a "Rejected rows" table with a
 * reason instead of being deleted. The rules are structural (how many cells
 * are filled) plus a text pattern on the first cell, so they work for any
 * file – nothing here knows about a particular dataset.
 */

/** Empty means "no content": null, undefined, or blank/whitespace text. */
export function isEmptyCell(cell: Cell): boolean {
  if (cell === null || cell === undefined) return true;
  if (typeof cell === 'boolean') return false;
  if (typeof cell === 'number') return false;
  return cell.trim() === '';
}

function firstText(row: Cell[]): string {
  for (const cell of row) {
    if (isEmptyCell(cell)) continue;
    return String(cell).trim();
  }
  return '';
}

/** ERR_…, ERROR …, "SYSTEM ALERT: …", anything ending in _FAILED / _ERROR. */
export const ERROR_RE =
  /^(?:err(?:or)?[_\s:.-]|system\s+(?:alert|error|log|failure|message)\b|[\w.-]*(?:_failed|_error)\b)/i;
/** Control totals: "TOTAL …", "SUBTOTAL …", "GRAND TOTAL …", "SUMMARY …". */
export const TOTAL_RE = /^(?:grand\s+total|sub\s*total|totals?\b|summary\b|overall\b|aggregate\b)/i;
/** Exporter metadata: "Export Date:", "Export generated:", "Created at". */
export const META_RE =
  /^(?:export\b|generated\b|report\s+(?:date|generated|created)\b|created\s+(?:at|on)\b|last\s+(?:updated|modified)\b|timestamp\b)/i;

/** Most common row width – robust against one stray long/short line. */
export function modalWidth(rows: Cell[][]): number {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  let best = 1;
  let bestCount = -1;
  for (const [width, times] of counts) {
    if (times > bestCount || (times === bestCount && width > best)) {
      best = width;
      bestCount = times;
    }
  }
  return best;
}

function padTo(row: Cell[], width: number): Cell[] {
  const out = row.slice(0, width);
  while (out.length < width) out.push(null);
  return out;
}

function filledCount(row: Cell[]): number {
  let filled = 0;
  for (const cell of row) if (!isEmptyCell(cell)) filled += 1;
  return filled;
}

export type HeaderMode = 'auto' | 'yes' | 'no';

export interface RejectResult {
  /** Rows that survived R1, padded to the modal width. */
  kept: Cell[][];
  rejected: RejectedRow[];
  /** Index of the header row inside `kept`, or -1 when there is none. */
  headerIndex: number;
}

/**
 * Classify every row and locate the header.
 *
 * In `auto` mode the file's leading banners are consumed first: a sparse row
 * is a banner when a dense, header-shaped row follows it. That is what lets
 * the real header ("Visit_ID | Patient_Details | …") be found underneath a
 * title and an export-date line instead of the title being mistaken for it.
 */
export function rejectRows(raw: Cell[][], mode: HeaderMode, columnsKnown: boolean): RejectResult {
  const width = modalWidth(raw);
  // A row is "sparse" when almost none of its fields carry content. Data rows
  // fill most cells even when a couple of values are missing; banners fill one
  // or two. Requiring sparseness keeps every text rule off real data rows.
  const sparseAt = Math.max(1, Math.floor(width / 3));

  const kept: Cell[][] = [];
  const rejected: RejectedRow[] = [];
  let headerIndex = -1;

  const classify = (index: number): 'rejected' | 'kept' => {
    const padded = padTo(raw[index], width);
    const filled = filledCount(padded);
    if (filled === 0) {
      rejected.push({ reason: 'blank row', values: padded });
      return 'rejected';
    }
    if (filled <= sparseAt) {
      const head = firstText(padded);
      if (ERROR_RE.test(head)) {
        rejected.push({ reason: 'error row', values: padded });
        return 'rejected';
      }
      if (TOTAL_RE.test(head)) {
        rejected.push({ reason: 'summary/total line', values: padded });
        return 'rejected';
      }
      if (META_RE.test(head)) {
        rejected.push({ reason: 'export metadata line', values: padded });
        return 'rejected';
      }
    }
    kept.push(padded);
    return 'kept';
  };

  // Nothing to locate: the extractor already resolved the columns.
  if (columnsKnown || mode === 'no') {
    if (mode === 'yes' && raw.length > 0) {
      kept.push(padTo(raw[0], width));
      headerIndex = 0;
      for (let index = 1; index < raw.length; index += 1) classify(index);
      return { kept, rejected, headerIndex };
    }
    for (let index = 0; index < raw.length; index += 1) classify(index);
    return { kept, rejected, headerIndex };
  }

  if (mode === 'yes' && raw.length > 0) {
    kept.push(padTo(raw[0], width));
    headerIndex = 0;
    for (let index = 1; index < raw.length; index += 1) classify(index);
    return { kept, rejected, headerIndex };
  }

  // ---- auto: consume the banner block, then find the header --------------
  const hasHeaderAfter = (from: number): boolean => {
    const limit = Math.min(raw.length, from + 11);
    for (let index = from + 1; index < limit; index += 1) {
      const candidate = padTo(raw[index], width);
      if (filledCount(candidate) <= sparseAt) continue;
      if (looksLikeHeaderRow(candidate, raw.slice(index + 1))) return true;
    }
    return false;
  };

  let index = 0;
  while (index < raw.length) {
    const padded = padTo(raw[index], width);
    const filled = filledCount(padded);
    if (filled === 0) {
      rejected.push({ reason: 'blank row', values: padded });
      index += 1;
      continue;
    }
    if (filled > sparseAt) break;

    const head = firstText(padded);
    if (ERROR_RE.test(head)) rejected.push({ reason: 'error row', values: padded });
    else if (TOTAL_RE.test(head)) rejected.push({ reason: 'summary/total line', values: padded });
    else if (META_RE.test(head)) rejected.push({ reason: 'export metadata line', values: padded });
    else if (hasHeaderAfter(index)) rejected.push({ reason: 'title line', values: padded });
    else break;
    index += 1;
  }

  if (index < raw.length) {
    const candidate = padTo(raw[index], width);
    if (looksLikeHeaderRow(candidate, raw.slice(index + 1))) {
      headerIndex = kept.length;
    }
    kept.push(candidate);
    index += 1;
  }
  for (; index < raw.length; index += 1) classify(index);

  return { kept, rejected, headerIndex };
}

/** Count rejected rows per reason, in first-seen order. */
export function rejectReasons(rejected: RejectedRow[]): { reason: string; count: number }[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const row of rejected) {
    const seen = counts.get(row.reason);
    if (seen === undefined) {
      order.push(row.reason);
      counts.set(row.reason, 1);
    } else {
      counts.set(row.reason, seen + 1);
    }
  }
  return order.map((reason) => ({ reason, count: counts.get(reason) ?? 0 }));
}

/**
 * R10 helper – find the file's export/generated date so date_future and
 * scheduled_in_past have a reference point. Returns null when the file does
 * not declare one, in which case those flags are simply not raised.
 */
export function findExportDate(rejected: RejectedRow[]): string | null {
  for (const row of rejected) {
    const head = row.values.find((cell) => !isEmptyCell(cell));
    if (head === undefined) continue;
    if (!META_RE.test(String(head).trim())) continue;
    for (const cell of row.values) {
      if (isEmptyCell(cell)) continue;
      const match = /(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})/.exec(String(cell).trim());
      if (!match) continue;
      const iso = toIsoDate(match[1]);
      if (iso) return iso;
    }
  }
  return null;
}

function toIsoDate(value: string): string | null {
  const parts = value.split(/[-/]/).map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const [a, b, c] = parts as [number, number, number];
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (a > 31) return `${a}-${pad(b)}-${pad(c)}`;
  if (c > 31) return `${c}-${pad(b)}-${pad(a)}`;
  return null;
}