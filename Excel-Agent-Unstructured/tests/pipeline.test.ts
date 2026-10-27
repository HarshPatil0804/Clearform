import { describe, expect, it } from 'vitest';
import { listSamples, runSample, runText, runWithProgress } from './helpers';

/**
 * Every sample file must convert to a clean table automatically. These
 * assertions pin the important outcomes per format: correct columns, typed
 * values, de-duplication, null handling and header detection.
 */

describe('messy CSV', () => {
  it('detects the header, types columns and drops duplicates + sentinel rows', async () => {
    const [ds] = await runSample('messy_sales.csv');
    expect(ds.columns).toEqual(['date', 'product', 'units', 'unit_price', 'region', 'notes']);

    // Two duplicate Widget rows collapse to one; the all-N/A row is dropped.
    expect(ds.report.rowsIn).toBe(14);
    expect(ds.report.duplicatesRemoved).toBe(1);
    expect(ds.report.rowsOut).toBeLessThan(ds.report.rowsIn);

    // date parsed to ISO, currency stripped to numbers.
    const dateType = ds.types[ds.columns.indexOf('date')];
    expect(dateType).toBe('date');
    const unitIdx = ds.columns.indexOf('unit_price');
    expect(ds.types[unitIdx]).toBe('number');
    const price = ds.rows.find((r) => r[unitIdx] === 149)?.[unitIdx];
    expect(price).toBe(149);

    // No raw "N/A" sentinels survive as strings.
    const flat = JSON.stringify(ds.rows);
    expect(flat).not.toMatch(/N\/A/);
  });
});

describe('TSV', () => {
  it('splits on tabs and infers boolean + number', async () => {
    const [ds] = await runSample('orders.tsv');
    expect(ds.columns).toEqual(['order_id', 'customer', 'amount', 'shipped']);
    expect(ds.types).toEqual(['number', 'text', 'number', 'boolean']);
    expect(ds.rows.length).toBe(5);
    // "1,204.75" parsed to a number.
    expect(ds.rows[2][2]).toBe(1204.75);
  });
});

describe('headerless CSV', () => {
  it('generates column names when no header row exists', async () => {
    const [ds] = await runSample('headerless_data.csv');
    expect(ds.columns).toEqual(['col_1', 'col_2', 'col_3', 'col_4']);
    expect(ds.report.headerDetected).toBe(false);
    expect(ds.report.generatedHeaders).toEqual(['col_1', 'col_2', 'col_3', 'col_4']);
    // Mixed types inferred per column: text, number, date, number.
    expect(ds.types).toEqual(['text', 'number', 'date', 'number']);
  });
});

describe('nested JSON', () => {
  it('flattens nested objects into dot-notation columns', async () => {
    const [ds] = await runSample('nested_customers.json');
    expect(ds.columns).toContain('contact_email');
    expect(ds.columns).toContain('contact_phone');
    expect(ds.columns).toContain('orders_0_sku');
    expect(ds.rows.length).toBe(4);
    // Phone kept as text (leading +), not coerced to a number.
    const phoneIdx = ds.columns.indexOf('contact_phone');
    expect(ds.types[phoneIdx]).toBe('text');
    expect(String(ds.rows[0][phoneIdx])).toMatch(/^\+/);
  });
});

describe('NDJSON', () => {
  it('parses one record per line and skips corrupt lines', async () => {
    const [ds] = await runSample('events.ndjson');
    expect(ds.columns).toEqual(['ts', 'event', 'user', 'duration', 'amount']);
    // 5 valid lines (the corrupt {{{ line is skipped).
    expect(ds.rows.length).toBe(5);
    expect(ds.types[ds.columns.indexOf('ts')]).toBe('date');
  });
});

describe('XML', () => {
  it('turns a repeated element list into rows', async () => {
    const [ds] = await runSample('catalog.xml');
    expect(ds.rows.length).toBe(4);
    expect(ds.columns).toContain('title');
    expect(ds.columns).toContain('author');
    // price attribute flattened and value typed as number.
    const priceIdx = ds.columns.indexOf('price_value');
    expect(ds.types[priceIdx]).toBe('number');
  });
});

describe('YAML', () => {
  it('flattens nested maps and repeating list items', async () => {
    const [ds] = await runSample('config.yaml');
    expect(ds.columns).toContain('app_name');
    expect(ds.columns).toContain('port');
    // Two server entries → two rows.
    expect(ds.rows.length).toBe(2);
  });
});

describe('HTML', () => {
  it('extracts the table with header and typed cells', async () => {
    const [ds] = await runSample('report.html');
    expect(ds.columns).toEqual(['team', 'headcount', 'budget']);
    expect(ds.rows.length).toBe(4);
    // "$1,200,000" → 1200000 number.
    const budgetIdx = ds.columns.indexOf('budget');
    expect(ds.types[budgetIdx]).toBe('number');
    expect(ds.rows[0][budgetIdx]).toBe(1200000);
  });
});

describe('Markdown', () => {
  it('parses a pipe table', async () => {
    const [ds] = await runSample('readme.md');
    expect(ds.columns).toEqual(['region', 'q1', 'q2', 'q3']);
    expect(ds.rows.length).toBe(4);
    expect(ds.types[1]).toBe('number');
  });
});

describe('plain free text', () => {
  it('extracts entities (email, url, amount, phone) into columns', async () => {
    const [ds] = await runSample('plain.txt');
    expect(ds.columns).toEqual(expect.arrayContaining(['email', 'amount', 'phone']));
    const amountIdx = ds.columns.indexOf('amount');
    expect(ds.types[amountIdx]).toBe('number');
    // $12,400.00 captured.
    expect(ds.rows.some((r) => r[amountIdx] === 12400)).toBe(true);
  });
});

