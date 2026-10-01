import { tokenizeSql } from './sql-tokenize.ts';

export const MIGRATION_CLASSIFIER_VERSION = 1;
export const UNSPLIT_MULTI_STATEMENT_PRAGMA = '-- void:allow-unsplit-multi-statement';

export type SqlMigrationClassification =
  | { kind: 'single-statement'; stability: 'stable' }
  | { kind: 'breakpoint-framed'; stability: 'stable'; statements: Array<string> }
  | { kind: 'legacy-unsplit-multi-statement'; stability: 'legacy'; allowLegacy: boolean };

export type MigrationPlanHashInput = SqlMigrationClassification & {
  name: string;
  dialect: 'sqlite';
  classifierVersion: number;
  sqlHash: string;
};

export function canonicalSql(sql: string): string {
  const withoutBom = sql.charCodeAt(0) === 0xfeff ? sql.slice(1) : sql;
  return withoutBom.replace(/\r\n?/g, '\n');
}

function isStandalonePragmaLine(line: string, pragma: string): boolean {
  return line.trim() === pragma;
}

export function hasStandalonePragma(sql: string, pragma: string): boolean {
  return canonicalSql(sql)
    .split('\n')
    .some((line) => isStandalonePragmaLine(line, pragma));
}

function isBreakpointComment(text: string): boolean {
  return text.trim() === '--> statement-breakpoint';
}

function splitBreakpointFramedSql(sql: string): Array<string> {
  const normalized = canonicalSql(sql);
  const statements: Array<string> = [];
  let cursor = 0;

  for (const segment of tokenizeSql(normalized)) {
    if (segment.kind !== 'line-comment') {
      continue;
    }
    const comment = normalized.slice(segment.start, segment.end);
    if (isBreakpointComment(comment)) {
      const statement = normalized.slice(cursor, segment.start).trim();
      if (statement) {
        statements.push(statement);
      }
      cursor = segment.end;
    }
  }

  const statement = normalized.slice(cursor).trim();
  if (statement) {
    statements.push(statement);
  }
  return statements;
}

function hasStatementBreakpointOutsideLiterals(sql: string): boolean {
  const normalized = canonicalSql(sql);
  for (const segment of tokenizeSql(normalized)) {
    if (segment.kind !== 'line-comment') {
      continue;
    }
    const comment = normalized.slice(segment.start, segment.end);
    if (isBreakpointComment(comment)) {
      return true;
    }
  }
  return false;
}

export function isSingleStatement(sql: string): boolean {
  const normalized = canonicalSql(sql);
  let statements = 0;
  let inStatement = false;

  for (const segment of tokenizeSql(normalized)) {
    if (segment.kind === 'line-comment' || segment.kind === 'block-comment') {
      continue;
    }
    if (segment.kind === 'string' || segment.kind === 'ident-quote') {
      inStatement = true;
      continue;
    }
    for (let index = segment.start; index < segment.end; index++) {
      const character = normalized[index];
      if (character === ';') {
        if (inStatement) {
          statements++;
          inStatement = false;
        }
        continue;
      }
      if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r') {
        inStatement = true;
      }
    }
  }

  if (inStatement) {
    statements++;
  }
  return statements === 1;
}

/** Classify SQL without imposing the caller's execution policy or hashing implementation. */
export function classifySqlMigration(sql: string): SqlMigrationClassification {
  if (hasStatementBreakpointOutsideLiterals(sql)) {
    return {
      kind: 'breakpoint-framed',
      stability: 'stable',
      statements: splitBreakpointFramedSql(sql),
    };
  }
  if (isSingleStatement(sql)) {
    return { kind: 'single-statement', stability: 'stable' };
  }
  return {
    kind: 'legacy-unsplit-multi-statement',
    stability: 'legacy',
    allowLegacy: hasStandalonePragma(sql, UNSPLIT_MULTI_STATEMENT_PRAGMA),
  };
}

/** Preserve the classifier-v1 hash preimage; policy markers and warnings are not hashed. */
export function getMigrationPlanHashInput(plan: MigrationPlanHashInput): unknown {
  const base: Record<string, unknown> = {
    classifierVersion: plan.classifierVersion,
    dialect: plan.dialect,
    kind: plan.kind,
    name: plan.name,
    sqlHash: plan.sqlHash,
    stability: plan.stability,
  };
  if (plan.kind === 'breakpoint-framed') {
    base.statements = plan.statements;
  }
  return base;
}
