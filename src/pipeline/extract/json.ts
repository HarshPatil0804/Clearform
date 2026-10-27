import type { Cell, Extraction } from '../../types';
import { flattenObject, recordsToMatrix } from '../../lib/flatten';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Find the first array-of-objects anywhere in a parsed JSON/YAML value. */
function findRecordList(value: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => isPlainObject(item))) {
      return value as Record<string, unknown>[];
    }
    for (const item of value) {
      const found = findRecordList(item);
      if (found) return found;
    }
    return null;
  }
  if (isPlainObject(value)) {
    const values = Object.values(value);
    const direct = values.find(
      (item) => Array.isArray(item) && item.length > 0 && item.every((entry) => isPlainObject(entry)),
    );
    if (direct) return direct as Record<string, unknown>[];
    for (const item of values) {
      const found = findRecordList(item);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Turn arbitrary JSON/YAML/XML data into a table, records or text.
 * Nested objects are flattened into dot-notation columns.
 */
export function jsonValueToExtraction(value: unknown, source: string, strategy: string): Extraction {
  const notes: string[] = [];

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { kind: 'records', source, records: [], strategy, notes: ['source contains an empty list'] };
    }
    if (value.every((item) => isPlainObject(item))) {
      const records = value.map((item) => flattenObject(item));
      return { kind: 'records', source, records, strategy, notes };
    }
    if (value.every((item) => Array.isArray(item))) {
      const header = value[0] as unknown[];
      const allStrings = header.every((cell) => typeof cell === 'string');
      const columns = allStrings
        ? (header as string[]).map((cell) => String(cell))
        : (header as unknown[]).map((_, index) => `col_${index + 1}`);
      const body = (allStrings ? value.slice(1) : value) as unknown[][];
      const width = Math.max(...value.map((row) => row.length));
      const columnsFull = [...columns];
      while (columnsFull.length < width) columnsFull.push(`col_${columnsFull.length + 1}`);
      const rows = body.map((row) => row.map((cell) => primitive(cell)));
      if (allStrings) notes.push('first array used as header row');
      return { kind: 'table', source, columns: columnsFull, rows, strategy, notes };
    }
    // Mixed / primitive array → single column records.
    const records = value.map((item, index) => {
      if (isPlainObject(item)) return flattenObject(item);
      if (Array.isArray(item)) return { index, value: JSON.stringify(item) };
      return { index: item as Cell };
    });
    notes.push('primitive list turned into records');
    return { kind: 'records', source, records, strategy, notes };
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    const arrayValues = entries.filter(([, item]) => Array.isArray(item));
    const primitiveArrays =
      arrayValues.length > 0 &&
      arrayValues.every(([, item]) => (item as unknown[]).every((entry) => !isPlainObject(entry) && !Array.isArray(entry)));

    if (primitiveArrays && arrayValues.length === entries.length && entries.length >= 1) {
      const lengths = arrayValues.map(([, item]) => (item as unknown[]).length);
      if (lengths.every((length) => length === lengths[0])) {
        const columns = entries.map(([key]) => key);
        const rows = (arrayValues[0] as unknown[]).map((_, rowIndex) =>
          arrayValues.map(([, item]) => primitive((item as unknown[])[rowIndex])),
        );
        notes.push('column-oriented object with equal-length arrays');
        return { kind: 'table', source, columns, rows, strategy, notes };
      }
      notes.push('column-oriented object with ragged arrays');
    }

    // { row1: {...}, row2: {...} } → records keyed by the object key
    const objectValues = entries.filter(([, item]) => isPlainObject(item));
    if (objectValues.length >= 2 && objectValues.length === entries.length) {
      const records = objectValues.map(([key, item]) => ({ key, ...flattenObject(item) }));
      notes.push('record map keyed by property name');
      return { kind: 'records', source, records, strategy, notes };
    }

    const single = flattenObject(value);
    const nested = findRecordList(value);
    if (nested && nested.length > 0) {
      // Every sibling of the record list (metadata, config sections, …) is
      // flattened into each record so nothing in the document is dropped.
      const siblings: Record<string, Cell> = {};
      for (const [key, item] of entries) {
        if (item === nested) continue;
        flattenObject({ [key]: item }, '', siblings);
      }
      const records = nested.map((item) => ({ ...siblings, ...flattenObject(item) }));
      notes.push(`records found in a nested array of objects (${records.length} row(s))`);
      notes.push('nested fields flattened into dot-notation columns');
      return { kind: 'records', source, records, strategy, notes };
    }
    notes.push('single nested object flattened into one row');
    return { kind: 'records', source, records: [single], strategy, notes };
  }

  return {
    kind: 'records',
    source,
    records: [{ value: primitive(value) }],
    strategy,
    notes: ['scalar document wrapped as a single row'],
  };
}

function primitive(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/** Parse JSON with a graceful NDJSON fallback. */
export function jsonToExtraction(text: string, source: string): Extraction {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return { kind: 'records', source, records: [], strategy: 'JSON (empty)', notes: ['file is empty'] };
  }

  try {
    const value = JSON.parse(trimmed);
    return jsonValueToExtraction(value, source, 'JSON document');
  } catch (jsonError) {
    // NDJSON: one JSON value per line.
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== '');
    const records: Record<string, Cell>[] = [];
    let badLines = 0;
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (isPlainObject(value)) records.push(flattenObject(value));
        else records.push({ value: primitive(value) });
      } catch {
        badLines += 1;
      }
    }
    if (records.length > 0 && records.length >= lines.length * 0.5) {
      const notes = [`NDJSON: ${records.length} records`];
      if (badLines > 0) notes.push(`${badLines} unparseable line(s) skipped`);
      return { kind: 'records', source, records, strategy: 'NDJSON (newline-delimited JSON)', notes };
    }
    const message = jsonError instanceof Error ? jsonError.message : String(jsonError);
    throw new Error(`Not valid JSON or NDJSON (${message})`);
  }
}

/** Convenience for record-shaped extractions that must become a matrix. */
export function recordsToExtraction(records: Record<string, Cell>[], source: string, strategy: string): Extraction {
  const { columns, rows } = recordsToMatrix(records);
  return { kind: 'table', source, columns, rows, strategy, notes: [] };
}
