declare module 'mammoth' {
  interface MammothResult {
    value: string;
    messages: unknown[];
  }
  interface Input {
    buffer: ArrayBuffer | Uint8Array;
  }
  export function convertToHtml(input: Input, options?: Record<string, unknown>): Promise<MammothResult>;
  export function extractRawText(input: Input): Promise<MammothResult>;
}
