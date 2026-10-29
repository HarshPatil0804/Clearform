import type { Aggregation, Cell, Dataset, PivotConfig } from '../types';
import { displayCell } from './strings';

/** Aggregated accumulator for one pivot cell. */
interface Acc {
  sum: number;
  count: number;
  min: number;
  max: number;
}

export interface PivotOptions {
  /** P6 – drop rows flagged by this R9 flag column before aggregating. */
  excludeFlag?: string | null;
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
  /** Raw value field ('' when the pivot counts rows) – P8 info sheet. */
  valueField: string;
  /** P4 – rows whose value is null: excluded from the aggregation. */
  rowsWithoutValue: number;
  /** P6 – rows removed by the flagged-row filter. */
  rowsExcludedFlagged: number;
  /** P6 – flag column currently filtered on (null when none). */
  excludedFlag: string | null;
  /**
   * P5 – grand total recomputed by a second independent pass over the source
   * rows, so `verifyPivot` can catch bookkeeping bugs in the cell/total maps.
   */
  sourceGrand: number | null;
}

const BLANK = '(blank)';

function sortKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    if (a === BLANK) return 1;
    if (b === BLANK) return -1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
}

// ------------------------------------------------------------------ P2 ----

/**
 * Axis identity: case, spacing and punctuation never separate two values.
 * "Paid", "PAID" and " paid " collapse to one key, while "Emergency" and
 * "Emergency Care" stay apart.
 */
function axisKey(label: string): string {
  const key = label.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
  return key === '' ? label : key;
}

/**
 * P2 – cluster an axis so no two members differ only by case, spacing or
 * punctuation. Canonical form = most frequent variant (first-seen breaks ties),
 * which is R6's rule. "(blank)" never merges with a real value.
 */
function canonicaliseAxis(labels: string[]): (label: string) => string {
  const groups = new Map<string, Map<string, { count: number; first: number }>>();
  labels.forEach((label, index) => {
    if (label === BLANK) return;
    const key = axisKey(label);
    const bucket = groups.get(key);
    if (bucket) {
      const entry = bucket.get(label);
      if (entry) entry.count += 1;
      else bucket.set(label, { count: 1, first: index });
    } else {
      groups.set(key, new Map([[label, { count: 1, first: index }]]));
    }
  });

  const canonical = new Map<string, string>();
  for (const [key, bucket] of groups) {
    let best = '';
    let bestCount = -1;
    let bestFirst = Number.MAX_SAFE_INTEGER;
    for (const [form, entry] of bucket) {
      if (entry.count > bestCount || (entry.count === bestCount && entry.first < bestFirst)) {
        best = form;
        bestCount = entry.count;
        bestFirst = entry.first;
      }
    }
    canonical.set(key, best);
  }

  return (label: string) => {
    if (label === BLANK) return label;
    return canonical.get(axisKey(label)) ?? label;
  };
}

// ----------------------------------------------------------- aggregation ---

