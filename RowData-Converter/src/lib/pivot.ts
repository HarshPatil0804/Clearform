import type { Aggregation, Cell, Dataset, PivotConfig } from '../types';
import { displayCell } from './strings';

/** Aggregated accumulator for one pivot cell. */
interface Acc {
  sum: number;
  count: number;
  min: number;
  max: number;
}

export interface PivotTable {
  rowFields: string[];
  colFields: string[];
  /** Displayed column keys (one per aggregate column). */
  columns: string[];
  /** Displayed row labels, one entry per row field. */
  rowLabels: string[][];
  cells: (number | null)[][];
  rowTotals: (number | null)[];
  colTotals: (number | null)[];
  grandTotal: number | null;
  agg: Aggregation;
  valueLabel: string;
  totalRows: number;
}

const BLANK = '(blank)';

function sortKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    if (a === BLANK) return 1;
    if (b === BLANK) return -1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function finalize(acc: Acc, agg: Aggregation): number | null {
  if (acc.count === 0) return null;
  switch (agg) {
    case 'sum':
      return acc.sum;
    case 'count':
      return acc.count;
    case 'avg':
      return acc.sum / acc.count;
    case 'min':
      return acc.min;
    case 'max':
      return acc.max;
    default:
      return acc.sum;
  }
}

