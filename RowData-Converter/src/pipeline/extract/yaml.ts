import { load } from 'js-yaml';
import type { Extraction } from '../../types';
import { jsonValueToExtraction } from './json';

export function yamlToExtraction(text: string, source: string): Extraction {
  let value: unknown;
  try {
    value = load(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid YAML: ${message}`);
  }
  if (value === null || value === undefined) {
    throw new Error('YAML document is empty');
  }
  return jsonValueToExtraction(value, source, 'YAML document');
}
