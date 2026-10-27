import type {
  Cell,
  ColumnMeta,
  ColumnType,
  Dataset,
  FileReport,
  QualityReport,
  RawTable,
} from '../types';
import { cellKey, cleanText, isNullSentinel, standardizeNames } from '../lib/strings';
import { hasCurrencySign, hasPercentSign, parseNumberValue } from '../lib/numbers';
import { parseDateValue } from '../lib/dates';
import { generatedNames, looksLikeHeaderRow, padRows } from '../lib/table';

const BOOL_TRUE = /^(true|yes)$/i;
const BOOL_FALSE = /^(false|no)$/i;
const MATCH_RATIO = 0.8;
const SAMPLE_LIMIT = 1000;

/** A leading "+" means phone/reference-like text – keep it, never coerce. */
function numericText(value: string): boolean {
  if (value.trimStart().startsWith('+')) return false;
  return parseNumberValue(value) !== null;
}

function sampleOf<T>(values: T[]): T[] {
  if (values.length <= SAMPLE_LIMIT) return values;
  const step = values.length / SAMPLE_LIMIT;
  const out: T[] = [];
  for (let i = 0; i < SAMPLE_LIMIT; i += 1) out.push(values[Math.floor(i * step)]);
  return out;
}

function inferType(values: Cell[]): ColumnType {
  const present = values.filter((value) => value !== null);
  if (present.length === 0) return 'text';
  if (present.every((value) => typeof value === 'boolean')) return 'boolean';

  if (present.every((value) => typeof value === 'string')) {
    const sample = sampleOf(present as string[]);
    const booleans = sample.filter((value) => BOOL_TRUE.test(value) || BOOL_FALSE.test(value)).length;
    if (booleans / sample.length >= MATCH_RATIO) return 'boolean';
    const numbers = sample.filter((value) => numericText(value)).length;
    if (numbers / sample.length >= MATCH_RATIO) return 'number';
    const dates = sample.filter((value) => parseDateValue(value) !== null).length;
    if (dates / sample.length >= MATCH_RATIO) return 'date';
    return 'text';
  }

  if (present.every((value) => typeof value === 'number')) return 'number';
  return 'text';
}

interface Conversion {
  values: Cell[];
  notes: string[];
}

function convertColumn(values: Cell[], type: ColumnType): Conversion {
  const notes: string[] = [];
  if (type === 'number') {
    let currency = 0;
    let percent = 0;
    let keptRaw = 0;
    const out = values.map((value) => {
      if (value === null || typeof value === 'number') return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      const raw = value;
      const parsed = numericText(raw) ? parseNumberValue(raw) : null;
      if (parsed !== null) {
        if (hasCurrencySign(raw)) currency += 1;
        if (hasPercentSign(raw)) percent += 1;
        return parsed;
      }
      keptRaw += 1;
      return raw;
    });
    if (currency > 0) notes.push(`${currency} currency value(s) normalised to numbers`);
    if (percent > 0) notes.push(`${percent} percent value(s) normalised to plain numbers`);
    if (keptRaw > 0) notes.push(`${keptRaw} non-numeric value(s) kept as text inside a numeric column`);
    return { values: out, notes };
  }

  if (type === 'date') {
    let keptRaw = 0;
    const out = values.map((value) => {
      if (value === null || typeof value !== 'string') return value;
      const iso = parseDateValue(value);
      if (iso !== null) return iso;
      keptRaw += 1;
      return value;
    });
    if (keptRaw > 0) notes.push(`${keptRaw} unparseable date value(s) kept as text`);
    return { values: out, notes };
  }

  if (type === 'boolean') {
    const out = values.map((value) => {
      if (value === null || typeof value !== 'string') return value;
      if (BOOL_TRUE.test(value)) return true;
      if (BOOL_FALSE.test(value)) return false;
      return value;
    });
    return { values: out, notes };
  }

  return { values, notes };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  const next = sorted[base + 1];
  return next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base];
}

