import type { Cell } from '../types';

const MAX_DEPTH = 6;
const MAX_COLUMNS = 240;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function primitiveToCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return String(value);
  return JSON.stringify(value);
}

function formatPrimitiveArray(items: unknown[]): Cell {
  if (items.every((item) => typeof item === 'string')) return items.join(', ');
  return JSON.stringify(items.map((item) => primitiveToCell(item)));
}

/**
 * Flatten nested JSON/XML structures into dot-notation columns:
 *   { a: { b: 1 } }            → { 'a.b': 1 }
 *   { tags: ['x', 'y'] }       → { tags: 'x, y' }
 *   { items: [{ id: 1 }] }     → { 'items.0.id': 1 }
 */
export function flattenObject(
  input: unknown,
  prefix = '',
  out: Record<string, Cell> = {},
  depth = 0,
): Record<string, Cell> {
  if (Object.keys(out).length >= MAX_COLUMNS) return out;

  if (isPlainObject(input)) {
    const entries = Object.entries(input);
    if (entries.length === 0 && prefix) {
      out[prefix] = null;
      return out;
    }
    for (const [key, value] of entries) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value === null || value === undefined) {
        out[path] = null;
      } else if (Array.isArray(value)) {
        if (value.length === 0) out[path] = null;
        else if (value.every((item) => !isPlainObject(item) && !(item && Array.isArray(item)))) {
          out[path] = formatPrimitiveArray(value);
        } else if (depth < MAX_DEPTH) {
          value.forEach((item, index) => flattenObject(item, `${path}.${index}`, out, depth + 1));
        }
      } else if (isPlainObject(value)) {
        if (depth < MAX_DEPTH) flattenObject(value, path, out, depth + 1);
        else out[path] = JSON.stringify(value);
      } else {
        out[path] = primitiveToCell(value);
      }
    }
    return out;
  }

  if (Array.isArray(input)) {
    input.forEach((item, index) => flattenObject(item, prefix ? `${prefix}.${index}` : String(index), out, depth + 1));
    return out;
  }

  if (prefix) out[prefix] = primitiveToCell(input);
  return out;
}

/** Union of all keys, in first-seen order. */
export function unionKeys(records: Record<string, Cell>[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys.slice(0, MAX_COLUMNS);
}

export function recordsToMatrix(records: Record<string, Cell>[]): { columns: string[]; rows: Cell[][] } {
  const columns = unionKeys(records);
  const rows = records.map((record) => columns.map((key) => (key in record ? record[key] : null)));
  return { columns, rows };
}

export const COLUMN_LIMIT = MAX_COLUMNS;
