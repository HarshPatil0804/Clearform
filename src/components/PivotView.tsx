import { useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { Aggregation, ColumnType, Dataset, PivotConfig } from '../types';
import { computePivot, suggestPivot, type PivotTable } from '../lib/pivot';
import { pivotToMatrix, downloadCSV, downloadXLSX } from '../lib/export';

export interface PivotViewProps {
  dataset: Dataset;
  onDownloaded: () => void;
}

type Zone = 'rows' | 'cols' | 'values';

const AGGS: { value: Aggregation; label: string }[] = [
  { value: 'sum', label: 'Sum' },
  { value: 'count', label: 'Count' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
];

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function FieldChip({
  field,
  type,
  from,
  onRemove,
}: {
  field: string;
  type?: ColumnType;
  from?: Zone | 'palette';
  onRemove?: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `chip-${from ?? 'palette'}-${field}`,
    data: { field },
  });
  return (
    <span
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`field-chip ${isDragging ? 'field-chip-dragging' : ''}`}
    >
      {type && (
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${
            type === 'number'
              ? 'bg-cyan-500'
              : type === 'date'
                ? 'bg-fuchsia-500'
                : type === 'boolean'
                  ? 'bg-green-500'
                  : 'bg-slate-400'
          }`}
        />
      )}
      {field}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${field}`}
          className="muted hover:text-red-500 font-bold leading-none"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

function ZoneBox({
  id,
  label,
  children,
  hint,
}: {
  id: string;
  label: string;
  children: ReactNode;
  hint: string;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div>
      <div className="text-[0.7rem] font-bold uppercase tracking-wide muted mb-1">{label}</div>
      <div ref={setNodeRef} className={`drop-zone-box ${isOver ? 'drop-zone-box-over' : ''}`}>
        {children}
        {Array.isArray(children) && children.length === 0 && (
          <span className="muted text-xs px-1">{hint}</span>
        )}
      </div>
    </div>
  );
}

export default function PivotView({ dataset, onDownloaded }: PivotViewProps) {
  const [config, setConfig] = useState<PivotConfig>(() => suggestPivot(dataset));
  const typeIndex = useMemo(() => {
    const map = new Map<string, ColumnType>();
    dataset.columns.forEach((name, index) => map.set(name, dataset.types[index]));
    return map;
  }, [dataset]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const pivot: PivotTable = useMemo(() => {
    const effective: PivotConfig = { ...config };
    if (effective.value && typeIndex.get(effective.value) !== 'number' && effective.agg !== 'count') {
      effective.agg = 'count';
    }
    if (!effective.value) effective.agg = 'count';
    return computePivot(dataset, effective);
  }, [dataset, config, typeIndex]);

  const assigned = new Set([...config.rows, ...config.cols, ...(config.value ? [config.value] : [])]);
  const palette = dataset.columns.filter((name) => !assigned.has(name));

  const moveField = (field: string, zone: Zone) => {
    setConfig((previous) => {
      const rows = previous.rows.filter((name) => name !== field);
      const cols = previous.cols.filter((name) => name !== field);
      const value = previous.value === field ? '' : previous.value;
      if (zone === 'values') return { ...previous, rows, cols, value: field };
      if (zone === 'rows') return { ...previous, rows: [...rows, field], cols, value };
      return { ...previous, rows, cols: [...cols, field], value };
    });
  };

  const unassign = (field: string) => {
    setConfig((previous) => ({
      ...previous,
      rows: previous.rows.filter((name) => name !== field),
      cols: previous.cols.filter((name) => name !== field),
      value: previous.value === field ? '' : previous.value,
    }));
  };

  const onDragEnd = (event: DragEndEvent) => {
    const field = event.active.data.current?.field as string | undefined;
    const overId = event.over?.id as string | undefined;
    if (!field) return;
    if (overId && overId.startsWith('zone-')) {
      moveField(field, overId.slice(5) as Zone);
    } else if (overId === 'palette') {
      unassign(field);
    }
  };

  const { setNodeRef: paletteRef, isOver: paletteOver } = useDroppable({ id: 'palette' });

  const downloadPivotCsv = () => {
    const { columns, rows } = pivotToMatrix(pivot);
    downloadCSV(columns, rows, 'pivot.csv');
    onDownloaded();
  };
  const downloadPivotXlsx = () => {
    const { columns, rows } = pivotToMatrix(pivot);
    downloadXLSX([{ name: 'pivot', columns, rows }], 'pivot.xlsx');
    onDownloaded();
  };

  const valueType = config.value ? typeIndex.get(config.value) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="card p-4 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold text-sm">Pivot builder</h3>
              <p className="muted text-xs">Drag fields into Rows, Columns and Values — or drop them back on the field list.</p>
            </div>
            <div className="flex items-center gap-2">
              <label className="muted text-xs flex items-center gap-2">
                Aggregation
                <select
                  className="input"
                  value={config.agg}
                  onChange={(event) => setConfig({ ...config, agg: event.target.value as Aggregation })}
                  aria-label="Aggregation"
                >
                  {AGGS.map((agg) => (
                    <option key={agg.value} value={agg.value}>
                      {agg.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn btn-ghost" onClick={() => setConfig(suggestPivot(dataset))}>
                Reset suggestion
              </button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <ZoneBox id="zone-rows" label="Rows" hint="Drag a field here">
              {config.rows.map((field) => (
                <FieldChip
                  key={field}
                  field={field}
                  type={typeIndex.get(field)}
                  from="rows"
                  onRemove={() => unassign(field)}
                />
              ))}
            </ZoneBox>
            <ZoneBox id="zone-cols" label="Columns" hint="Drag a field here">
              {config.cols.map((field) => (
                <FieldChip
                  key={field}
                  field={field}
                  type={typeIndex.get(field)}
                  from="cols"
                  onRemove={() => unassign(field)}
                />
              ))}
            </ZoneBox>
            <ZoneBox id="zone-values" label="Values" hint="Drag a field here">
              {config.value ? (
                <FieldChip
                  field={config.value}
                  type={typeIndex.get(config.value)}
                  from="values"
                  onRemove={() => unassign(config.value)}
                />
              ) : (
                []
              )}
            </ZoneBox>
          </div>

          <div ref={paletteRef} className={`drop-zone-box ${paletteOver ? 'drop-zone-box-over' : ''}`}>
            {palette.length === 0 ? (
              <span className="muted text-xs px-1">All fields are in use — drop a chip here to release it.</span>
            ) : (
              palette.map((field) => (
                <FieldChip key={field} field={field} type={typeIndex.get(field)} from="palette" />
              ))
            )}
          </div>

          <p className="muted text-xs">
            {config.value ? (
              <>
                <span className="font-semibold text-slate-700 dark:text-slate-300">
                  {AGGS.find((agg) => agg.value === config.agg)?.label} of {config.value}
                </span>
                {' · '}
                {valueType !== 'number' && config.agg !== 'count'
                  ? 'non-numeric value field – counting rows instead'
                  : `${dataset.rows.length.toLocaleString()} source rows`}
              </>
            ) : (
              `Counting rows · ${dataset.rows.length.toLocaleString()} source rows`
            )}
          </p>
        </div>
      </DndContext>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 border-b border-[var(--u2s-border)]">
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={downloadPivotCsv}>
              Download CSV
            </button>
            <button className="btn btn-secondary" onClick={downloadPivotXlsx}>
              Download XLSX
            </button>
          </div>
          <span className="muted text-xs">
            {pivot.rowLabels.length.toLocaleString()} × {pivot.columns.length || 1} pivot grid
          </span>
        </div>
        <div className="grid-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                {(pivot.rowFields.length > 0 ? pivot.rowFields : ['Rows']).map((field) => (
                  <th key={field}>{field}</th>
                ))}
                {pivot.columns.map((column) => (
                  <th key={column} className="text-right">
                    {column}
                  </th>
                ))}
                <th className="text-right">Grand total</th>
              </tr>
            </thead>
            <tbody>
              {pivot.rowLabels.map((labels, rowIndex) => (
                <tr key={labels.join('|') || `row-${rowIndex}`}>
                  {labels.map((label, labelIndex) => (
                    <td key={`${label}-${labelIndex}`}>{label}</td>
                  ))}
                  {pivot.cells[rowIndex].map((value, columnIndex) => (
                    <td key={columnIndex} className="text-right mono-num">
                      {value === null ? <span className="text-slate-300 dark:text-slate-600">—</span> : numberFormat.format(value)}
                    </td>
                  ))}
                  <td className="text-right mono-num font-semibold">
                    {pivot.rowTotals[rowIndex] === null ? '—' : numberFormat.format(pivot.rowTotals[rowIndex] as number)}
                  </td>
                </tr>
              ))}
              <tr className="font-bold bg-slate-50 dark:bg-slate-900">
                <td>Total</td>
                {pivot.rowFields.slice(1).map((field) => (
                  <td key={field} />
                ))}
                {pivot.colTotals.map((value, index) => (
                  <td key={index} className="text-right mono-num">
                    {value === null ? '—' : numberFormat.format(value)}
                  </td>
                ))}
                <td className="text-right mono-num">
                  {pivot.grandTotal === null ? '—' : numberFormat.format(pivot.grandTotal)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
