import type { Extraction } from '../../types';
import { cleanText } from '../../lib/strings';

/**
 * Minimal but pragmatic RTF reader: drops destination groups ({\*\...}),
 * decodes \'xx escapes and control words, and keeps the visible text.
 */
export function rtfToText(rtf: string): string {
  let out = '';

  // 1. Remove control words that introduce suppressed destinations.
  let i = 0;
  const n = rtf.length;
  let depth = 0;
  let skipDepth = -1;

  while (i < n) {
    const char = rtf[i];

    if (char === '{') {
      // Is this a destination group like {\*\generator ...}?
      const isDestination = rtf[i + 1] === '\\' && rtf[i + 2] === '*';
      depth += 1;
      if (isDestination && skipDepth === -1) skipDepth = depth;
      i += 1;
      continue;
    }
    if (char === '}') {
      if (skipDepth === depth) skipDepth = -1;
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (skipDepth !== -1) {
      i += 1;
      continue;
    }

    if (char === '\\') {
      const next = rtf[i + 1];
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        const code = Number.parseInt(hex, 16);
        if (Number.isFinite(code)) out += String.fromCharCode(code);
        i += 4;
        continue;
      }
      if (next === '\\' || next === '{' || next === '}') {
        out += next;
        i += 2;
        continue;
      }
      if (next === '~') {
        out += ' ';
        i += 2;
        continue;
      }
      if (next === '_') {
        out += '-';
        i += 2;
        continue;
      }
      if (next === '-' || next === '_') {
        out += next;
        i += 2;
        continue;
      }
      if (next === '\n' || next === '\r') {
        out += '\n';
        i += 2;
        continue;
      }
      const word = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i));
      if (word) {
        const name = word[1];
        if (name === 'par' || name === 'line' || name === 'newline' || name === 'sect' || name === 'page') {
          out += '\n';
        } else if (name === 'tab') {
          out += '\t';
        }
        // uNNNN unicode escapes: keep the character, skip the optional fallback.
        if (name === 'u') {
          const code = Number(word[2]);
          if (Number.isFinite(code)) out += String.fromCharCode(code < 0 ? code + 65536 : code);
          const fallback = /^\\'[0-9a-fA-F]{2}/.exec(rtf.slice(i + word[0].length));
          if (fallback) i += word[0].length + fallback[0].length;
          else i += word[0].length;
          continue;
        }
        i += word[0].length;
        continue;
      }
      i += 1;
      continue;
    }

    out += char;
    i += 1;
  }

  return out
    .split(/\r?\n/)
    .map((line) => cleanText(line).trim())
    .filter((line) => line !== '')
    .join('\n');
}

export function rtfToExtraction(rtf: string, source: string): Extraction {
  const text = rtfToText(rtf);
  if (!text.trim()) {
    return { kind: 'text', source, text: '', strategy: 'RTF document', notes: ['no visible text in RTF'] };
  }
  return { kind: 'text', source, text, strategy: 'RTF document', notes: ['RTF control words stripped'] };
}
