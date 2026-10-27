import JSZip from 'jszip';

export interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

const MAX_ENTRIES = 200;
const MAX_UNCOMPRESSED = 300 * 1024 * 1024; // guard against zip bombs

/** Read every regular file from a ZIP archive (nested archives handled by the orchestrator). */
export async function extractArchive(bytes: Uint8Array): Promise<ArchiveEntry[]> {
  let zip: import('jszip');
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ZIP archive: ${message}`);
  }

  const entries: ArchiveEntry[] = [];
  let total = 0;

  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    const segments = file.name.split('/');
    const base = segments[segments.length - 1];
    if (segments.includes('__MACOSX') || base.startsWith('.')) continue;
    if (entries.length >= MAX_ENTRIES) break;

    const data = await file.async('uint8array');
    total += data.byteLength;
    if (total > MAX_UNCOMPRESSED) {
      throw new Error('ZIP archive exceeds the 300 MB uncompressed limit');
    }
    entries.push({ name: file.name, bytes: data });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}