function modeOf(values: Cell[]): Cell | null {
  const counts = new Map<string, { value: Cell; count: number }>();
  for (const value of values) {
    if (value === null) continue;
    const key = cellKey(value);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  let best: { value: Cell; count: number } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best ? best.value : null;
}

/**
 * Clean stage: header resolution, normalisation, de-duplication, type
 * inference, missing-value handling and outlier flagging (flag only, never
 * removal). Produces the Dataset plus its quality report.
 */
export function cleanTable(raw: RawTable, fileName: string, sourceType: string): Dataset {
  const notes = [...raw.notes];
  const cleanNotes: string[] = [];

  // ---- 1. columns / header ------------------------------------------------
  let columns: string[];
  let rows: Cell[][];
  let headerDetected: boolean;
  let generated: string[] = [];

  if (raw.columns.length > 0) {
    columns = [...raw.columns];
    rows = raw.rows.map((row) => [...row]);
    headerDetected = raw.hasHeader !== false;
  } else {
    const first = raw.rows[0] ?? [];
    const rest = raw.rows.slice(1);
    const looksLikeHeader = raw.hasHeader === true || (raw.hasHeader === null && looksLikeHeaderRow(first, rest));
    if (looksLikeHeader) {
      columns = first.map((cell, index) => (cell === null || `${cell}`.trim() === '' ? `col_${index + 1}` : `${cell}`));
      rows = rest.map((row) => [...row]);
      headerDetected = true;
      cleanNotes.push('header row detected and used as column names');
    } else {
      columns = generatedNames(first.length);
      generated = [...columns];
      rows = raw.rows.map((row) => [...row]);
      headerDetected = false;
      cleanNotes.push('no header row found – generated column names');
    }
  }

  const rowsIn = rows.length;
  const columnsIn = columns.length;
  if (rowsIn === 0) {
    throw new Error('No data rows could be produced from this file');
  }

  rows = padRows(rows, columns.length);

  // ---- 2. normalise cells (unicode, trim, sentinels → null) --------------
  let nullsFixed = 0;
  rows = rows.map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return null;
      if (typeof cell === 'string') {
        const trimmed = cleanText(cell).trim();
        if (trimmed === '') return null;
        if (isNullSentinel(trimmed)) {
          nullsFixed += 1;
          return null;
        }
        return trimmed;
      }
      if (typeof cell === 'number' && !Number.isFinite(cell)) return null;
      return cell;
    }),
  );

  // ---- 3. drop empty rows / columns --------------------------------------
  const beforeRows = rows.length;
  rows = rows.filter((row) => row.some((cell) => !isNullSentinel(cell)));
  const emptyRowsDropped = beforeRows - rows.length;
  if (rows.length === 0) {
    throw new Error('All rows were empty after cleaning');
  }

  const keep = columns.map((_column, index) => rows.some((row) => !isNullSentinel(row[index])));
  if (keep.some((value) => !value)) {
    const dropped = keep.filter((value) => !value).length;
    cleanNotes.push(`${dropped} empty column(s) removed`);
    columns = columns.filter((_column, index) => keep[index]);
    rows = rows.map((row) => row.filter((_cell, index) => keep[index]));
  }
  const emptyColumnsDropped = keep.filter((value) => !value).length;

  // ---- 4. standardise column names (snake_case) --------------------------
  const standardised = standardizeNames(columns);
  const renamed = standardised.filter((name, index) => name !== columns[index]).length;
  if (renamed > 0) cleanNotes.push(`${renamed} column name(s) normalised to snake_case`);
  columns = standardised;

  // ---- 5. infer types and convert ----------------------------------------
  const types: ColumnType[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const values = rows.map((row) => row[index]);
    const type = inferType(values);
    types.push(type);
    const conversion = convertColumn(values, type);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      rows[rowIndex][index] = conversion.values[rowIndex];
    }
    for (const note of conversion.notes) cleanNotes.push(`column "${columns[index]}": ${note}`);
    if (type === 'date') {
      const converted = conversion.values.filter((value, i) => value !== values[i]).length;
      if (converted > 0) cleanNotes.push(`column "${columns[index]}": ${converted} date(s) normalised to ISO 8601`);
    }
  }

  // ---- 6. de-duplicate rows ----------------------------------------------
  const seen = new Set<string>();
  const deduped: Cell[][] = [];
  let duplicatesRemoved = 0;
  for (const row of rows) {
    const key = row.map(cellKey).join('\u0001');
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  rows = deduped;
  if (duplicatesRemoved > 0) cleanNotes.push(`${duplicatesRemoved} duplicate row(s) removed`);

  // ---- 7. missing values --------------------------------------------------
  let valuesFilled = 0;
  let flaggedNulls = 0;
  const fillsByColumn = new Array<number>(columns.length).fill(0);
  for (let index = 0; index < columns.length; index += 1) {
    const values = rows.map((row) => row[index]);
    const nullCount = values.filter((value) => value === null).length;
    if (nullCount === 0) continue;

    if (types[index] === 'text' && rows.length >= 5 && nullCount <= rows.length * 0.1) {
      const present = values.filter((value) => value !== null);
      const mode = modeOf(values);
      const modeCount = present.filter((value) => cellKey(value) === cellKey(mode as Cell)).length;
      if (mode !== null && present.length > 0 && modeCount / present.length >= 0.5) {
        for (const row of rows) {
          if (row[index] === null) {
            row[index] = mode;
            valuesFilled += 1;
            fillsByColumn[index] += 1;
          }
        }
        cleanNotes.push(`column "${columns[index]}": ${nullCount} gap(s) filled with the column mode`);
        continue;
      }
    }
    flaggedNulls += nullCount;
    if (types[index] !== 'text') {
      cleanNotes.push(`column "${columns[index]}": ${nullCount} missing value(s) left as null (numeric/date column)`);
    }
  }

  // ---- 8. outlier flagging (never removal) --------------------------------
  const columnMeta: ColumnMeta[] = [];
  let outliersFlagged = 0;
  for (let index = 0; index < columns.length; index += 1) {
    const values = rows.map((row) => row[index]);
    const present = values.filter((value) => value !== null);
    const unique = new Set(present.map(cellKey)).size;

    let outliers = 0;
    if (types[index] === 'number' && present.length >= 8) {
      const numbers = (present.filter((value) => typeof value === 'number') as number[]).sort((a, b) => a - b);
      if (numbers.length >= 8) {
        const q1 = quantile(numbers, 0.25);
        const q3 = quantile(numbers, 0.75);
        const iqr = q3 - q1;
        if (iqr > 0) {
          const low = q1 - 1.5 * iqr;
          const high = q3 + 1.5 * iqr;
          outliers = numbers.filter((value) => value < low || value > high).length;
          if (outliers > 0) {
            cleanNotes.push(`column "${columns[index]}": ${outliers} outlier(s) flagged by IQR – left untouched`);
          }
        }
      }
    }
    outliersFlagged += outliers;

    const examples: Cell[] = [];
    for (const value of present) {
      if (examples.length >= 3) break;
      examples.push(value);
    }

    const nulls = values.length - present.length;
    columnMeta.push({
      name: columns[index],
      type: types[index],
      nulls,
      filled: fillsByColumn[index] ?? 0,
      unique,
      outliers,
      examples,
    });
  }

  const rowsOut = rows.length;
  const fileReport: FileReport = {
    fileName,
    sourceType,
    strategy: raw.strategy,
    rowsIn,
    rowsOut,
    columnsIn,
    columnsOut: columns.length,
    duplicatesRemoved,
    emptyRowsDropped,
    emptyColumnsDropped,
    nullsFixed,
    valuesFilled,
    outliersFlagged,
    headerDetected,
    generatedHeaders: generated,
    notes: [...notes, ...cleanNotes],
  };
  if (flaggedNulls > 0) {
    fileReport.notes.push(`${flaggedNulls} missing value(s) flagged across all columns`);
  }

  const report: QualityReport = { ...fileReport, files: [fileReport], columns: columnMeta };

  return { columns, types, rows, report };
}
