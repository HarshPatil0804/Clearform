import type {
  Cell,
  ColumnMeta,
  ColumnType,
  Dataset,
  FileReport,
  QualityReport,
  RawTable,
  RejectedRow,
  ValueMapping,
} from '../types';
import { cellKey, cleanText, isNullSentinel, standardizeNames } from '../lib/strings';
import { hasCurrencySign, hasPercentSign, parseNumberValue } from '../lib/numbers';
import { resolveDates, type DayMonthOrder } from '../lib/dates';
import { generatedNames, padRows } from '../lib/table';
import { findExportDate, rejectReasons, rejectRows, type HeaderMode } from './reject';
import { splitColumn } from './packed';
import { isIdColumn, normalizeIdColumn } from './ids';
import {
  buildLogicFlags,
  clearSystemCells,
  convertNumeric,
  detectSystemRows,
  findReportedTotal,
  isNumericColumn,
  normalizeCategories,
  reconcile,
} from './rules';

const BOOL_TRUE = /^(true|yes)$/i;
const BOOL_FALSE = /^(false|no)$/i;
const MATCH_RATIO = 0.8;
const SAMPLE_LIMIT = 1000;

export interface CleanOptions {
  /**
   * R3 – day/month order used only for format patterns the file never proves.
   * The UI toggle defaults to DD-MM ('DM') and re-runs the clean stage.
   */
  dateOrder?: DayMonthOrder;
}

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

