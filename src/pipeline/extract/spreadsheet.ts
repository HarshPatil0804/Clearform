import * as XLSX from 'xlsx';
import type { Cell, Extraction } from '../../types';
import { formatJsDate } from '../../lib/dates';
import { generatedNames, looksLikeHeaderRow, padRows } from '../../lib/table';

function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return formatJsDate(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return String(value);
  return String(value);
}

/**
 * SheetJS reader for XLSX/XLS/XLSM/ODS: picks the largest sheet, converts the
 * grid into cells and detects whether row 1 is a header.
 */
export function spreadsheetToExtraction(buffer: ArrayBuffer, source: string): Extraction {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true, dense: false });

  const notes: string[] = [];
  const sheetNames = workbook.SheetNames.filter((name) => workbook.Sheets[name]);
  if (sheetNames.length === 0) {
    throw new Error('Workbook contains no readable sheets');
  }

  let bestName = sheetNames[0];
  let bestCells = -1;
  for (const name of sheetNames) {
    const range = workbook.Sheets[name]['!ref'];
    let cells = 0;
    if (range) {
      const parsed = XLSX.utils.decode_range(range);
      cells = (parsed.e.r - parsed.s.r + 1) * (parsed.e.c - parsed.s.c + 1);
    }
    if (cells > bestCells) {
      bestCells = cells;
      bestName = name;
    }
  }
  if (sheetNames.length > 1) {
    notes.push(`workbook has ${sheetNames.length} sheets (${sheetNames.join(', ')}); using "${bestName}"`);
  }

  const sheet = workbook.Sheets[bestName];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  const rows = grid.map((row) => (Array.isArray(row) ? row.map(toCell) : [toCell(row)]));
  if (rows.length === 0) {
    return {
      kind: 'table',
      source,
      columns: [],
      rows: [],
      hasHeader: false,
      strategy: `Spreadsheet · sheet "${bestName}"`,
      notes: [...notes, 'sheet is empty'],
    };
  }

  const width = Math.max(...rows.map((row) => row.length));
  const padded = padRows(rows, width);
  const headerRow = padded[0];
  const body = padded.slice(1);
  const hasHeader = looksLikeHeaderRow(headerRow, body);

  const columns = hasHeader
    ? headerRow.map((cell, index) => (cell === null ? `col_${index + 1}` : String(cell)))
    : generatedNames(width);
  const dataRows = hasHeader ? body : padded;

  if (hasHeader) notes.push('header row taken from the first sheet row');
  else notes.push('no header row found – generated column names');

  return {
    kind: 'table',
    source,
    columns,
    rows: dataRows,
    hasHeader,
    strategy: `Spreadsheet · sheet "${bestName}"`,
    notes,
  };
}
