import { XMLParser } from 'fast-xml-parser';
import type { Cell, Extraction } from '../../types';
import { flattenObject } from '../../lib/flatten';
import { looksLikeHeaderRow, generatedNames, padRows } from '../../lib/table';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
  processEntities: true,
  ignoreDeclaration: false,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function primitive(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value;
  }
  return String(value);
}

/**
 * `#text` becomes `value`, `@_attr` becomes `attr` (prefixed when an element
 * child already uses that name) so columns read naturally after snake_case.
 */
function normalizeXmlKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeXmlKeys);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      let renamed = key;
      if (key === '#text') renamed = 'value';
      else if (key.startsWith('@_')) {
        const bare = key.slice(2);
        renamed = keys.includes(bare) ? `${bare}_attr` : bare;
      }
      out[renamed] = normalizeXmlKeys(item);
    }
    return out;
  }
  return value;
}

/**
 * Find the deepest repeated element list: `<items><item>…</item><item>…</item></items>`.
 * Returns the path plus the parsed item values.
 */
function findRecordList(node: unknown, path: string): { path: string; items: unknown[] } | null {
  if (Array.isArray(node)) {
    if (node.length > 0 && node.every((item) => isPlainObject(item))) {
      return { path, items: node };
    }
    for (const item of node) {
      const found = findRecordList(item, path);
      if (found) return found;
    }
    return null;
  }
  if (isPlainObject(node)) {
    const entries = Object.entries(node).filter(([key]) => key !== '#text');
    if (entries.length === 1) {
      const [key, value] = entries[0];
      const next = path ? `${path}.${key}` : key;
      const found = findRecordList(value, next);
      if (found) return found;
    }
    for (const [key, value] of entries) {
      const next = path ? `${path}.${key}` : key;
      const found = findRecordList(value, next);
      if (found) return found;
    }
  }
  return null;
}

/** Cell rows from `<row><c>1</c><c>2</c></row>` style markup. */
function cellMatrix(items: unknown[]): Cell[][] | null {
  const first = items[0];
  if (!isPlainObject(first)) return null;
  const keys = Object.keys(first);
  if (keys.length !== 1) return null;
  const values = (first as Record<string, unknown>)[keys[0]];
  if (!Array.isArray(values) || values.length < 2) return null;
  if (!values.every((value) => value === null || typeof value !== 'object')) return null;

  const rows: Cell[][] = [];
  for (const item of items) {
    if (!isPlainObject(item)) return null;
    const cells = item[keys[0]];
    if (!Array.isArray(cells) || cells.length !== values.length) return null;
    rows.push(cells.map(primitive));
  }
  return rows;
}

export function xmlToExtraction(text: string, source: string): Extraction {
  let parsed: unknown;
  try {
    parsed = parser.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid XML: ${message}`);
  }
  if (parsed === null || parsed === undefined || (isPlainObject(parsed) && Object.keys(parsed).length === 0)) {
    throw new Error('XML document is empty');
  }

  const found = findRecordList(parsed, '');

  if (found) {
    const matrix = cellMatrix(found.items);
    if (matrix) {
      const width = Math.max(...matrix.map((row) => row.length));
      const padded = padRows(matrix, width);
      const hasHeader = looksLikeHeaderRow(padded[0], padded.slice(1));
      const columns = hasHeader ? (padded[0] as string[]).map(String) : generatedNames(width);
      return {
        kind: 'table',
        source,
        columns,
        rows: hasHeader ? padded.slice(1) : padded,
        hasHeader,
        strategy: `XML table <${found.path || 'root'}>`,
        notes: [`repeated cell elements under <${found.path || 'root'}>`],
      };
    }

    const items = found.items;
    if (items.every((item) => item === null || typeof item !== 'object')) {
      const records = items.map((item, index) => ({ index: index + 1, value: primitive(item) }));
      return {
        kind: 'records',
        source,
        records,
        strategy: `XML list <${found.path || 'root'}>`,
        notes: ['flat list of values'],
      };
    }

    const records = items
      .filter(isPlainObject)
      .map((item) => flattenObject(normalizeXmlKeys(item)));
    return {
      kind: 'records',
      source,
      records,
      strategy: `XML list <${found.path || 'root'}>`,
      notes: ['nested elements flattened with dot notation', 'attributes flattened alongside element values'],
    };
  }

  const single = flattenObject(normalizeXmlKeys(parsed));
  return {
    kind: 'records',
    source,
    records: [single],
    strategy: 'XML document',
    notes: ['single element flattened into one row'],
  };
}
