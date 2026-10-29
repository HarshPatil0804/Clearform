import type { Cell } from '../types';
import { looksLikeDate } from '../lib/dates';

/**
 * R2 – identifier columns.
 *
 * "70001", "#70004", "VIS-70006" and "VIS-70006 DUPLICATE?" all describe the
 * same kind of thing. The core digits stay in the column, the untouched value
 * is kept in `<col>_raw`, and any trailing annotation ("DUPLICATE?") moves to
 * `<col>_tag` so it can be filtered instead of polluting the key.
 *
 * The detector has to be strict: dates, currency, phones and prose all contain
 * digit runs too. A column only qualifies when ALL of the following hold:
 *
 *  1. it is not a date column (R3 owns dates);
 *  2. most values are one digit run plus decoration;
 *  3. at least 10% of the values carry noise;
 *  4. that decoration never contains digits – in "$19.99" or "2025-06-01" the
 *     digits are part of the value, in "#70004" the "#" is noise;
 *  5. digits dominate the value (≥50% of its characters), so prose such as
 *     "Server started on port 8080" never qualifies;
 *  6. the decoration varies across values ("variable prefixes or noise") – a
 *     column where every row is "W-1001" is already consistent and needs no
 *     raw copy.
 */

/** `visit_id`, `order-no`, `ref`, `sku_code` … */
const ID_NAME_RE = /(?:^|[_ -])(id|ids|no|num|number|code|key|ref)(?:$|[_ -])/i;

const SAMPLE_LIMIT = 1000;
/** Share of values that must parse as dates before the column is "a date". */
const DATE_RATIO = 0.6;
/** Share of decorated values whose decoration may contain digits. */
const DIGIT_DECOR_RATIO = 0.2;
/** Share of values whose digit density must reach MIN_DIGIT_DENSITY. */
const DENSE_RATIO = 0.6;
const MIN_DIGIT_DENSITY = 0.5;

export interface IdParts {
  prefix: string;
  core: string;
  suffix: string;
}

function stringsOf(values: Cell[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text !== '') out.push(text);
  }
  return out;
}

/** Evenly strided sub-sample so 50M-row files stay cheap to inspect. */
function sampleOf(texts: string[]): string[] {
  if (texts.length <= SAMPLE_LIMIT) return texts;
  const step = texts.length / SAMPLE_LIMIT;
  const out: string[] = [];
  for (let i = 0; i < SAMPLE_LIMIT; i += 1) out.push(texts[Math.floor(i * step)]);
  return out;
}

/** Split an identifier into noise prefix, core digits and trailing tag. */
export function parseId(value: Cell): IdParts | null {
  if (value === null || value === undefined || typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;

  const runs = [...text.matchAll(/\d+/g)];
  if (runs.length === 0) return null;
  let best = runs[0];
  for (const run of runs) {
    if (run[0].length > best[0].length) best = run;
  }
  const start = best.index ?? 0;
  return {
    prefix: text.slice(0, start),
    core: best[0],
    suffix: text.slice(start + best[0].length).trim(),
  };
}

function decorationOf(part: IdParts): string {
  return `${part.prefix}${part.suffix}`;
}

function digitDensity(part: IdParts): number {
  const length = part.prefix.length + part.core.length + part.suffix.length;
  return length === 0 ? 0 : part.core.length / length;
}

/**
 * True when a column holds identifiers wrapped in variable noise.
 * See the block comment above for the six conditions checked here.
 */
export function isIdColumn(name: string, values: Cell[]): boolean {
  const texts = stringsOf(values);
  if (texts.length === 0) return false;
  const sample = sampleOf(texts);

  // 1. dates are R3's job, never R2's.
  const dateLike = sample.filter((text) => looksLikeDate(text)).length;
  if (dateLike / sample.length >= DATE_RATIO) return false;

  const parts: IdParts[] = [];
  for (const text of sample) {
    const parsed = parseId(text);
    if (parsed) parts.push(parsed);
  }
  // 2. most values must be "one digit run plus decoration".
  if (parts.length / sample.length < 0.6) return false;

  // 3. there has to be noise worth stripping.
  const decorated = parts.filter((part) => part.prefix !== '' || part.suffix !== '');
  if (decorated.length / sample.length < 0.1) return false;

  // 4. decoration is letters/symbols only – digits belong to the value.
  const digitDecorated = decorated.filter((part) => /\d/.test(decorationOf(part))).length;
  if (digitDecorated / decorated.length >= DIGIT_DECOR_RATIO) return false;

  // 5. digits dominate, so prose and measurements never qualify.
  const dense = parts.filter((part) => digitDensity(part) >= MIN_DIGIT_DENSITY).length;
  if (dense / sample.length < DENSE_RATIO) return false;

  // 6. "variable prefixes or noise" – a column where every value is decorated
  // ("W-1001", "G-2002") has one consistent shape and needs no raw copy, while
  // a mix of bare and decorated values ("70001", "#70004", "VIS-70006") is
  // genuinely noisy. An id-named column skips this check so "visit_id" still
  // normalises even when a file prefixes every row the same way.
  const bare = parts.length - decorated.length;
  const idNamed = ID_NAME_RE.test(name);
  if (!idNamed && bare / sample.length < 0.1) return false;

  const noisy = decorated.length / sample.length;
  return idNamed ? noisy >= 0.1 : noisy >= 0.25;
}

export interface IdColumnResult {
  /** Core value for every row (null when the cell was empty). */
  core: Cell[];
  /** Untouched original for every row. */
  raw: Cell[];
  /** Trailing annotation for every row (null when there is none). */
  tag: Cell[];
  /** true when at least one row carried a tag worth its own column. */
  hasTags: boolean;
  /** Rows whose prefix/tag differed from the bare value. */
  normalised: number;
}

export function normalizeIdColumn(values: Cell[]): IdColumnResult {
  const core: Cell[] = [];
  const raw: Cell[] = [];
  const tag: Cell[] = [];
  let hasTags = false;
  let normalised = 0;

  for (const value of values) {
    const parsed = parseId(value);
    if (!parsed) {
      core.push(value ?? null);
      raw.push(value ?? null);
      tag.push(null);
      continue;
    }
    const original = typeof value === 'string' ? value.trim() : String(value);
    core.push(parsed.core);
    raw.push(original);
    if (parsed.suffix !== '') {
      tag.push(parsed.suffix);
      hasTags = true;
    } else {
      tag.push(null);
    }
    if (parsed.prefix !== '' || parsed.suffix !== '') normalised += 1;
  }

  return { core, raw, tag, hasTags, normalised };
}