function finalize(acc: Acc | undefined, agg: Aggregation): number | null {
  if (!acc || acc.count === 0) return null;
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

/** Numeric contribution of one row for this config (null = no value). */
function rowValue(row: Cell[], valueIndex: number, countAll: boolean): number | null {
  if (countAll) return 1;
  if (valueIndex < 0) return null;
  const raw = row[valueIndex];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  return null;
}

/**
 * Compute a pivot table: group rows by the row fields, columns by the column
 * fields, and aggregate the value field with sum/count/avg/min/max.
 *
 * P1 – the input is always the final cleaned dataset; every filter (P6 flag
 * exclusion) is applied here so a settings change rebuilds from clean data.
 * P2 – axis labels are canonicalised first, so split categories can never
 * reach the output.
 */
export function computePivot(dataset: Dataset, config: PivotConfig, options: PivotOptions = {}): PivotTable {
  const index = new Map<string, number>();
  dataset.columns.forEach((name, i) => index.set(name, i));

  const valueIndex = config.value ? (index.get(config.value) ?? -1) : -1;
  const rowIndexes = config.rows.map((name) => index.get(name) ?? -1);
  const colIndexes = config.cols.map((name) => index.get(name) ?? -1);
  const flagIndex = options.excludeFlag ? (index.get(options.excludeFlag) ?? -1) : -1;
  const excludedFlag = flagIndex >= 0 ? (options.excludeFlag ?? null) : null;

  const countAll = config.agg === 'count' && (valueIndex === -1 || config.value === '');

  // P2 – canonical label per axis column, computed over every source label.
  const rowCanon = rowIndexes.map((field) =>
    canonicaliseAxis(dataset.rows.map((row) => (field >= 0 ? displayCell(row[field]) || BLANK : ''))),
  );
  const colCanon = colIndexes.map((field) =>
    canonicaliseAxis(dataset.rows.map((row) => (field >= 0 ? displayCell(row[field]) || BLANK : ''))),
  );

  const rowKeys = new Map<string, string[]>();
  const colKeys = new Map<string, string[]>();
  const cells = new Map<string, Acc>();
  const rowTotals = new Map<string, Acc>();
  const colTotals = new Map<string, Acc>();
  let grand: Acc | undefined;
  let rowsWithoutValue = 0;
  let rowsExcludedFlagged = 0;

  for (const row of dataset.rows) {
    // P6 – flagged rows are excluded before anything else sees them.
    if (flagIndex >= 0 && row[flagIndex] === true) {
      rowsExcludedFlagged += 1;
      continue;
    }

    const rowLabels = rowIndexes.map((field, position) =>
      field >= 0 ? rowCanon[position](displayCell(row[field]) || BLANK) : '',
    );
    const colLabels = colIndexes.map((field, position) =>
      field >= 0 ? colCanon[position](displayCell(row[field]) || BLANK) : '',
    );

    let value: number | null = null;
    if (countAll) {
      value = 1;
    } else {
      value = rowValue(row, valueIndex, countAll);
      if (value === null) {
        // P4 – rows without a value never enter the aggregation; they surface
        // as the "N of M rows" banner and in the Pivot info sheet instead of
        // silently vanishing. Count is included: a counted pivot counts the
        // rows that actually carry the value (751 of 999 for the sample).
        rowsWithoutValue += 1;
        continue;
      }
    }

    const rowKey = rowLabels.join('\u0001');
    const colKey = colLabels.join('\u0001');
    if (!rowKeys.has(rowKey)) rowKeys.set(rowKey, rowLabels);
    if (!colKeys.has(colKey)) colKeys.set(colKey, colLabels);

    const cellKey = `${rowKey}\u0002${colKey}`;
    cells.set(cellKey, addTo(cells.get(cellKey), value));
    rowTotals.set(rowKey, addTo(rowTotals.get(rowKey), value));
    colTotals.set(colKey, addTo(colTotals.get(colKey), value));
    grand = addTo(grand, value);
  }

  const sortedRowKeys = sortKeys([...rowKeys.keys()]);
  const sortedColKeys = sortKeys([...colKeys.keys()]);
  if (sortedRowKeys.length === 0) {
    sortedRowKeys.push('');
    rowKeys.set('', []);
  }

  const rowLabelsOut = sortedRowKeys.map((key) => rowKeys.get(key) ?? ['']);
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
    sortedColKeys.map((colKey) => finalize(cells.get(`${rowKey}\u0002${colKey}`), config.agg)),
  );
  const rowTotalsOut = sortedRowKeys.map((rowKey) => finalize(rowTotals.get(rowKey), config.agg));
  const colTotalsOut = sortedColKeys.map((colKey) => finalize(colTotals.get(colKey), config.agg));

  // P5 – independent second pass: the grand total summed straight from the
  // source rows, never from the maps above.
  let source: Acc | undefined;
  for (const row of dataset.rows) {
    if (flagIndex >= 0 && row[flagIndex] === true) continue;
    const value = rowValue(row, valueIndex, countAll);
    if (value === null) continue;
    source = addTo(source, value);
  }

  return {
    rowFields: [...config.rows],
    colFields: [...config.cols],
    columns,
    rowLabels: rowLabelsOut,
    cells: matrix,
    rowTotals: rowTotalsOut,
    colTotals: colTotalsOut,
    grandTotal: finalize(grand, config.agg),
    agg: config.agg,
    valueLabel: config.value || 'rows',
    totalRows: dataset.rows.length,
    valueField: config.value,
    rowsWithoutValue,
    rowsExcludedFlagged,
    excludedFlag,
    sourceGrand: finalize(source, config.agg),
  };
}

