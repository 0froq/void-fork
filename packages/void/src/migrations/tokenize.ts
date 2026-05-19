/**
 * SQLite-oriented SQL tokenizer shared by migration classification and
 * destructive validation. Keep behavior aligned with
 * packages/api/src/sql/tokenize.ts in the platform repo.
 */

export type SqlSegment =
  | { kind: 'sql'; start: number; end: number }
  | { kind: 'line-comment'; start: number; end: number }
  | { kind: 'block-comment'; start: number; end: number }
  | { kind: 'string'; start: number; end: number }
  | { kind: 'ident-quote'; open: '"' | '`' | '['; start: number; end: number };

export function* tokenizeSql(sql: string): Generator<SqlSegment> {
  const sqlLength = sql.length;
  let index = 0;
  let runStart = 0;

  const flushRun = (upTo: number): SqlSegment | undefined => {
    if (upTo > runStart) {
      return { kind: 'sql', start: runStart, end: upTo };
    }
    return undefined;
  };

  while (index < sqlLength) {
    const character = sql[index];
    const next = index + 1 < sqlLength ? sql[index + 1] : '';

    if (character === '-' && next === '-') {
      const run = flushRun(index);
      if (run) {
        yield run;
      }
      let scanIndex = index + 2;
      while (scanIndex < sqlLength && sql[scanIndex] !== '\n') {
        scanIndex++;
      }
      yield { kind: 'line-comment', start: index, end: scanIndex };
      index = scanIndex;
      runStart = index;
      continue;
    }

    if (character === '/' && next === '*') {
      const run = flushRun(index);
      if (run) {
        yield run;
      }
      let scanIndex = index + 2;
      while (scanIndex < sqlLength - 1 && !(sql[scanIndex] === '*' && sql[scanIndex + 1] === '/')) {
        scanIndex++;
      }
      const end = Math.min(scanIndex + 2, sqlLength);
      yield { kind: 'block-comment', start: index, end };
      index = end;
      runStart = index;
      continue;
    }

    if (character === "'") {
      const run = flushRun(index);
      if (run) {
        yield run;
      }
      let scanIndex = index + 1;
      while (scanIndex < sqlLength) {
        if (sql[scanIndex] === "'" && sql[scanIndex + 1] === "'") {
          scanIndex += 2;
          continue;
        }
        if (sql[scanIndex] === "'") {
          scanIndex++;
          break;
        }
        scanIndex++;
      }
      yield { kind: 'string', start: index, end: scanIndex };
      index = scanIndex;
      runStart = index;
      continue;
    }

    if (character === '"' || character === '`' || character === '[') {
      const run = flushRun(index);
      if (run) {
        yield run;
      }
      const close = character === '[' ? ']' : character;
      let scanIndex = index + 1;
      while (scanIndex < sqlLength) {
        if (close !== ']' && sql[scanIndex] === close && sql[scanIndex + 1] === close) {
          scanIndex += 2;
          continue;
        }
        if (sql[scanIndex] === close) {
          scanIndex++;
          break;
        }
        scanIndex++;
      }
      yield {
        kind: 'ident-quote',
        open: character as '"' | '`' | '[',
        start: index,
        end: scanIndex,
      };
      index = scanIndex;
      runStart = index;
      continue;
    }

    index++;
  }

  const tail = flushRun(sqlLength);
  if (tail) {
    yield tail;
  }
}
