import { useMemo, useState } from 'react';
import type { Dataset } from '../types';
import type { ResultItem } from '../App';
import { datasetToSheets, downloadCSV, downloadJSON, downloadXLSX, downloadText, qualityToCSV } from '../lib/export';
import { computePivot, suggestPivot } from '../lib/pivot';
import { displayCell } from '../lib/strings';
import TabularView from './TabularView';
import PivotView from './PivotView';
import QualityPanel from './QualityPanel';

type Mode = 'preview' | 'tabular' | 'pivot';

export interface ChoiceScreenProps {
  results: ResultItem[];
  activeIndex: number;
  onSelectFile: (index: number) => void;
  onDownloaded: () => void;
  onRestart: () => void;
}

function shortName(name: string): string {
  const parts = name.split(/[!/\\]/);
  const last = parts[parts.length - 1] || name;
  return last.length > 34 ? `${last.slice(0, 31)}…` : last;
}

export default function ChoiceScreen({
  results,
  activeIndex,
  onSelectFile,
  onDownloaded,
  onRestart,
}: ChoiceScreenProps) {
  const [mode, setMode] = useState<Mode>('preview');
  const active: Dataset = results[activeIndex]?.dataset ?? results[0].dataset;
  const report = active.report;

  // A sensible pivot, computed once per file, shown in the preview card too.
  const suggested = useMemo(() => {
    const config = suggestPivot(active);
    return { config, table: computePivot(active, config) };
  }, [active]);

  const downloadTabular = (kind: 'csv' | 'xlsx' | 'json') => {
    if (kind === 'csv') downloadCSV(active.columns, active.rows, 'data.csv');
    else if (kind === 'json') downloadJSON(active.columns, active.rows, 'data.json');
    else downloadXLSX(datasetToSheets(active), 'data.xlsx');
    onDownloaded();
  };

  const downloadQuality = () => {
    downloadText(qualityToCSV(report), 'quality-report.csv', 'text/csv;charset=utf-8');
    onDownloaded();
  };

  const previewRows = active.rows.slice(0, 12);

  return (
    <div className="flex flex-col gap-5">
      {results.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Processed files">
          {results.map((result, index) => (
            <button
              key={result.id}
              role="tab"
              aria-selected={index === activeIndex}
              className={`btn ${index === activeIndex ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                onSelectFile(index);
                setMode('preview');
              }}
              title={result.fileName}
            >
              {shortName(result.fileName)}
            </button>
          ))}
        </div>
      )}

      {/* ---------------------------------------------------- summary ---- */}
      <div className="card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Your data is ready</h2>
            <p className="muted text-sm mt-0.5">
              {shortName(report.fileName)} · <span className="font-semibold">{report.strategy}</span> ·{' '}
              {active.rows.length.toLocaleString()} rows × {active.columns.length} columns
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={downloadQuality}>
              Download quality report
            </button>
            <button className="btn btn-ghost" onClick={onRestart}>
              + Process more files
            </button>
          </div>
        </div>

        {/* preview */}
        <div className="grid-scroll rounded-lg border border-[var(--u2s-border)] mt-4 max-h-72">
          <table className="grid-table">
            <thead>
              <tr>
                {active.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{displayCell(cell) || <span className="text-slate-300 dark:text-slate-600">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted text-xs mt-2">
          Showing {previewRows.length} of {active.rows.length.toLocaleString()} cleaned rows — choose an output
          format below.
        </p>

        {/* choice cards */}
        <div className="grid gap-3 sm:grid-cols-2 mt-4">
          <button
            className={`card p-4 text-left transition hover:border-indigo-500 ${mode === 'tabular' ? 'border-indigo-600 ring-2 ring-indigo-600/30' : ''}`}
            onClick={() => setMode('tabular')}
          >
            <div className="flex items-center gap-2 font-semibold">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white text-xs">A</span>
              Tabular
            </div>
            <p className="muted text-xs mt-1">
              Clean table with sorting, search and per-column filters. Download as CSV, XLSX or JSON.
            </p>
          </button>
          <button
            className={`card p-4 text-left transition hover:border-indigo-500 ${mode === 'pivot' ? 'border-indigo-600 ring-2 ring-indigo-600/30' : ''}`}
            onClick={() => setMode('pivot')}
          >
            <div className="flex items-center gap-2 font-semibold">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-600 text-white text-xs">B</span>
              Pivot table
            </div>
            <p className="muted text-xs mt-1">
              Drag-and-drop builder with sum, count, avg, min and max. Suggested default:{' '}
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                {suggested.config.rows.join(', ') || '—'}
                {suggested.config.cols.length > 0 ? ` × ${suggested.config.cols.join(', ')}` : ''}
                {suggested.config.value ? ` → ${suggested.config.agg}(${suggested.config.value})` : ''}
              </span>
              . Download as XLSX or CSV.
            </p>
          </button>
        </div>
      </div>

      {/* --------------------------------------------------- tabular ------ */}
      {mode === 'tabular' && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={() => downloadTabular('csv')}>
                Download CSV
              </button>
              <button className="btn btn-secondary" onClick={() => downloadTabular('xlsx')}>
                Download XLSX
              </button>
              <button className="btn btn-secondary" onClick={() => downloadTabular('json')}>
                Download JSON
              </button>
            </div>
            <button className="btn btn-ghost" onClick={() => setMode('preview')}>
              ← Back to preview
            </button>
          </div>
          <TabularView dataset={active} />
        </div>
      )}

      {/* ----------------------------------------------------- pivot ------ */}
      {mode === 'pivot' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="muted text-xs">Switch formats at any time — no re-upload needed.</span>
            <button className="btn btn-ghost" onClick={() => setMode('preview')}>
              ← Back to preview
            </button>
          </div>
          <PivotView dataset={active} onDownloaded={onDownloaded} />
        </div>
      )}

      <QualityPanel dataset={active} onDownloaded={onDownloaded} />
    </div>
  );
}