function addTo(acc: Acc | undefined, value: number | null): Acc {
  const target = acc ?? { sum: 0, count: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
  if (value !== null && Number.isFinite(value)) {
    target.sum += value;
    target.count += 1;
    if (value < target.min) target.min = value;
    if (value > target.max) target.max = value;
  }
  return target;
}

/**
 * Compute a pivot table: group rows by the row fields, columns by the column
 * fields, and aggregate the value field with sum/count/avg/min/max.
 */
export function computePivot(dataset: Dataset, config: PivotConfig): PivotTable {
  const index = new Map<string, number>();
  dataset.columns.forEach((name, i) => index.set(name, i));

  const valueIndex = config.value ? (index.get(config.value) ?? -1) : -1;
  const rowIndexes = config.rows.map((name) => index.get(name) ?? -1);
  const colIndexes = config.cols.map((name) => index.get(name) ?? -1);

  const rowKeys = new Map<string, string[]>();
  const colKeys = new Map<string, string[]>();
  const cells = new Map<string, Acc>();
  const rowTotals = new Map<string, Acc>();
  const colTotals = new Map<string, Acc>();
  const grand = { acc: undefined as Acc | undefined };

  const countAll = config.agg === 'count' && (valueIndex === -1 || config.value === '');

  for (const row of dataset.rows) {
    const rowLabels = rowIndexes.map((i) => (i >= 0 ? displayCell(row[i]) || BLANK : ''));
    const colLabels = colIndexes.map((i) => (i >= 0 ? displayCell(row[i]) || BLANK : ''));
    const rowKey = rowLabels.join('\u0001');
    const colKey = colLabels.join('\u0001');

    if (!rowKeys.has(rowKey)) rowKeys.set(rowKey, rowLabels);
    if (!colKeys.has(colKey)) colKeys.set(colKey, colLabels);

    let value: number | null = null;
    if (countAll) {
      value = 1;
    } else if (valueIndex >= 0) {
      const raw: Cell = row[valueIndex];
      if (typeof raw === 'number' && Number.isFinite(raw)) value = raw;
      else if (typeof raw === 'boolean') value = raw ? 1 : 0;
      else value = null;
      if (value === null && config.agg !== 'count') continue;
    }

    const cellKey = `${rowKey}\u0002${colKey}`;
    cells.set(cellKey, addTo(cells.get(cellKey), value));
    rowTotals.set(rowKey, addTo(rowTotals.get(rowKey), value));
    colTotals.set(colKey, addTo(colTotals.get(colKey), value));
    grand.acc = addTo(grand.acc, value);
  }

  const sortedRowKeys = sortKeys([...rowKeys.keys()]);
  const sortedColKeys = sortKeys([...colKeys.keys()]);
  if (sortedRowKeys.length === 0) {
    sortedRowKeys.push('');
    rowKeys.set('', []);
  }

  const rowLabels = sortedRowKeys.map((key) => rowKeys.get(key) ?? ['']);
  const columns = sortedColKeys.map((key) => {
    const labels = colKeys.get(key) ?? [];
    return labels.length > 0 ? labels.join(' · ') : 'Total';
  });
  // When there are no column fields, the single column is the value itself.
  if (config.cols.length === 0) {
    columns.length = 0;
    columns.push(config.value ? config.value : 'count');
    sortedColKeys.length = 0;
    sortedColKeys.push('');
  }

  const matrix = sortedRowKeys.map((rowKey) =>
    sortedColKeys.map((colKey) => finalize(cells.get(`${rowKey}\u0002${colKey}`) ?? { sum: 0, count: 0, min: 0, max: 0 }, config.agg)),
  );
  const totalRows = sortedRowKeys.map((rowKey) => finalize(rowTotals.get(rowKey) ?? { sum: 0, count: 0, min: 0, max: 0 }, config.agg));
  const colTotalsOut = sortedColKeys.map((colKey) => finalize(colTotals.get(colKey) ?? { sum: 0, count: 0, min: 0, max: 0 }, config.agg));

  return {
    rowFields: [...config.rows],
    colFields: [...config.cols],
    columns,
    rowLabels,
    cells: matrix,
    rowTotals: totalRows,
    colTotals: colTotalsOut,
    grandTotal: grand.acc ? finalize(grand.acc, config.agg) : null,
    agg: config.agg,
    valueLabel: config.value || 'rows',
    totalRows: dataset.rows.length,
  };
}

const LABEL_HINTS = /^(amount|price|total|qty|quantity|value|sales|revenue|cost|score|count|sum|units)/i;
const ROW_HINTS = /(product|item|name|category|region|country|city|customer|client|department|status|team|brand|type|date)/i;
const COL_HINTS = /(region|country|category|status|type|year|month|channel|segment|department|team)/i;

function cardinality(dataset: Dataset, column: number): number {
  const seen = new Set<string>();
  for (const row of dataset.rows) {
    if (seen.size > 64) break;
    seen.add(String(row[column] ?? ''));
  }
  return seen.size;
}

/** Auto-suggest a sensible default pivot for the dataset. */
export function suggestPivot(dataset: Dataset): PivotConfig {
  const numeric = dataset.types
    .map((type, i) => (type === 'number' ? i : -1))
    .filter((i) => i >= 0);
  const categoricals = dataset.types
    .map((type, i) => (type === 'text' || type === 'date' ? i : -1))
    .filter((i) => i >= 0);

  let valueIndex = -1;
  if (numeric.length > 0) {
    valueIndex = numeric.find((i) => LABEL_HINTS.test(dataset.columns[i])) ?? numeric[0];
  }

  const usable = categoricals.filter((i) => {
    const card = cardinality(dataset, i);
    return card >= 2 && card <= 40;
  });

  // Rank candidate dimensions: text before dates (a date key usually makes
  // every row its own group), and low cardinality before high. Column order
  // breaks ties, so the sort stays deterministic.
  const lowCard = usable.filter((i) => cardinality(dataset, i) <= 12);
  const rank = (i: number): number =>
    (dataset.types[i] === 'text' ? 0 : 2) + (lowCard.includes(i) ? 0 : 1);
  const ordered = [...usable].sort((a, b) => rank(a) - rank(b));

  const rowIndex =
    ordered.find((i) => ROW_HINTS.test(dataset.columns[i])) ??
    ordered[0] ??
    categoricals[0] ??
    -1;

  const colIndex =
    ordered.find((i) => i !== rowIndex && COL_HINTS.test(dataset.columns[i])) ??
    ordered.find((i) => i !== rowIndex && cardinality(dataset, i) <= 12) ??
    -1;

  return {
    rows: rowIndex >= 0 ? [dataset.columns[rowIndex]] : [],
    cols: colIndex >= 0 ? [dataset.columns[colIndex]] : [],
    value: valueIndex >= 0 ? dataset.columns[valueIndex] : '',
    agg: valueIndex >= 0 ? 'sum' : 'count',
  };
}
