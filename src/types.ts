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