function looksLikeDate(value: string): boolean {
  return resolveDates([value]).values[0] !== null;
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
    const dates = sample.filter((value) => looksLikeDate(value)).length;
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
    const out = values.map((value) => {
      if (value === null || typeof value === 'number') return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      const parsed = numericText(value) ? parseNumberValue(value) : null;
      if (parsed !== null) {
        if (hasCurrencySign(value)) currency += 1;
        if (hasPercentSign(value)) percent += 1;
        return parsed;
      }
      // R4: never leave text behind in a numeric column.
      return null;
    });
    if (currency > 0) notes.push(`${currency} currency value(s) normalised to numbers`);
    if (percent > 0) notes.push(`${percent} percent value(s) normalised to plain numbers`);
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

/** Rebuild the column list after one column expanded into several. */
interface Expansion {
  names: string[];
  force: boolean[];
  conv: number[];
  columns: Cell[][];
}

function rebuild(
  columns: string[],
  force: boolean[],
  conv: number[],
  rows: Cell[][],
  expand: (index: number, name: string, values: Cell[]) => Expansion | null,
): { columns: string[]; force: boolean[]; conv: number[]; rows: Cell[][]; added: string[] } {
  const nextNames: string[] = [];
  const nextForce: boolean[] = [];
  const nextConv: number[] = [];
  const nextRows: Cell[][] = rows.map(() => []);
  const added: string[] = [];

  columns.forEach((name, index) => {
    const values = rows.map((row) => row[index]);
    const expansion = expand(index, name, values);
    if (!expansion) {
      nextNames.push(name);
      nextForce.push(force[index] ?? false);
      nextConv.push(conv[index] ?? 0);
      values.forEach((value, rowIndex) => nextRows[rowIndex].push(value));
      return;
    }
    expansion.names.forEach((splitName, position) => {
      if (position > 0) added.push(splitName);
      nextNames.push(splitName);
      nextForce.push(expansion.force[position] ?? false);
      nextConv.push(expansion.conv[position] ?? 0);
      expansion.columns[position].forEach((value, rowIndex) => nextRows[rowIndex].push(value));
    });
  });

  return { columns: nextNames, force: nextForce, conv: nextConv, rows: nextRows, added };
}

/** Append one boolean flag column. */
function appendFlag(
  state: { columns: string[]; force: boolean[]; conv: number[]; types: ColumnType[]; rows: Cell[][] },
  name: string,
  values: Cell[],
): void {
  state.columns.push(name);
  state.force.push(false);
  state.conv.push(0);
  state.types.push('boolean');
  state.rows.forEach((row, index) => row.push(values[index] ?? null));
}

/**
 * Clean stage: R1 reject → header → normalise → R5 packed split → sentinels →
 * R2 ids → R7 system flag → R3 dates → R4 numbers → R6 categories → types →
 * R8 de-duplicate → R9 logic flags → R10 reconciliation → report.
 */
export function cleanTable(
  raw: RawTable,
  fileName: string,
  sourceType: string,
  options: CleanOptions = {},
): Dataset {
  const dateOrder: DayMonthOrder = options.dateOrder ?? 'DM';
  const notes = [...raw.notes];
  const cleanNotes: string[] = [];

  // ---- 1. R1: reject junk rows and locate the header ---------------------
  const columnsKnown = raw.columns.length > 0;
  const mode: HeaderMode = columnsKnown
    ? 'no'
    : raw.hasHeader === true
      ? 'yes'
      : raw.hasHeader === false
        ? 'no'
        : 'auto';
  const scan = rejectRows(raw.rows, mode, columnsKnown);

  let columns: string[];
  let rows: Cell[][];
  let headerDetected: boolean;
  let generated: string[] = [];

  if (columnsKnown) {
    columns = raw.columns.map((name) => cleanText(String(name)).trim());
    rows = scan.kept.map((row) => [...row]);
    headerDetected = raw.hasHeader !== false;
  } else if (scan.headerIndex >= 0) {
    const headerRow = scan.kept[scan.headerIndex];
    columns = headerRow.map((cell, index) =>
      cell === null || cell === undefined || `${cell}`.trim() === '' ? `col_${index + 1}` : `${cell}`,
    );
    rows = scan.kept.filter((_row, index) => index !== scan.headerIndex).map((row) => [...row]);
    headerDetected = true;
    cleanNotes.push('header row detected and used as column names');
  } else {
    const first = scan.kept[0] ?? [];
    columns = generatedNames(first.length);
    generated = [...columns];
    rows = scan.kept.map((row) => [...row]);
    headerDetected = false;
    cleanNotes.push('no header row found – generated column names');
  }

  const rejected: RejectedRow[] = scan.rejected;
  const rowsIn = raw.rows.length - (columnsKnown || scan.headerIndex < 0 ? 0 : 1);

  if (rows.length === 0) {
    throw new Error(rowsIn === 0 ? 'No data rows could be produced from this file' : 'All rows were empty after cleaning');
  }

  rows = padRows(rows, columns.length);

  // ---- 2. unicode / trim (sentinels come after the packed split) ---------
  rows = rows.map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return null;
      if (typeof cell === 'string') {
        const trimmed = cleanText(cell).trim();
        return trimmed === '' ? null : trimmed;
      }
      if (typeof cell === 'number' && !Number.isFinite(cell)) return null;
      return cell;
    }),
  );

  let force = columns.map(() => false);
  let conv = columns.map(() => 0);

  // ---- 3. R5: split packed fields ---------------------------------------
  const before = columns.length;
  const packed = rebuild(columns, force, conv, rows, (_index, name, values) => {
    const split = splitColumn(name, values);
    if (!split) return null;
    return {
      names: split.names,
      force: split.names.map(() => split.kind === 'pair'),
      conv: split.names.map(() => 0),
      columns: split.columns,
    };
  });
  if (packed.columns.length > before) {
    cleanNotes.push(`packed column(s) split into ${packed.columns.length} fields (R5)`);
  }
  columns = packed.columns;
  force = packed.force;
  conv = packed.conv;
  rows = packed.rows;

  // ---- 4. sentinels → null ----------------------------------------------
  let nullsFixed = 0;
  rows = rows.map((row) =>
    row.map((cell) => {
      if (typeof cell === 'string' && isNullSentinel(cell)) {
        nullsFixed += 1;
        return null;
      }
      return cell;
    }),
  );

  // ---- 5. drop empty rows -------------------------------------------------
  const beforeRows = rows.length;
  rows = rows.filter((row) => row.some((cell) => !isNullSentinel(cell)));
  const emptyRowsDropped = beforeRows - rows.length;
  if (rows.length === 0) throw new Error('All rows were empty after cleaning');

  // ---- 6. standardise column names (snake_case) --------------------------
  const standardised = standardizeNames(columns);
  const renamed = standardised.filter((name, index) => name !== columns[index]).length;
  if (renamed > 0) cleanNotes.push(`${renamed} column name(s) normalised to snake_case`);
  columns = standardised;

  // ---- 7. R2: identifier columns ----------------------------------------
  const idColumns: string[] = [];
  const idRebuilt = rebuild(columns, force, conv, rows, (index, name, values) => {
    if (!isIdColumn(name, values)) return null;
    const result = normalizeIdColumn(values);
    if (result.normalised === 0) return null;
    idColumns.push(name);
    cleanNotes.push(
      `column "${name}": ${result.normalised} identifier(s) normalised to a core key (original kept in ${name}_raw)`,
    );
    const names = [name, `${name}_raw`];
    const columnsOut: Cell[][] = [result.core, result.raw];
    const forceOut = [force[index] ?? false, false];
    const convOut = [conv[index] ?? 0, 0];
    if (result.hasTags) {
      names.push(`${name}_tag`);
      columnsOut.push(result.tag);
      forceOut.push(false);
      convOut.push(0);
    }
    return { names, force: forceOut, conv: convOut, columns: columnsOut };
  });
  columns = idRebuilt.columns;
  force = idRebuilt.force;
  conv = idRebuilt.conv;
  rows = idRebuilt.rows;

  // ---- 8. R7: system-generated notes ------------------------------------
  const systemRows = detectSystemRows(columns, rows);
  const systemCount = clearSystemCells(columns, rows, systemRows);
  const hasSystem = systemRows.some(Boolean);
  if (hasSystem) {
    columns.push('system_flag');
    force.push(false);
    conv.push(0);
    rows.forEach((row, index) => row.push(systemRows[index] ? true : null));
    cleanNotes.push(`${systemCount} system-generated note(s) moved to system_flag (R7)`);
  }

  // ---- 9. export date (reference for R3 future / R9 scheduled) -----------
  const exportDate = findExportDate(rejected);

  // ---- 10. provisional types --------------------------------------------
  let types: ColumnType[] = columns.map((_name, index) => inferType(rows.map((row) => row[index])));

  // ---- 11. R3: dates with a proven per-pattern day/month order -----------
  let ambiguousDates = 0;
  const ambiguousRows: boolean[] = new Array<boolean>(rows.length).fill(false);
  const dateIndices: number[] = [];

  for (let index = 0; index < columns.length; index += 1) {
    if (types[index] !== 'date') continue;
    dateIndices.push(index);
    const resolved = resolveDates(
      rows.map((row) => row[index]),
      dateOrder,
    );
    resolved.values.forEach((iso, rowIndex) => {
      rows[rowIndex][index] = iso;
    });
    for (const position of resolved.ambiguousIndices) ambiguousRows[position] = true;
    ambiguousDates += resolved.ambiguousIndices.length;
    conv[index] = resolved.converted;
    cleanNotes.push(`column "${columns[index]}": ${resolved.converted} date(s) normalised to ISO 8601 (R3)`);
    if (resolved.ambiguousIndices.length > 0) {
      cleanNotes.push(
        `column "${columns[index]}": ${resolved.ambiguousIndices.length} ambiguous day/month value(s) read as ${
          dateOrder === 'DM' ? 'DD-MM' : 'MM-DD'
        } – flip the toggle to re-read them`,
      );
    }
    types[index] = inferType(rows.map((row) => row[index]));
  }

  if (ambiguousDates > 0) {
    columns.push('date_ambiguous');
    force.push(false);
    conv.push(0);
    types.push('boolean');
    rows.forEach((row, index) => row.push(ambiguousRows[index] ? true : null));
  }

  if (exportDate && dateIndices.length > 0) {
    const futureRows = rows.map((row) =>
      dateIndices.some(
        (index) => typeof row[index] === 'string' && row[index] !== '' && (row[index] as string) > exportDate,
      ),
    );
    if (futureRows.some(Boolean)) {
      columns.push('date_future');
      force.push(false);
      conv.push(0);
      types.push('boolean');
      rows.forEach((row, index) => row.push(futureRows[index] ? true : null));
      cleanNotes.push(
        `column "date_future": ${futureRows.filter(Boolean).length} row(s) dated after the file's export date ${exportDate} (R3)`,
      );
    }
  }

  // ---- 12. R4: numbers, with the text moved to <col>_note ----------------
  const numericFlags = columns.map((_name, index) => isNumericColumn(rows.map((row) => row[index])));
  const numericRebuilt = rebuild(columns, force, conv, rows, (index, name, values) => {
    if (!numericFlags[index]) return null;
    const result = convertNumeric(values);
    if (result.moved === 0 && result.converted === 0) return null;
    const names = [name];
    const columnsOut: Cell[][] = [result.values];
    const forceOut = [force[index] ?? false];
    const convOut = [(conv[index] ?? 0) + result.converted];
    if (result.moved > 0) {
      cleanNotes.push(`column "${name}": ${result.moved} non-numeric value(s) moved to ${name}_note (R4)`);
      names.push(`${name}_note`);
      columnsOut.push(result.notes);
      forceOut.push(false);
      convOut.push(0);
    }
    if (result.converted > 0) {
      cleanNotes.push(`column "${name}": ${result.converted} value(s) normalised to plain numbers (R4)`);
    }
    return { names, force: forceOut, conv: convOut, columns: columnsOut };
  });
  columns = numericRebuilt.columns;
  force = numericRebuilt.force;
  conv = numericRebuilt.conv;
  rows = numericRebuilt.rows;

  // ---- 13. R6: category clustering + reshaping ---------------------------
  const mappings: ValueMapping[] = [];
  types = columns.map((_name, index) => inferType(rows.map((row) => row[index])));
  columns.forEach((name, index) => {
    if (types[index] !== 'text') return;
    const result = normalizeCategories(name, rows.map((row) => row[index]), force[index] ?? false);
    result.values.forEach((value, rowIndex) => {
      rows[rowIndex][index] = value;
    });
    conv[index] += result.conversions;
    mappings.push(...result.mappings);
    if (result.conversions > 0) {
      cleanNotes.push(`column "${name}": ${result.conversions} value(s) clustered to a canonical category form (R6)`);
    }
  });

  // ---- 14. drop empty columns -------------------------------------------
  const keep = columns.map((_name, index) => rows.some((row) => !isNullSentinel(row[index])));
  const emptyColumnsDropped = keep.filter((value) => !value).length;
  if (keep.some((value) => !value)) {
    cleanNotes.push(`${emptyColumnsDropped} empty column(s) removed`);
    columns = columns.filter((_name, index) => keep[index]);
    force = force.filter((_name, index) => keep[index]);
    conv = conv.filter((_name, index) => keep[index]);
    types = types.filter((_name, index) => keep[index]);
    rows = rows.map((row) => row.filter((_cell, index) => keep[index]));
  }

  // ---- 15. final type conversion ----------------------------------------
  types = [];
  for (let index = 0; index < columns.length; index += 1) {
    const values = rows.map((row) => row[index]);
    const type = inferType(values);
    types.push(type);
    const conversion = convertColumn(values, type);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      rows[rowIndex][index] = conversion.values[rowIndex];
    }
    for (const note of conversion.notes) cleanNotes.push(`column "${columns[index]}": ${note}`);
  }

  // ---- 16. R8: de-duplicate rows ----------------------------------------
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
  if (duplicatesRemoved > 0) cleanNotes.push(`${duplicatesRemoved} duplicate row(s) removed (R8)`);

  // ---- 17. R9: logic flags ----------------------------------------------
  const state = { columns, force, conv, types, rows };
  const flagNames: string[] = [];
  const flagCounts: { name: string; count: number }[] = [];

  for (const flag of buildLogicFlags(columns, rows, types, exportDate)) {
    flagCounts.push({ name: flag.name, count: flag.count });
    if (flag.count === 0) continue;
    appendFlag(state, flag.name, flag.values);
    flagNames.push(flag.name);
    cleanNotes.push(`column "${flag.name}": ${flag.count} row(s) flagged (R9 – flag only, never removed)`);
  }

  const countFlag = (name: string): number => {
    const index = state.columns.indexOf(name);
    if (index < 0) return 0;
    return state.rows.reduce<number>((total, row) => (row[index] === true ? total + 1 : total), 0);
  };
  for (const name of ['date_ambiguous', 'date_future']) {
    const count = countFlag(name);
    flagCounts.push({ name, count });
    if (count > 0) flagNames.push(name);
  }

  // R8 – same id, different content → keep both rows, flag the conflict.
  const conflicts = idConflictFlags(state.columns, state.rows, idColumns);
  const conflictCount = conflicts ? conflicts.filter(Boolean).length : 0;
  flagCounts.push({ name: 'duplicate_id_conflict', count: conflictCount });
  if (conflicts && conflictCount > 0) {
    appendFlag(state, 'duplicate_id_conflict', conflicts);
    flagNames.push('duplicate_id_conflict');
    cleanNotes.push(`column "duplicate_id_conflict": ${conflictCount} row(s) share an id but differ (R8)`);
  }

  if (hasSystem) {
    flagNames.push('system_flag');
    flagCounts.push({ name: 'system_flag', count: countFlag('system_flag') });
  }

  columns = state.columns;
  force = state.force;
  conv = state.conv;
  types = state.types;
  rows = state.rows;

  // ---- 18. missing values + outliers ------------------------------------
  const columnMeta: ColumnMeta[] = [];
  let valuesFilled = 0;
  let outliersFlagged = 0;
  let flaggedNulls = 0;
  const fillsByColumn = new Array<number>(columns.length).fill(0);

  for (let index = 0; index < columns.length; index += 1) {
    const values = rows.map((row) => row[index]);
    const nulls = values.filter((value) => value === null).length;

    if (nulls > 0 && types[index] === 'text' && rows.length >= 5 && nulls <= rows.length * 0.1) {
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
        cleanNotes.push(`column "${columns[index]}": ${nulls} gap(s) filled with the column mode`);
      } else {
        flaggedNulls += nulls;
      }
    } else if (nulls > 0) {
      flaggedNulls += nulls;
      if (types[index] !== 'text') {
        cleanNotes.push(
          `column "${columns[index]}": ${nulls} missing value(s) left as null (${types[index]} column)`,
        );
      }
    }

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

    columnMeta.push({
      name: columns[index],
      type: types[index],
      nulls: values.length - present.length,
      filled: fillsByColumn[index] ?? 0,
      unique,
      outliers,
      conversions: conv[index] ?? 0,
      examples,
    });
  }

  if (flaggedNulls > 0) cleanNotes.push(`${flaggedNulls} missing value(s) flagged across all columns`);

  // ---- 19. R10: reconciliation ------------------------------------------
  const reported = findReportedTotal(rejected);
  const reconciliation = reconcile(columns, rows, types, reported);
  if (reconciliation) {
    cleanNotes.push(
      reconciliation.reported === null
        ? `reconciliation: sum of ${reconciliation.column} = ${reconciliation.parsed} (file declares no total)`
        : `reconciliation (R10): ${reconciliation.column} parsed ${reconciliation.parsed} vs reported ${reconciliation.reported} → difference ${reconciliation.difference}`,
    );
  }

  const fileReport: FileReport = {
    fileName,
    sourceType,
    strategy: raw.strategy,
    rowsIn,
    rowsOut: rows.length,
    columnsIn: columns.length,
    columnsOut: columns.length,
    duplicatesRemoved,
    emptyRowsDropped,
    emptyColumnsDropped,
    nullsFixed,
    valuesFilled,
    outliersFlagged,
    headerDetected,
    generatedHeaders: generated,
    rejectedCount: rejected.length,
    rejectedReasons: rejectReasons(rejected),
    ambiguousDates,
    flagCounts,
    mappings,
    reconciliation,
    exportDate,
    notes: [...notes, ...cleanNotes],
  };

  const report: QualityReport = { ...fileReport, files: [fileReport], columns: columnMeta };

  return { columns, types, rows, rejected, flagColumns: flagNames, report };
}

// ---- R8: same id, different content -------------------------------------

/** Rows that share an id but not their content (null when there are no ids). */
function idConflictFlags(columns: string[], rows: Cell[][], idColumns: string[]): boolean[] | null {
  if (idColumns.length === 0) return null;
  const flags = new Array<boolean>(rows.length).fill(false);
  let any = false;

  for (const name of idColumns) {
    const index = columns.indexOf(name);
    if (index < 0) continue;
    const groups = new Map<string, number[]>();
    rows.forEach((row, rowIndex) => {
      const value = row[index];
      if (value === null || value === undefined) return;
      const key = String(value);
      const bucket = groups.get(key);
      if (bucket) bucket.push(rowIndex);
      else groups.set(key, [rowIndex]);
    });
    for (const bucket of groups.values()) {
      if (bucket.length < 2) continue;
      const signatures = new Set(bucket.map((rowIndex) => rows[rowIndex].map(cellKey).join('\u0001')));
      if (signatures.size < 2) continue;
      bucket.forEach((rowIndex) => {
        flags[rowIndex] = true;
      });
      any = true;
    }
  }

  return any ? flags : null;
}