// ------------------------------------------------------------ P5 verify ----

export interface PivotVerification {
  ok: boolean;
  failures: string[];
}

const EPS = 1e-6;

function nonNull(values: (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null && Number.isFinite(value));
}

/**
 * P5 – verify the pivot before any download is allowed:
 *   • every row total equals an aggregate of its cells;
 *   • every column total equals an aggregate of its cells;
 *   • the grand total equals the independently summed source column.
 * Sum/count/min/max are exactly checkable; avg falls back to a bounds check
 * because an average of averages is not the average of the group.
 */
export function verifyPivot(pivot: PivotTable): PivotVerification {
  const failures: string[] = [];
  const compare = (label: string, actual: number | null, expected: number | null): void => {
    if (actual === null && expected === null) return;
    if (actual === null || expected === null) {
      failures.push(`${label}: total and cells disagree (${actual} vs ${expected})`);
      return;
    }
    if (Math.abs(actual - expected) > EPS) {
      failures.push(`${label}: ${actual} ≠ ${expected}`);
    }
  };
  const aggregate = (values: number[]): number | null => {
    if (values.length === 0) return null;
    switch (pivot.agg) {
      case 'min':
        return Math.min(...values);
      case 'max':
        return Math.max(...values);
      case 'avg':
        return values.reduce((total, value) => total + value, 0) / values.length;
      default:
        // sum, and count (each cell already holds its row count).
        return values.reduce((total, value) => total + value, 0);
    }
  };
  const bounds = (label: string, total: number | null, values: number[]): void => {
    if (total === null || values.length === 0) return;
    const low = Math.min(...values);
    const high = Math.max(...values);
    if (total < low - EPS || total > high + EPS) {
      failures.push(`${label}: ${total} outside cell range [${low}, ${high}]`);
    }
  };

  pivot.rowLabels.forEach((_labels, rowIndex) => {
    const values = nonNull(pivot.cells[rowIndex] ?? []);
    const label = `row "${pivot.rowLabels[rowIndex].join(' · ')}"`;
    if (pivot.agg === 'avg') bounds(label, pivot.rowTotals[rowIndex], values);
    else compare(label, pivot.rowTotals[rowIndex], aggregate(values));
  });

  pivot.columns.forEach((_column, colIndex) => {
    const values = nonNull(pivot.cells.map((row) => row[colIndex] ?? null));
    const label = `column "${pivot.columns[colIndex]}"`;
    if (pivot.agg === 'avg') bounds(label, pivot.colTotals[colIndex], values);
    else compare(label, pivot.colTotals[colIndex], aggregate(values));
  });

  compare('grand total vs source column', pivot.grandTotal, pivot.sourceGrand);
  if (pivot.agg !== 'avg') {
    const cells = nonNull(pivot.cells.flat());
    compare('grand total vs cells', pivot.grandTotal, aggregate(cells));
  }

  return { ok: failures.length === 0, failures };
}

// ------------------------------------------------------------ P6 shares ----

export interface FlagShare {
  flag: string;
  /** Share of the current pivot total contributed by flagged rows (0…1). */
  share: number;
  flagged: number;
  rest: number;
}

/**
 * P6 – for every R9 flag column, how much of the current total comes from
 * flagged rows. One pass over the data feeds all flags at once.
 */
