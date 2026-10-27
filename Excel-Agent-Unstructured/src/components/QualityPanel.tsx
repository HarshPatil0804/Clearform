import type { Dataset } from '../types';
import { qualityToCSV, qualityToJSON, downloadText } from '../lib/export';
import { displayCell } from '../lib/strings';

export interface QualityPanelProps {
  dataset: Dataset;
  onDownloaded: () => void;
}

const TYPE_CLASS: Record<string, string> = {
  number: 'badge badge-number',
  date: 'badge badge-date',
  boolean: 'badge badge-boolean',
  text: 'badge badge-text',
};

export default function QualityPanel({ dataset, onDownloaded }: QualityPanelProps) {
  const report = dataset.report;

  const summary: { label: string; value: string; hint?: string }[] = [
    { label: 'Rows in → out', value: `${report.rowsIn.toLocaleString()} → ${report.rowsOut.toLocaleString()}` },
    { label: 'Columns', value: `${report.columnsIn} → ${report.columnsOut}` },
    { label: 'Duplicates removed', value: report.duplicatesRemoved.toLocaleString() },
    {
      label: 'Nulls fixed',
      value: report.nullsFixed.toLocaleString(),
      hint: 'sentinel values ("N/A", "-", "null"…) converted to real nulls',
    },
    { label: 'Values filled', value: report.valuesFilled.toLocaleString(), hint: 'text gaps filled with the column mode' },
    { label: 'Outliers flagged', value: report.outliersFlagged.toLocaleString(), hint: 'IQR flags – never removed' },
    { label: 'Empty rows dropped', value: report.emptyRowsDropped.toLocaleString() },
    { label: 'Empty cols dropped', value: report.emptyColumnsDropped.toLocaleString() },
  ];

  return (
    <section className="card p-4 sm:p-5 flex flex-col gap-4" aria-label="Quality report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sm">Quality report</h3>
          <p className="muted text-xs">
            {report.strategy} · detected via {report.sourceType}
            {report.headerDetected ? ' · header detected' : ' · generated headers'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn btn-secondary"
            onClick={() => {
              downloadText(qualityToCSV(report), 'quality-report.csv', 'text/csv;charset=utf-8');
              onDownloaded();
            }}
          >
            Report CSV
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => {
              downloadText(qualityToJSON(report), 'quality-report.json', 'application/json');
              onDownloaded();
            }}
          >
            Report JSON
          </button>
        </div>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {summary.map((item) => (
          <div key={item.label} className="rounded-xl border border-[var(--u2s-border)] p-3" title={item.hint}>
            <dt className="muted text-[0.68rem] uppercase tracking-wide font-semibold">{item.label}</dt>
            <dd className="text-lg font-bold mono-num mt-0.5">{item.value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid-scroll rounded-lg border border-[var(--u2s-border)]">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Type</th>
              <th>Nulls</th>
              <th>Filled</th>
              <th>Unique</th>
              <th>Outliers</th>
              <th>Examples</th>
            </tr>
          </thead>
          <tbody>
            {report.columns.map((column) => (
              <tr key={column.name}>
                <td className="font-semibold">{column.name}</td>
                <td>
                  <span className={TYPE_CLASS[column.type] ?? 'badge badge-text'}>{column.type}</span>
                </td>
                <td className="mono-num">{column.nulls}</td>
                <td className="mono-num">{column.filled}</td>
                <td className="mono-num">{column.unique.toLocaleString()}</td>
                <td className="mono-num">{column.outliers > 0 ? <span className="text-amber-600 dark:text-amber-400">{column.outliers}</span> : 0}</td>
                <td className="muted">{column.examples.map((example) => displayCell(example)).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer muted font-semibold">
          Pipeline notes ({report.notes.length})
        </summary>
        <ul className="mt-2 list-disc pl-5 space-y-1 muted">
          {report.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
          {report.files.length > 1 && (
            <li>
              archive contained {report.files.length} processed file(s)
            </li>
          )}
        </ul>
      </details>
    </section>
  );
}
