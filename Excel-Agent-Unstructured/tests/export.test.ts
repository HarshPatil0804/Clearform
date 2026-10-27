import { describe, expect, it } from 'vitest';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import {
  datasetToSheets,
  pivotToMatrix,
  qualityToCSV,
  qualityToJSON,
  toJSON,
  toCSV,
  workbookFromSheets,
} from '../src/lib/export';
import { computePivot } from '../src/lib/pivot';
import { runSample } from './helpers';

/** Client-side downloads: CSV / JSON / XLSX round-trip through real parsers. */

describe('tabular export', () => {
  it('round-trips CSV through a real parser', async () => {
    const [ds] = await runSample('products.xlsx');
    const csv = toCSV(ds.columns, ds.rows);

    // UTF-8 BOM so Excel opens it correctly.
    expect(csv.charCodeAt(0)).toBe(0xfeff);

    const parsed = Papa.parse<string[]>(csv.replace(/^\uFEFF/, ''), { skipEmptyLines: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.data[0]).toEqual(ds.columns);
    expect(parsed.data.length).toBe(ds.rows.length + 1);
    // A value containing a comma survives quoting.
    const withComma = ds.rows.flat().find((cell) => String(cell).includes(','));
    if (withComma !== undefined) expect(csv).toContain('"');
  });

  it('round-trips JSON with one object per row', async () => {
    const [ds] = await runSample('orders.tsv');
    const json = toJSON(ds.columns, ds.rows);
    const records = JSON.parse(json) as Record<string, unknown>[];

    expect(records.length).toBe(ds.rows.length);
    expect(Object.keys(records[0])).toEqual(ds.columns);
    expect(records[0].customer).toBe(ds.rows[0][ds.columns.indexOf('customer')]);
  });

  it('writes an XLSX workbook that SheetJS reads back', async () => {
    const [ds] = await runSample('products.xlsx');
    const bytes = workbookFromSheets(datasetToSheets(ds));

    const workbook = XLSX.read(bytes, { type: 'array' });
    expect(workbook.SheetNames).toEqual(['data']);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets.data, { header: 1 });
    expect(rows[0]).toEqual(ds.columns);
    expect(rows.length).toBe(ds.rows.length + 1);
    expect(rows[1][0]).toBe(ds.rows[0][0]);
  });
});

describe('pivot export', () => {
  it('flattens the pivot into a matrix with headers, body and totals', async () => {
    const [ds] = await runSample('messy_sales.csv');
    const pivot = computePivot(ds, {
      rows: ['product'],
      cols: ['region'],
      value: 'units',
      agg: 'sum',
    });
    const { columns, rows } = pivotToMatrix(pivot);

    expect(columns[0]).toBe('product');
    expect(columns).toContain('grand_total');
    expect(columns.length).toBe(1 + pivot.columns.length + 1);

    // Last row is the totals row and its grand total matches the pivot.
    const totalRow = rows[rows.length - 1];
    expect(totalRow[0]).toBe('total');
    expect(totalRow[totalRow.length - 1]).toBe(pivot.grandTotal);
    expect(rows.length).toBe(pivot.rowLabels.length + 1);
  });

  it('writes the pivoted view to XLSX', async () => {
    const [ds] = await runSample('messy_sales.csv');
    const pivot = computePivot(ds, {
      rows: ['product'],
      cols: [],
      value: 'unit_price',
      agg: 'avg',
    });
    const matrix = pivotToMatrix(pivot);
    const bytes = workbookFromSheets([{ name: 'pivot', ...matrix }]);

    const workbook = XLSX.read(bytes, { type: 'array' });
    expect(workbook.SheetNames).toEqual(['pivot']);
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets.pivot, { header: 1 });
    expect(rows[0]).toEqual(matrix.columns);
    expect(rows.length).toBe(matrix.rows.length + 1);
  });
});

describe('quality report export', () => {
  it('exports every summary metric as parseable CSV', async () => {
    const [ds] = await runSample('messy_sales.csv');
    const csv = qualityToCSV(ds.report).replace(/^\uFEFF/, '');

    const parsed = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: true,
    });
    expect(parsed.errors).toEqual([]);

    const metrics = new Map(parsed.data.map((row) => [row.key, row.value]));
    expect(Number(metrics.get('rows_in'))).toBe(ds.report.rowsIn);
    expect(Number(metrics.get('rows_out'))).toBe(ds.report.rowsOut);
    expect(Number(metrics.get('duplicates_removed'))).toBe(ds.report.duplicatesRemoved);
    expect(metrics.get('strategy')).toBe(ds.report.strategy);
    // Per-column type breakdown is present, one row per metric.
    expect(metrics.get('date.type')).toBe('date');
    expect(parsed.data.some((row) => row.section === 'column' && row.key === 'units.type')).toBe(true);
  });

  it('exports the full report as JSON', async () => {
    const [ds] = await runSample('orders.tsv');
    const parsed = JSON.parse(qualityToJSON(ds.report)) as typeof ds.report;
    expect(parsed.rowsOut).toBe(ds.report.rowsOut);
    expect(parsed.columns.map((c) => c.name)).toEqual(ds.columns);
  });
});
