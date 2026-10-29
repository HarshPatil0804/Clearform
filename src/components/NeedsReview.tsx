import { useMemo, useState } from 'react';
import type { Dataset } from '../types';
import { displayCell } from '../lib/strings';

export interface NeedsReviewProps {
  dataset: Dataset;
}

/**
 * The "Needs review" tab (R3/R8/R9/R7): every row carrying a flag — ambiguous
 * dates, future dates, id conflicts, logic flags, system notes — listed with
 * the reasons. Nothing here is ever removed from the data; this is a review
 * queue, not a filter.
 */
export default function NeedsReview({ dataset }: NeedsReviewProps) {
  const flagColumns = dataset.flagColumns;
  const [activeFlag, setActiveFlag] = useState<string>('all');

  const flagIndex = useMemo(
    () => new Map(flagColumns.map((name) => [name, dataset.columns.indexOf(name)])),
    [dataset.columns, flagColumns],
  );

  const isFlagged = (row: (string | number | boolean | null)[], name: string): boolean => {
    const index = flagIndex.get(name);
    if (index === undefined || index < 0) return false;
    return row[index] === true || row[index] === 'true' || row[index] === 1;
  };

  const flaggedRows = useMemo(() => {
    const out: { rowIndex: number; row: (string | number | boolean | null)[]; flags: string[] }[] = [];
    dataset.rows.forEach((row, rowIndex) => {
      const flags = flagColumns.filter((name) => isFlagged(row, name));
      if (flags.length > 0) out.push({ rowIndex, row, flags });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.rows, flagColumns, flagIndex]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    flagColumns.forEach((name) => map.set(name, 0));
    flaggedRows.forEach((entry) => entry.flags.forEach((name) => map.set(name, (map.get(name) ?? 0) + 1)));
    return map;
  }, [flagColumns, flaggedRows]);

  const shown = activeFlag === 'all' ? flaggedRows : flaggedRows.filter((entry) => entry.flags.includes(activeFlag));

  // Context columns: the first two non-flag columns give each row an identity.
  const context = dataset.columns
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => !flagColumns.includes(name) && !name.endsWith('_raw'))
    .slice(0, 3);

  if (flagColumns.length === 0) {
    return (
      <div className="card p-5">
        <h3 className="font-semibold text-sm">Needs review</h3>
        <p className="muted text-xs mt-1">
          Nothing was flagged in this file — no ambiguous dates, id conflicts or logic issues were detected.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="card p-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-sm">Needs review</h3>
            <p className="muted text-xs mt-0.5">
              {flaggedRows.length.toLocaleString()} of {dataset.rows.length.toLocaleString()} rows carry at least one
              flag. Flagged rows stay in the data — nothing was deleted.
            </p>
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => setActiveFlag('all')}
            aria-pressed={activeFlag === 'all'}
          >
            Show all
          </button>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by flag">
          <button
            className={`btn text-xs ${activeFlag === 'all' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveFlag('all')}
          >
            all ({flaggedRows.length.toLocaleString()})
          </button>
          {flagColumns.map((name) => (
            <button
              key={name}
              className={`btn text-xs ${activeFlag === name ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveFlag(name)}
              title={`Show only rows flagged: ${name}`}
            >
              {name} ({(counts.get(name) ?? 0).toLocaleString()})
            </button>
          ))}
        </div>
      </div>

      <div className="grid-scroll rounded-lg border border-[var(--u2s-border)] max-h-[28rem]">
        <table className="grid-table">
          <thead>
            <tr>
              <th>#</th>
              {context.map((column) => (
                <th key={column.name}>{column.name}</th>
              ))}
              <th>flags</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.rowIndex}>
                <td className="mono-num muted">{entry.rowIndex + 1}</td>
                {context.map((column) => (
                  <td key={column.name}>{displayCell(entry.row[column.index])}</td>
                ))}
                <td>
                  <span className="flex flex-wrap gap-1">
                    {entry.flags.map((name) => (
                      <span key={name} className="badge badge-boolean" title={`flagged: ${name}`}>
                        {name}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={context.length + 2} className="muted text-center py-4">
                  No rows carry this flag.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted text-xs">
        Showing {shown.length.toLocaleString()} row(s){activeFlag !== 'all' ? ` flagged ${activeFlag}` : ''}.
      </p>
    </div>
  );
}
