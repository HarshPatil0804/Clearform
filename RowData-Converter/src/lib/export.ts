import * as XLSX from 'xlsx';
import type { Cell, Dataset, QualityReport } from '../types';
import { displayCell } from './strings';
import type { PivotTable } from './pivot';

/** RFC-4180 CSV with BOM (so Excel opens UTF-8 correctly). */
export function toCSV(columns: string[], rows: Cell[][]): string {
  const escape = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines: string[] = [columns.map(escape).join(',')];
  for (const row of rows) {
    lines.push(row.map((cell) => escape(displayCell(cell))).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function toJSON(columns: string[], rows: Cell[][]): string {
  const records = rows.map((row) => {
    const record: Record<string, Cell> = {};
    columns.forEach((name, index) => {
      record[name] = row[index] ?? null;
    });
    return record;
  });
  return `${JSON.stringify(records, null, 2)}\n`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text: string, fileName: string, mime: string): void {
  downloadBlob(new Blob([text], { type: mime }), fileName);
}

export function downloadCSV(columns: string[], rows: Cell[][], fileName: string): void {
  downloadText(toCSV(columns, rows), fileName, 'text/csv;charset=utf-8');
}

export function downloadJSON(columns: string[], rows: Cell[][], fileName: string): void {
  downloadText(toJSON(columns, rows), fileName, 'application/json');
}

export interface SheetSpec {
  name: string;
  columns: string[];
  rows: Cell[][];
}

export function workbookFromSheets(sheets: SheetSpec[]): Uint8Array<ArrayBuffer> {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const aoa = [sheet.columns, ...sheet.rows];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    worksheet['!cols'] = sheet.columns.map((name, index) => {
      let width = name.length + 2;
      for (let i = 0; i < Math.min(sheet.rows.length, 200); i += 1) {
        width = Math.max(width, displayCell(sheet.rows[i][index]).length + 2);
      }
      return { wch: Math.min(width, 60) };
    });
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name.slice(0, 31) || 'Sheet1');
  }
  // SheetJS returns an ArrayBuffer for type:'array' — Uint8Array.from() on an
  // ArrayBuffer silently yields 0 bytes, so unwrap it explicitly.
  const written = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer | ArrayLike<number>;
  return written instanceof ArrayBuffer ? new Uint8Array(written) : Uint8Array.from(written);
}

export function downloadXLSX(sheets: SheetSpec[], fileName: string): void {
  const out = workbookFromSheets(sheets);
  downloadBlob(
    new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    fileName,
  );
}

export function datasetToSheets(dataset: Dataset): SheetSpec[] {
  return [{ name: 'data', columns: dataset.columns, rows: dataset.rows }];
}

// ------------------------------------------------------------ pivot export --

/** Flatten a pivot table into a plain matrix (header + body + totals). */
export function pivotToMatrix(pivot: PivotTable): { columns: string[]; rows: Cell[][] } {
  const header = [...pivot.rowFields, ...pivot.columns, 'grand_total'];
  const rows: Cell[][] = pivot.rowLabels.map((labels, rowIndex) => [
    ...labels,
    ...pivot.cells[rowIndex].map((value) => (value === null ? null : round(value))),
    pivot.rowTotals[rowIndex] === null ? null : round(pivot.rowTotals[rowIndex] as number),
  ]);
  const totalRow: Cell[] = [
    ...pivot.rowFields.map((_, index) => (index === 0 ? 'total' : '')),
    ...pivot.colTotals.map((value) => (value === null ? null : round(value))),
    pivot.grandTotal === null ? null : round(pivot.grandTotal),
  ];
  rows.push(totalRow);
  return { columns: header, rows };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ------------------------------------------------------- quality report ----

/**
 * Quality report as CSV. Every row uses the same three columns
 * (section, key, value) so the file parses as one consistent table.
 */
export function qualityToCSV(report: QualityReport): string {
  const lines: string[] = [];
  const esc = (value: string | number): string =>
    /[",\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
  const row = (section: string, key: string, value: string | number): void => {
    lines.push([section, key, value].map(esc).join(','));
  };

  lines.push('section,key,value');
  row('summary', 'file', report.fileName);
  row('summary', 'source_type', report.sourceType);
  row('summary', 'strategy', report.strategy);
  row('summary', 'rows_in', report.rowsIn);
  row('summary', 'rows_out', report.rowsOut);
  row('summary', 'columns_in', report.columnsIn);
  row('summary', 'columns_out', report.columnsOut);
  row('summary', 'duplicates_removed', report.duplicatesRemoved);
  row('summary', 'empty_rows_dropped', report.emptyRowsDropped);
  row('summary', 'empty_columns_dropped', report.emptyColumnsDropped);
  row('summary', 'nulls_fixed', report.nullsFixed);
  row('summary', 'values_filled', report.valuesFilled);
  row('summary', 'outliers_flagged', report.outliersFlagged);
  row('summary', 'header_detected', report.headerDetected ? 'yes' : 'no');

  for (const column of report.columns) {
    const key = (suffix: string): string => `${column.name}.${suffix}`;
    row('column', key('type'), column.type);
    row('column', key('nulls'), column.nulls);
    row('column', key('filled'), column.filled);
    row('column', key('unique'), column.unique);
    row('column', key('outliers'), column.outliers);
    row('column', key('examples'), column.examples.map((example) => displayCell(example)).join(' | '));
  }

  if (report.files.length > 1) {
    for (const file of report.files) {
      const key = (suffix: string): string => `${file.fileName}.${suffix}`;
      row('file', key('source_type'), file.sourceType);
      row('file', key('rows_in'), file.rowsIn);
      row('file', key('rows_out'), file.rowsOut);
      row('file', key('duplicates_removed'), file.duplicatesRemoved);
    }
  }

  for (const note of report.notes) row('note', '', note);

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function qualityToJSON(report: QualityReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
