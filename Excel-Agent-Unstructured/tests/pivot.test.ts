import { describe, expect, it } from 'vitest';
import { computePivot, suggestPivot } from '../src/lib/pivot';
import { runSample, runText } from './helpers';
import type { Dataset } from '../src/types';

/** Pivot engine: auto-suggestion, every aggregation, and totals. */

async function salesDataset(): Promise<Dataset> {
  const [ds] = await runSample('messy_sales.csv');
  return ds;
}

describe('pivot auto-suggestion', () => {
  it('picks a readable cross-tab with a numeric value', async () => {
    const ds = await salesDataset();
    const config = suggestPivot(ds);

    // Low-cardinality dimensions beat the 13 unique dates.
    expect(config.rows).toEqual(['product']);
    expect(config.cols).toEqual(['region']);
    expect(config.value).toBe('units');
    expect(config.agg).toBe('sum');
  });

  it('falls back to count when there is no numeric column', async () => {
    const [ds] = await runText(
      'labels.csv',
      'city,tier\nPune,a\nNashik,b\nPune,c\nNagpur,b\n',
    );
    const config = suggestPivot(ds);
    expect(config.value).toBe('');
    expect(config.agg).toBe('count');
  });
});

describe('pivot aggregations', () => {
  it('sums values across row/column groups and totals them', async () => {
    const ds = await salesDataset();
    const units = ds.columns.indexOf('units');
    const pivot = computePivot(ds, {
      rows: ['product'],
      cols: ['region'],
      value: 'units',
      agg: 'sum',
    });

    expect(pivot.rowLabels.length).toBeGreaterThan(1);
    expect(pivot.columns.length).toBeGreaterThan(1);
    // Grand total equals the sum of every numeric units cell.
    const expected = ds.rows.reduce<number>(
      (total, row) => total + (typeof row[units] === 'number' ? row[units] : 0),
      0,
    );
    expect(pivot.grandTotal).toBeCloseTo(expected, 6);
    // Row totals add up to the grand total.
    const rowTotalSum = pivot.rowTotals.reduce<number>(
      (total, value) => total + (value ?? 0),
      0,
    );
    expect(rowTotalSum).toBeCloseTo(expected, 6);
  });

  it('supports count, avg, min and max', async () => {
    const ds = await salesDataset();
    const base = { rows: ['product'], cols: [] as string[], value: 'units', agg: 'sum' as const };

    const count = computePivot(ds, { ...base, agg: 'count' });
    const avg = computePivot(ds, { ...base, agg: 'avg' });
    const min = computePivot(ds, { ...base, agg: 'min' });
    const max = computePivot(ds, { ...base, agg: 'max' });
    const sum = computePivot(ds, { ...base, agg: 'sum' });

    // Count is the number of rows contributing to the pivot.
    expect(count.grandTotal).toBe(ds.rows.length);
    // sum = avg × count for each group; at grand-total level they line up.
    expect(sum.grandTotal!).toBeGreaterThan(max.grandTotal!);
    expect(min.grandTotal!).toBeLessThanOrEqual(max.grandTotal!);
    expect(avg.grandTotal!).toBeGreaterThanOrEqual(min.grandTotal!);
    expect(avg.grandTotal!).toBeLessThanOrEqual(max.grandTotal!);
  });

  it('exposes a single value column when no column fields are chosen', async () => {
    const ds = await salesDataset();
    const pivot = computePivot(ds, {
      rows: ['region'],
      cols: [],
      value: 'units',
      agg: 'sum',
    });
    expect(pivot.columns).toEqual(['units']);
    expect(pivot.colFields).toEqual([]);
    expect(pivot.cells[0].length).toBe(1);
  });

  it('keeps missing values out of numeric aggregations', async () => {
    const [ds] = await runText(
      'gaps.csv',
      'team,amount\nAlpha,10\nAlpha,\nBeta,30\n',
    );
    const pivot = computePivot(ds, {
      rows: ['team'],
      cols: [],
      value: 'amount',
      agg: 'sum',
    });
    expect(pivot.grandTotal).toBe(40);
    const count = computePivot(ds, { rows: ['team'], cols: [], value: 'amount', agg: 'count' });
    expect(count.grandTotal).toBe(2);
  });
});
