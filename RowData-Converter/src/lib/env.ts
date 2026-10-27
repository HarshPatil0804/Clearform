/** True when running under Node (Vitest), false in the browser/worker. */
export function isNodeRuntime(): boolean {
  return (
    typeof process !== 'undefined' &&
    typeof (process as { versions?: { node?: string } }).versions?.node === 'string'
  );
}

/** True when a DOMParser is available (browser + jsdom). */
export function hasDomParser(): boolean {
  return typeof DOMParser !== 'undefined';
}