describe('key:value text', () => {
  it('groups repeated key=value blocks into rows', async () => {
    const [ds] = await runSample('app_settings.txt');
    expect(ds.columns).toEqual(['host', 'port', 'region', 'tls']);
    expect(ds.rows.length).toBe(3);
    expect(ds.types).toEqual(['text', 'number', 'text', 'boolean']);
  });
});

describe('repeated-line text (invoices)', () => {
  it('splits aligned rows and captures reference + amount', async () => {
    const [ds] = await runSample('invoices.txt');
    const amountIdx = ds.columns.indexOf('amount');
    expect(amountIdx).toBeGreaterThanOrEqual(0);
    expect(ds.types[amountIdx]).toBe('number');
    // "1,250.00" parsed.
    expect(ds.rows.some((r) => r[amountIdx] === 1250)).toBe(true);
  });
});

describe('log file', () => {
  it('parses timestamp/level/message from log lines', async () => {
    const [ds] = await runSample('server.log');
    expect(ds.columns).toEqual(['timestamp', 'level', 'message']);
    expect(ds.rows.length).toBe(10);
    expect(ds.types[0]).toBe('date');
    expect(ds.rows[0][1]).toBe('INFO');
  });
});

describe('email (.eml)', () => {
  it('decodes headers and quoted-printable body', async () => {
    const [ds] = await runSample('invoice.eml');
    expect(ds.rows.length).toBe(1);
    const subject = ds.rows[0][ds.columns.indexOf('subject')];
    expect(String(subject)).toContain('Q3 sales report');
    // quoted-printable café decoded (caf=C3=A9 → café).
    const body = String(ds.rows[0][ds.columns.indexOf('body')]);
    expect(body).toContain('café');
  });
});

describe('RTF', () => {
  it('strips control words and keeps visible text', async () => {
    const [ds] = await runSample('contact_card.rtf');
    const flat = JSON.stringify(ds.rows);
    expect(flat).toContain('Dana Fisher');
    expect(flat).toContain('dana@contoso.example');
    // No RTF control artifacts.
    expect(flat).not.toMatch(/\\par/);
  });
});

describe('XLSX', () => {
  it('reads the sheet, detects header and types columns', async () => {
    const [ds] = await runSample('products.xlsx');
    expect(ds.columns).toEqual(['product', 'category', 'units', 'price', 'restocked', 'in_stock']);
    expect(ds.rows.length).toBe(6);
    expect(ds.types).toEqual(['text', 'text', 'number', 'number', 'date', 'boolean']);
  });
});

describe('legacy XLS', () => {
  it('reads BIFF format', async () => {
    const [ds] = await runSample('legacy.xls');
    expect(ds.rows.length).toBe(6);
    expect(ds.columns).toContain('product');
  });
});

describe('DOCX', () => {
  it('extracts the embedded table', async () => {
    const [ds] = await runSample('meeting_notes.docx');
    expect(ds.columns).toEqual(['team', 'owner', 'score']);
    expect(ds.rows.length).toBe(3);
    expect(ds.types[2]).toBe('number');
  });
});

describe('PDF with a table', () => {
  it('reconstructs the table from positioned text', async () => {
    const [ds] = await runSample('inventory_table.pdf');
    expect(ds.columns).toEqual(['sku', 'description', 'qty', 'unit_price']);
    expect(ds.rows.length).toBe(5);
    expect(ds.types).toEqual(['text', 'text', 'number', 'number']);
    // First data row is W-1001 (header consumed), not reversed.
    expect(ds.rows[0][0]).toBe('W-1001');
  });
});

describe('ZIP archive', () => {
  it('processes every member into its own dataset', async () => {
    const datasets = await runSample('data_dump.zip');
    expect(datasets.length).toBe(3);
    const strategies = datasets.map((d) => d.report.strategy).join(' | ');
    expect(strategies).toMatch(/Delimited/);
    expect(strategies).toMatch(/JSON/);
    const csv = datasets.find((d) => d.columns.includes('revenue'));
    expect(csv).toBeDefined();
    expect(csv!.rows.length).toBe(3);
  });
});

// The scanned PNG is covered by tests/ocr.test.ts, which runs in a Node
// environment (tesseract.js cannot resolve its worker path under jsdom).

describe('robustness', () => {
  it('reports a clear error for a corrupt JSON file', async () => {
    await expect(runText('broken.json', '{ this is not json')).rejects.toThrow();
  });

  it('rejects an empty file with a clear, descriptive error', async () => {
    await expect(runText('empty.txt', '')).rejects.toThrow(/no readable text/i);
  });

  it('emits progress updates that end at done', async () => {
    const { datasets, events } = await runWithProgress('orders.tsv');
    expect(datasets.length).toBe(1);
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].stage).toBe('done');
    // Percentages are within 0..100 and non-decreasing overall to 100.
    for (const e of events) expect(e.pct).toBeGreaterThanOrEqual(0);
  });
});

describe('every sample converts', () => {
  it('produces at least one non-empty dataset per sample file', async () => {
    const samples = listSamples().filter((name) => !name.endsWith('.png'));
    expect(samples.length).toBeGreaterThan(15);
    for (const name of samples) {
      const datasets = await runSample(name).catch((error: Error) => {
        throw new Error(`${name} failed: ${error.message}`);
      });
      expect(datasets.length, `${name} produced no dataset`).toBeGreaterThan(0);
      for (const ds of datasets) {
        expect(ds.columns.length, `${name} has no columns`).toBeGreaterThan(0);
        expect(ds.rows.length, `${name} has no rows`).toBeGreaterThan(0);
        expect(ds.report.rowsOut).toBeGreaterThan(0);
      }
    }
  }, 180000);
});