export function flaggedShares(dataset: Dataset, config: PivotConfig): FlagShare[] {
  if (config.agg !== 'sum' && config.agg !== 'count') return [];
  const index = new Map<string, number>();
  dataset.columns.forEach((name, i) => index.set(name, i));
  const valueIndex = config.value ? (index.get(config.value) ?? -1) : -1;
  const countAll = config.agg === 'count' && (valueIndex === -1 || config.value === '');

  const flags = dataset.flagColumns
    .map((name) => ({ name, index: index.get(name) ?? -1 }))
    .filter((flag) => flag.index >= 0);
  if (flags.length === 0) return [];

  const acc = flags.map(() => ({ flagged: 0, rest: 0 }));

  dataset.rows.forEach((row) => {
    const value = countAll ? 1 : rowValue(row, valueIndex, countAll);
    if (value === null) return;
    flags.forEach((flag, position) => {
      if (row[flag.index] === true) acc[position].flagged += value;
      else acc[position].rest += value;
    });
  });

  return flags.flatMap((flag, position) => {
    const { flagged, rest } = acc[position];
    const total = flagged + rest;
    if (total === 0) return [];
    const share = flagged / total;
    if (share <= 0) return [];
    return [{ flag: flag.name, share, flagged, rest }];
  });
}

// ---------------------------------------------------------- P9 suggest -----

const VALUE_HINTS =
  /^(amount|price|total|qty|quantity|value|sales|revenue|cost|score|count|sum|units|fee|payment|charge|bill|income|salary|balance|profit|budget)/i;
const ID_NAME_RE = /(?:^|[_ -])(id|ids|no|num|number|code|key|ref)(?:$|[_ -])/i;

/** Row-axis priorities: lifecycle status first, then entities, then places. */
const ROW_PRIORITY = [
  /(?:^|[_ -])(status|state|stage|phase|lifecycle)(?:$|[_ -])/i,
  /(?:^|[_ -])(product|item|category|categories|brand|team|group|name|client|customer)(?:$|[_ -])/i,
  /(?:^|[_ -])(region|country|city|department|dept|channel|segment|type|tier|level|site|branch)(?:$|[_ -])/i,
];
/** Column-axis priorities: type/category first, then places, then status. */
const COL_PRIORITY = [
  /(?:^|[_ -])(type|category|categories|class|tier|level|segment|channel|mode)(?:$|[_ -])/i,
  /(?:^|[_ -])(region|country|city|department|dept|team|group|site|branch|brand|vendor)(?:$|[_ -])/i,
  /(?:^|[_ -])(status|state|stage|priority|severity)(?:$|[_ -])/i,
];

const SUGGEST_LIMIT = 12;
const FALLBACK_LIMIT = 40;

function cardinality(dataset: Dataset, column: number): number {
  const seen = new Set<string>();
  for (const row of dataset.rows) {
    if (seen.size > 64) break;
    seen.add(String(row[column] ?? ''));
  }
  return seen.size;
}

function nullRatio(dataset: Dataset, column: number): number {
  const limit = Math.min(dataset.rows.length, 2000);
  if (limit === 0) return 0;
  let missing = 0;
  for (let i = 0; i < limit; i += 1) {
    const value = dataset.rows[i][column];
    if (value === null || value === undefined || value === '') missing += 1;
  }
  return missing / limit;
}

/** Axis candidates: text/date, 3–12 distinct values, no flags, mostly filled. */
function axisCandidates(dataset: Dataset, limit: number): number[] {
  const flags = new Set(dataset.flagColumns);
  return dataset.types
    .map((type, i) => ({ type, i }))
    .filter(({ type, i }) => {
      if (type !== 'text' && type !== 'date') return false;
      if (flags.has(dataset.columns[i])) return false;
      if (nullRatio(dataset, i) > 0.5) return false;
      const card = cardinality(dataset, i);
      return card >= 3 && card <= limit;
    })
    .map(({ i }) => i);
}

function rankFor(patterns: RegExp[], columnName: string): number {
  for (let level = 0; level < patterns.length; level += 1) {
    if (patterns[level].test(columnName)) return level;
  }
  return patterns.length;
}

