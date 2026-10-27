export type SourceKind =
  | 'zip'
  | 'pdf'
  | 'image'
  | 'spreadsheet'
  | 'docx'
  | 'xml'
  | 'html'
  | 'json'
  | 'yaml'
  | 'delimited'
  | 'rtf'
  | 'eml'
  | 'text';

const EXTENSION_KIND: Record<string, SourceKind> = {
  csv: 'delimited',
  tsv: 'delimited',
  tab: 'delimited',
  txt: 'text',
  log: 'text',
  text: 'text',
  md: 'text',
  markdown: 'text',
  dat: 'text',
  out: 'text',
  conf: 'text',
  cfg: 'text',
  ini: 'text',
  props: 'text',
  json: 'json',
  jsonl: 'json',
  ndjson: 'json',
  jsonlines: 'json',
  xml: 'xml',
  xsd: 'xml',
  plist: 'xml',
  svg: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  html: 'html',
  htm: 'html',
  rtf: 'rtf',
  eml: 'eml',
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  xlsb: 'spreadsheet',
  xls: 'spreadsheet',
  ods: 'spreadsheet',
  docx: 'docx',
  docm: 'docx',
  dotx: 'docx',
  pdf: 'pdf',
  zip: 'zip',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
};

export function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (s: string) => Array.from(s).map((c) => c.charCodeAt(0));

export interface Detection {
  kind: SourceKind;
  extension: string;
  encoding: string;
  reason: string;
  mime: string;
}

/** Identify the source type from magic bytes, extension and content sniffing. */
export function detectSource(name: string, mime: string, bytes: Uint8Array): Detection {
  const extension = extensionOf(name);
  const extKind = EXTENSION_KIND[extension];
  const trimmed = (s: string) => s.replace(/^\uFEFF/, '').trimStart();

  // ---- magic bytes -------------------------------------------------------
  if (startsWith(bytes, ascii('%PDF-'))) {
    return { kind: 'pdf', extension, encoding: 'binary', reason: '%PDF- magic bytes', mime };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    if (extKind === 'spreadsheet' || extension === 'xlsx' || extension === 'xls' || extension === 'ods') {
      return { kind: 'spreadsheet', extension, encoding: 'binary', reason: 'ZIP container + spreadsheet extension', mime };
    }
    if (extKind === 'docx') {
      return { kind: 'docx', extension, encoding: 'binary', reason: 'ZIP container + Word extension', mime };
    }
    if (extension === 'zip' || !extKind) {
      return { kind: 'zip', extension, encoding: 'binary', reason: 'ZIP archive magic bytes', mime };
    }
    // A .csv renamed to .zip still wins for the archive magic — treat as archive.
    return { kind: 'zip', extension, encoding: 'binary', reason: 'ZIP archive magic bytes', mime };
  }
  if (startsWith(bytes, ascii('\x89PNG\r\n\x1a\n')) || startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return { kind: 'image', extension, encoding: 'binary', reason: 'image magic bytes', mime };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', extension, encoding: 'binary', reason: 'JPEG magic bytes', mime };
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) {
    return { kind: 'image', extension, encoding: 'binary', reason: 'WEBP magic bytes', mime };
  }
  if (startsWith(bytes, ascii('BM'))) {
    return { kind: 'image', extension, encoding: 'binary', reason: 'BMP magic bytes', mime };
  }

  // ---- BOM + text content ------------------------------------------------
  let offset = 0;
  let bomEncoding = '';
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    offset = 3;
    bomEncoding = 'utf-8';
  } else if (startsWith(bytes, [0xff, 0xfe])) {
    return { kind: extKind ?? 'text', extension, encoding: 'utf-16le', reason: 'UTF-16 LE BOM', mime };
  } else if (startsWith(bytes, [0xfe, 0xff])) {
    return { kind: extKind ?? 'text', extension, encoding: 'utf-16be', reason: 'UTF-16 BE BOM', mime };
  }

  const preview = decodePreview(bytes.subarray(offset, offset + 8192), bomEncoding || 'utf-8');
  const head = trimmed(preview);
  const headLower = head.slice(0, 400).toLowerCase();

  if (head.startsWith('{\\rtf')) {
    return { kind: 'rtf', extension, encoding: 'utf-8', reason: 'RTF magic header', mime };
  }
  if (head.startsWith('{') || head.startsWith('[')) {
    // Looks like JSON even if the extension says otherwise.
    if (!extKind || extKind === 'json' || extKind === 'text') {
      return { kind: 'json', extension, encoding: bomEncoding || 'utf-8', reason: 'content starts with JSON brace', mime };
    }
  }
  if (head.startsWith('<?xml')) {
    if (extKind === 'html') {
      return { kind: 'html', extension, encoding: bomEncoding || 'utf-8', reason: 'XML declaration + html extension', mime };
    }
    return { kind: 'xml', extension, encoding: bomEncoding || 'utf-8', reason: 'XML declaration', mime };
  }
  if (headLower.startsWith('<!doctype html') || headLower.startsWith('<html') || headLower.startsWith('<head') || headLower.startsWith('<body')) {
    return { kind: 'html', extension, encoding: bomEncoding || 'utf-8', reason: 'HTML root tags', mime };
  }
  if (/^Received:/im.test(head) && /^(From|To|Subject|Date|Message-ID|MIME-Version|Delivered-To):/im.test(head)) {
    return { kind: 'eml', extension, encoding: bomEncoding || 'utf-8', reason: 'RFC-822 headers', mime };
  }
  if (extKind === 'eml' || extKind === 'yaml') {
    return { kind: extKind, extension, encoding: bomEncoding || 'utf-8', reason: `file extension .${extension}`, mime };
  }

  if (mime.startsWith('image/')) {
    return { kind: 'image', extension, encoding: 'binary', reason: `MIME ${mime}`, mime };
  }

  if (extKind) {
    return { kind: extKind, extension, encoding: bomEncoding || 'utf-8', reason: `file extension .${extension}`, mime };
  }

  return { kind: 'text', extension, encoding: bomEncoding || 'utf-8', reason: 'plain text fallback', mime };
}

function decodePreview(bytes: Uint8Array, encodingHint: string): string {
  if (encodingHint === 'utf-16le' || encodingHint === 'utf-16be') {
    return new TextDecoder(encodingHint).decode(bytes);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Decode raw bytes to text: honour BOMs, detect UTF-16 by null bytes, verify
 * strict UTF-8 and fall back to windows-1252 for legacy files.
 */
export function decodeText(bytes: Uint8Array, hinted?: string): { text: string; encoding: string } {
  if (hinted === 'utf-16le') {
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  }
  if (hinted === 'utf-16be') {
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  }

  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;

  // UTF-16 without BOM: long runs of null bytes on alternating offsets.
  const probe = bytes.subarray(0, Math.min(bytes.length, 2000));
  let evenNulls = 0;
  let oddNulls = 0;
  for (let i = 0; i < probe.length; i += 1) {
    if (probe[i] === 0) {
      if (i % 2 === 0) evenNulls += 1;
      else oddNulls += 1;
    }
  }
  const ratio = probe.length ? Math.max(evenNulls, oddNulls) / probe.length : 0;
  if (ratio > 0.2) {
    const encoding = oddNulls > evenNulls ? 'utf-16le' : 'utf-16be';
    return { text: new TextDecoder(encoding).decode(bytes), encoding };
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start)), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes.subarray(start)), encoding: 'windows-1252' };
  }
}
