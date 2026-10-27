import type { Cell, Extraction } from '../../types';
import { cleanText } from '../../lib/strings';

/**
 * RFC-822 / MIME email reader: headers, multipart bodies, base64 and
 * quoted-printable decoding. An .eml file becomes one record; an mbox-style
 * file (several "From " separator lines) becomes one record per message.
 */

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function decodeBase64(input: string): string {
  const clean = input.replace(/\s+/g, '');
  try {
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return decodeUtf8(bytes);
  } catch {
    return '';
  }
}

export function decodeQuotedPrintable(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '=' && /^[0-9a-fA-F]{2}$/.test(input.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(input.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (char === '=' && input[i + 1] === '\n') {
      i += 1;
    } else if (char === '=' && input[i + 1] === '\r' && input[i + 2] === '\n') {
      i += 2;
    } else {
      bytes.push(char.charCodeAt(0) & 0xff);
    }
  }
  return decodeUtf8(new Uint8Array(bytes));
}

/** =?UTF-8?B?…?= / =?UTF-8?Q?…?= encoded words in headers. */
function decodeEncodedWord(input: string): string {
  return input.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_match, _charset: string, encoding: string, payload: string) => {
    if (encoding.toLowerCase() === 'b') return decodeBase64(payload);
    return decodeQuotedPrintable(payload.replace(/_/g, ' '));
  });
}

function splitHeadersAndBody(raw: string): { headers: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const boundary = normalized.indexOf('\n\n');
  const head = boundary === -1 ? normalized : normalized.slice(0, boundary);
  const body = boundary === -1 ? '' : normalized.slice(boundary + 2);

  const headers: Record<string, string> = {};
  const lines = head.split('\n');
  let currentKey = '';
  for (const line of lines) {
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] = `${headers[currentKey]} ${line.trim()}`;
      continue;
    }
    const match = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/.exec(line);
    if (match) {
      currentKey = match[1].toLowerCase();
      headers[currentKey] = match[2].trim();
    }
  }
  return { headers, body };
}

function pickTextPart(body: string, contentType: string): string {
  const boundaryMatch = /boundary\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  if (!boundaryMatch) return body;

  const marker = `--${boundaryMatch[1]}`;
  const parts = body.split(marker);
  let fallback = '';
  for (const part of parts) {
    if (part.startsWith('--') || part.trim() === '') continue;
    const { headers, body: partBody } = splitHeadersAndBody(part.replace(/^\n/, ''));
    const type = headers['content-type'] ?? '';
    if (/multipart\//i.test(type)) {
      const nested = pickTextPart(partBody, type);
      if (nested.trim()) return nested;
      continue;
    }
    if (!fallback) fallback = decodeBody(partBody, headers);
    if (/text\/plain/i.test(type) || !type) {
      const decoded = decodeBody(partBody, headers);
      if (decoded.trim()) return decoded;
    }
  }
  return fallback;
}

function decodeBody(body: string, headers: Record<string, string>): string {
  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase().trim();
  if (encoding === 'base64') return decodeBase64(body);
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function parseMessage(raw: string): Record<string, Cell> {
  const { headers, body } = splitHeadersAndBody(raw);
  const contentType = headers['content-type'] ?? '';
  let text = /multipart\//i.test(contentType) ? pickTextPart(body, contentType) : decodeBody(body, headers);
  text = text.replace(/\r\n/g, '\n').trim();

  const record: Record<string, Cell> = {
    from: decodeEncodedWord(headers.from ?? ''),
    to: decodeEncodedWord(headers.to ?? ''),
    subject: decodeEncodedWord(headers.subject ?? ''),
    date: headers.date ?? '',
    message_id: headers['message-id'] ?? '',
    content_type: contentType.split(';')[0].trim(),
    body_lines: text ? text.split('\n').length : 0,
    body: cleanText(text).replace(/\n{3,}/g, '\n\n'),
  };
  if (headers.cc) record.cc = decodeEncodedWord(headers.cc);
  if (headers.reply_to) record.reply_to = decodeEncodedWord(headers.reply_to);
  return record;
}

export function emlToExtraction(raw: string, source: string): Extraction {
  const notes: string[] = [];
  const normalized = raw.replace(/\r\n/g, '\n');

  // mbox: several messages separated by "From " lines.
  const separators = normalized.match(/^From .*$/gm);
  let messages: string[];
  if (separators && separators.length >= 2) {
    messages = normalized.split(/^From .*$/m).filter((chunk) => chunk.trim() !== '');
    notes.push(`mbox: ${messages.length} messages`);
  } else {
    messages = [normalized];
  }

  const records = messages.map((message) => parseMessage(message));
  const nonEmpty = records.filter((record) => record.subject !== '' || record.from !== '' || record.body !== '');
  if (nonEmpty.length === 0) {
    throw new Error('No email headers or body could be read');
  }
  notes.push(`${nonEmpty.length} message(s) parsed`);

  return {
    kind: 'records',
    source,
    records: nonEmpty,
    strategy: 'RFC-822 email',
    notes,
  };
}