function pickAxis(dataset: Dataset, candidates: number[], patterns: RegExp[], taken: number): number {
  let best = -1;
  let bestRank = Number.MAX_SAFE_INTEGER;
  for (const column of candidates) {
    if (column === taken) continue;
    const rank = rankFor(patterns, dataset.columns[column]);
    if (rank < bestRank) {
      bestRank = rank;
      best = column;
    }
  }
  return best;
}

function valueCandidate(dataset: Dataset): number {
  const numeric = dataset.types
    .map((type, i) => ({ type, i }))
    .filter(
      ({ type, i }) =>
        type === 'number' &&
        !ID_NAME_RE.test(dataset.columns[i]) &&
        !dataset.flagColumns.includes(dataset.columns[i]) &&
        nullRatio(dataset, i) <= 0.5,
    )
    .map(({ i }) => i);
  if (numeric.length === 0) return -1;
  const hinted = numeric.find((i) => VALUE_HINTS.test(dataset.columns[i]));
  return hinted ?? numeric[0];
}

function suggestion(dataset: Dataset, candidates: number[], colsToSkip: number): PivotConfig {
  const valueIndex = valueCandidate(dataset);
  const rowIndex = pickAxis(dataset, candidates, ROW_PRIORITY, -1);
  let colIndex = pickAxis(dataset, candidates, COL_PRIORITY, rowIndex);
  if (colIndex === colsToSkip || colIndex === -1) {
    colIndex = pickAxis(
      dataset,
      candidates.filter((column) => column !== rowIndex && column !== colsToSkip),
      COL_PRIORITY,
      rowIndex,
    );
  }
  return {
    rows: rowIndex >= 0 ? [dataset.columns[rowIndex]] : [],
    cols: colIndex >= 0 ? [dataset.columns[colIndex]] : [],
    value: valueIndex >= 0 ? dataset.columns[valueIndex] : '',
    agg: valueIndex >= 0 ? 'sum' : 'count',
  };
}

/**
 * P9 – top-2 default pivots: two categorical columns with 3–12 values each
 * (after cleaning) for rows × columns, and a numeric column summed.
 */
export function suggestPivots(dataset: Dataset): PivotConfig[] {
  let candidates = axisCandidates(dataset, SUGGEST_LIMIT);
  if (candidates.length < 2) candidates = axisCandidates(dataset, FALLBACK_LIMIT);
  if (candidates.length === 0) {
    const valueIndex = valueCandidate(dataset);
    return [
      {
        rows: [],
        cols: [],
        value: valueIndex >= 0 ? dataset.columns[valueIndex] : '',
        agg: valueIndex >= 0 ? 'sum' : 'count',
      },
    ];
  }

  const first = suggestion(dataset, candidates, -1);
  const firstRow = first.rows.length > 0 ? dataset.columns.indexOf(first.rows[0]) : -1;
  const firstCol = first.cols.length > 0 ? dataset.columns.indexOf(first.cols[0]) : -1;

  // Second best: same rows, next-best columns; otherwise next row axis.
  let second = suggestion(dataset, candidates, firstCol);
  if (second.rows.join() === first.rows.join() && second.cols.join() === first.cols.join()) {
    const rowCandidates = candidates.filter((column) => column !== firstRow);
    const alt = pickAxis(dataset, rowCandidates, ROW_PRIORITY, -1);
    second =
      alt >= 0 && alt !== firstRow
        ? {
            rows: [dataset.columns[alt]],
            cols: first.cols,
            value: first.value,
            agg: first.agg,
          }
        : second;
  }

  const unique = [first, second].filter(
    (config, position, all) =>
      all.findIndex((other) => other.rows.join() === config.rows.join() && other.cols.join() === config.cols.join()) ===
      position,
  );
  return unique;
}

/** The single best default pivot (kept for existing callers/tests). */
export function suggestPivot(dataset: Dataset): PivotConfig {
  return suggestPivots(dataset)[0];
}
