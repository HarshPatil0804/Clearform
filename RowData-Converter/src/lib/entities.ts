import type { Cell } from '../types';
import { cleanText } from './strings';

export interface EntityPattern {
  key: string;
  label: string;
  regex: RegExp;
  /** Entity rows must match at least this often to earn a column (fraction of matching rows). */
  minHits?: number;
}

/** Regex-based entities used when free text has to be turned into columns. */
export const ENTITY_PATTERNS: EntityPattern[] = [
  { key: 'email', label: 'email', regex: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/g },
  { key: 'url', label: 'url', regex: /\bhttps?:\/\/[^\s,;"')]+/g },
  {
    key: 'uuid',
    label: 'uuid',
    regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  { key: 'reference', label: 'id', regex: /\b[A-Z]{2,6}[-_/]\d{2,}(?:[-_/]\d{1,})?\b/g },
  {
    key: 'amount',
    label: 'amount',
    regex: /(?:[$€£¥₹]\s?\d[\d.,]*|\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b)/g,
  },
  {
    key: 'phone',
    label: 'phone',
    regex: /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b/g,
  },
];

export interface EntityHit {
  key: string;
  value: string;
}

/** Return all entity matches inside a piece of text (first match per pattern). */
export function findEntities(text: string): EntityHit[] {
  const hits: EntityHit[] = [];
  for (const pattern of ENTITY_PATTERNS) {
    pattern.regex.lastIndex = 0;
    const match = pattern.regex.exec(text);
    if (match) hits.push({ key: pattern.key, value: match[0].trim() });
  }
  return hits;
}

/**
 * Pick entity columns for a set of free-text rows: a pattern only earns a
 * column when at least 2 different rows contain a match (except `email` and
 * `url`, which are unambiguous enough at one hit).
 */
export function selectEntityColumns(rows: string[]): Map<string, (row: string) => string | null> {
  const selected = new Map<string, (row: string) => string | null>();
  for (const pattern of ENTITY_PATTERNS) {
    const matches: string[] = [];
    for (const row of rows) {
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(row);
      if (match) matches.push(match[0].trim());
    }
    const unique = new Set(matches);
    const always = pattern.key === 'email' || pattern.key === 'url';
    if (unique.size >= 2 || (always && unique.size >= 1)) {
      selected.set(pattern.key, (row: string) => {
        pattern.regex.lastIndex = 0;
        const match = pattern.regex.exec(row);
        return match ? match[0].trim() : null;
      });
    }
  }
  return selected;
}

/** Normalise a cell to trimmed text (helper shared by extractors). */
export function asText(value: Cell): string {
  if (value === null || value === undefined) return '';
  return cleanText(String(value)).trim();
}
