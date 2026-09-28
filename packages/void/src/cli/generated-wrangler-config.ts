import { readFileSync } from 'node:fs';
import { parse, type ParseError } from 'jsonc-parser';

/** Parse a generated Wrangler JSON/JSONC config without accepting a partial parse. */
export function readGeneratedWranglerConfigFile(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8');
  const content = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const errors: Array<ParseError> = [];
  const parsed: unknown = parse(content, errors, { allowTrailingComma: true });
  if (errors.length > 0 || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Wrangler JSON/JSONC config.');
  }
  return parsed as Record<string, unknown>;
}
