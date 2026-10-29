/** A single cell value after cleaning. */
export type Cell = string | number | boolean | null;

export type ColumnType = 'number' | 'date' | 'boolean' | 'text';

/** Aggregations supported by the pivot builder. */
export type Aggregation = 'sum' | 'count' | 'avg' | 'min' | 'max';

/** A table that has rows/columns but has not been cleaned yet. */
export interface RawTable {
  columns: string[];
  rows: Cell[][];
  /**
   * true  → the first row was recognised as a header by the extractor
   * false → every row is data
   * null  → unknown; the cleaning stage decides
   */
  hasHeader: boolean | null;
  /** Human readable label of how the data was obtained, e.g. "CSV · delimiter ','". */
  strategy: string;
  notes: string[];
}

/** Intermediate output of every extractor. */
export type Extraction =
  | {
      kind: 'table';
      source: string;
      columns: string[];
      rows: Cell[][];
      /** true when the extractor pulled a real header row out of the source. */
      hasHeader?: boolean;
      strategy: string;
      notes: string[];
    }
  | { kind: 'records'; source: string; records: Record<string, Cell>[]; strategy: string; notes: string[] }
  | { kind: 'text'; source: string; text: string; strategy: string; notes: string[] };

/**
 * R1 – a row pulled out of the data before cleaning, kept with the reason it
 * was rejected. Rejected rows are never deleted silently: they are shown in
 * the "Rejected rows" table and exported with the workbook.
 */
export interface RejectedRow {
  /** Machine readable reason, e.g. "error row", "summary/total line". */
  reason: string;
  /** The row exactly as it was parsed. */
  values: Cell[];
}

/** R6 – one before → after value normalisation, kept for the report. */
export interface ValueMapping {
  column: string;
  from: string;
  to: string;
  /** How many cells carried `from`. */
  count: number;
}

/** R10 – the parsed total compared with the total reported in the file. */
export interface Reconciliation {
  /** Column whose values were summed. */
  column: string;
  /** Sum of the parsed column. */
  parsed: number;
  /** Total read from the file's summary/total line, when there is one. */
  reported: number | null;
  /** parsed − reported (null when there is nothing to compare). */
  difference: number | null;
  /** The raw summary line the reported total came from. */
  source: string | null;
  /** true when the two agree within a cent, null when unverifiable. */
  matches: boolean | null;
}

export interface ColumnMeta {
  name: string;
  type: ColumnType;
  /** Missing values after sentinel normalisation. */
  nulls: number;
  /** Missing values filled with the column mode (text columns only, small gaps). */
  filled: number;
  unique: number;
  /** IQR outliers that were flagged but never removed. */
  outliers: number;
  /** Values converted into the column type (dates → ISO, numbers, categories). */
  conversions: number;
  examples: Cell[];
}

export interface FileReport {
  fileName: string;
  sourceType: string;
  strategy: string;
  rowsIn: number;
  rowsOut: number;
  columnsIn: number;
  columnsOut: number;
  duplicatesRemoved: number;
  emptyRowsDropped: number;
  emptyColumnsDropped: number;
  /** Sentinel strings ("N/A", "-", "null"…) converted to real nulls. */
  nullsFixed: number;
  /** Missing text values filled with the column mode. */
  valuesFilled: number;
  outliersFlagged: number;
  headerDetected: boolean;
  generatedHeaders: string[];
  /** R1 – rows moved to the "Rejected rows" table. */
  rejectedCount: number;
  /** R1 – rejection reasons with their counts. */
  rejectedReasons: { reason: string; count: number }[];
  /** R3 – number of date values whose day/month order could not be proven. */
  ambiguousDates: number;
  /** R9/R7 – flag columns with the number of rows they flag. */
  flagCounts: { name: string; count: number }[];
  /** R6 – before → after value normalisations. */
  mappings: ValueMapping[];
  /** R10 – parsed vs reported total. */
  reconciliation: Reconciliation | null;
  /** Date found in the file's export/generated metadata line. */
  exportDate: string | null;
  notes: string[];
}

export interface QualityReport extends FileReport {
  /** One entry per source file (zip entries count separately). */
  files: FileReport[];
  /** Columns produced by type inference and standardisation. */
  columns: ColumnMeta[];
}

export interface Dataset {
  columns: string[];
  types: ColumnType[];
  rows: Cell[][];
  /** R1 – rows set aside with the reason they were rejected. */
  rejected: RejectedRow[];
  /** Names of the flag columns present (R7 system flag + R9 logic flags). */
  flagColumns: string[];
  report: QualityReport;
}

export interface ProgressUpdate {
  /** 0…100 */
  pct: number;
  stage: 'detect' | 'extract' | 'structure' | 'clean' | 'report' | 'done';
  message: string;
}

export type PivotConfig = {
  rows: string[];
  cols: string[];
  value: string;
  agg: Aggregation;
};