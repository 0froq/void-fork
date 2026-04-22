import { parseArgs } from 'node:util';

export interface PrepareArgs {}

export function parsePrepareArgs(args: Array<string>): PrepareArgs {
  const parsed = parseArgs({
    args,
    options: {},
    allowPositionals: true,
    strict: true,
  });

  if (parsed.positionals.length > 0) {
    throw new Error(`Error: Unexpected argument for prepare: ${parsed.positionals[0]}`);
  }

  return {};
}
