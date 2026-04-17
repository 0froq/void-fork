/**
 * Char-by-char SQL tokenizer shared by the destructive-SQL guard
 * (projects.ts) and the single-statement classifier (remote-runner.ts).
 *
 * Walks the input and yields contiguous segments. `sql` runs are
 * emitted as `{ kind: 'sql', start, end }` so callers can `sql.slice`
 * without character-by-character allocations. Special regions are
 * yielded whole with their delimiters included in `[start, end)`.
 *
 * Lexical forms handled (SQLite / drizzle-kit SQLite output):
 *   - `-- line`            line comments (terminate at `\n` or EOF)
 *   - `/* block *​/`        block comments (tolerate unterminated — span to EOF)
 *   - `'...'`              string literals with `''` doubled-quote escape
 *   - `"..."` / `` `...` `` identifier quotes with `""` / `` `` `` escape
 *   - `[...]`              bracket identifiers, NO `]]` escape — a single
 *                          `]` closes the identifier (SQLite semantics;
 *                          differs from MS SQL)
 *
 * Not handled — intentional, both current callers target SQLite only:
 *   - Postgres `$tag$ ... $tag$` dollar-quoting
 *   - Postgres `E'...'` extended string literals
 *
 * Adding a new quoting form anywhere should land here so both callers
 * stay in lockstep.
 */

export type SqlSegment =
  | { kind: 'sql'; start: number; end: number }
  | { kind: 'line-comment'; start: number; end: number }
  | { kind: 'block-comment'; start: number; end: number }
  | { kind: 'string'; start: number; end: number }
  | { kind: 'ident-quote'; open: '"' | '`' | '['; start: number; end: number };

export function* tokenizeSql(sql: string): Generator<SqlSegment> {
  const n = sql.length;
  let i = 0;
  let runStart = 0;

  const flushRun = (upTo: number): SqlSegment | undefined => {
    if (upTo > runStart) {
      return { kind: 'sql', start: runStart, end: upTo };
    }
    return undefined;
  };

  while (i < n) {
    const c = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    if (c === '-' && next === '-') {
      const run = flushRun(i);
      if (run) {
        yield run;
      }
      let j = i + 2;
      while (j < n && sql[j] !== '\n') {
        j++;
      }
      yield { kind: 'line-comment', start: i, end: j };
      i = j;
      runStart = i;
      continue;
    }

    if (c === '/' && next === '*') {
      const run = flushRun(i);
      if (run) {
        yield run;
      }
      let j = i + 2;
      while (j < n - 1 && !(sql[j] === '*' && sql[j + 1] === '/')) {
        j++;
      }
      const end = Math.min(j + 2, n);
      yield { kind: 'block-comment', start: i, end };
      i = end;
      runStart = i;
      continue;
    }

    if (c === "'") {
      const run = flushRun(i);
      if (run) {
        yield run;
      }
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      yield { kind: 'string', start: i, end: j };
      i = j;
      runStart = i;
      continue;
    }

    if (c === '"' || c === '`' || c === '[') {
      const run = flushRun(i);
      if (run) {
        yield run;
      }
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < n) {
        if (close !== ']' && sql[j] === close && sql[j + 1] === close) {
          j += 2;
          continue;
        }
        if (sql[j] === close) {
          j++;
          break;
        }
        j++;
      }
      yield { kind: 'ident-quote', open: c as '"' | '`' | '[', start: i, end: j };
      i = j;
      runStart = i;
      continue;
    }

    i++;
  }

  const tail = flushRun(n);
  if (tail) {
    yield tail;
  }
}
