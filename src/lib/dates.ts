import type { Cell } from '../types';
import { cleanText } from './strings';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 100) year += 2000;
  if (year < 1500 || year > 2999) return null;
  if (day > daysInMonth(year, month)) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Parse a date-ish value into ISO-8601.
 * - date only → YYYY-MM-DD
 * - date + time without offset → YYYY-MM-DDTHH:mm:ss
 * - date + time with Z/offset → real UTC ISO string
 * Returns null when the value is not a date. Ambiguous day/month pairs
 * (e.g. 03/04/2024) are read day-first.
 */
export function parseDateValue(value: Cell): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return null;

  const s = cleanText(value).trim();
  if (!s || s.length > 40) return null;

  // ISO-ish: 2024-01-05, 2024-01-05 10:30, 2024-01-05T10:30:00Z, 2024-01-05T10:30:00+05:30
  const iso = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/,
  );
  if (iso) {
    const [, y, mo, d, hh, mm, ss, off] = iso;
    const date = buildDate(Number(y), Number(mo), Number(d));
    if (!date) return null;
    if (!hh) return date;
    const time = `${pad(Number(hh))}:${pad(Number(mm))}:${pad(Number(ss ?? '0'))}`;
    if (!off) return `${date}T${time}`;
    if (off === 'Z') return `${date}T${time}Z`;
    const normalized = off.length === 5 ? `${off.slice(0, 3)}:${off.slice(3)}` : off;
    return `${date}T${time}${normalized}`;
  }

  // 2024/01/05
  const slashIso = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (slashIso) {
    const date = buildDate(Number(slashIso[1]), Number(slashIso[2]), Number(slashIso[3]));
    if (!date) return null;
    if (!slashIso[4]) return date;
    return `${date}T${pad(Number(slashIso[4]))}:${pad(Number(slashIso[5]))}:${pad(Number(slashIso[6] ?? '0'))}`;
  }

  // 05/01/2024 · 05-01-2024 · 05.01.2024  (day-first unless the 2nd part > 12)
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (dmy) {
    let first = Number(dmy[1]);
    let second = Number(dmy[2]);
    if (first > 12 && second <= 12) {
      // definitely day-first
    } else if (second > 12 && first <= 12) {
      // definitely month-first (e.g. 3/25/2024)
      [first, second] = [second, first];
    } else if (second > 12 && first > 12) {
      return null;
    } else {
      // ambiguous → day-first (documented in README)
    }
    const date = buildDate(Number(dmy[3]), second, first);
    if (!date) return null;
    const time = s.match(/(?:[ ,]+)(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (time) return `${date}T${pad(Number(time[1]))}:${pad(Number(time[2]))}:${pad(Number(time[3] ?? '0'))}`;
    return date;
  }

  // Month-name dates: Jan 5, 2024 / 5 Jan 2024 / 05-Jan-2024 / Jan 2024
  const lower = s.replace(/,/g, '').toLowerCase();
  const named = lower.match(/^([a-z]{3,9})\s+(\d{1,2})\s+(\d{4})$/);
  if (named && MONTHS[named[1]]) {
    const date = buildDate(Number(named[3]), MONTHS[named[1]], Number(named[2]));
    if (date) return date;
  }
  const named2 = lower.match(/^(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})$/);
  if (named2 && MONTHS[named2[2]]) {
    const date = buildDate(Number(named2[3]), MONTHS[named2[2]], Number(named2[1]));
    if (date) return date;
  }
  const named3 = lower.match(/^(\d{1,2})[- ]([a-z]{3,9})[- ](\d{4})$/);
  if (named3 && MONTHS[named3[2]]) {
    const date = buildDate(Number(named3[3]), MONTHS[named3[2]], Number(named3[1]));
    if (date) return date;
  }
  const monthYear = lower.match(/^([a-z]{3,9})\s+(\d{4})$/);
  if (monthYear && MONTHS[monthYear[1]]) {
    const date = buildDate(Number(monthYear[2]), MONTHS[monthYear[1]], 1);
    if (date) return date;
  }

  return null;
}

export function looksLikeDate(value: string): boolean {
  return parseDateValue(value) !== null;
}

/** JS Date → ISO string (date only when the time is midnight). */
export function formatJsDate(value: Date): string | null {
  if (Number.isNaN(value.getTime())) return null;
  const hasTime = value.getUTCHours() || value.getUTCMinutes() || value.getUTCSeconds();
  const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  return hasTime
    ? `${date}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`
    : date;
}

/** Excel serial date (1899-12-30 epoch) → ISO date/datetime. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const hasTime = Math.abs(serial - Math.trunc(serial)) > 1e-9;
  const isoDate = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (!hasTime) return isoDate;
  return `${isoDate}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
