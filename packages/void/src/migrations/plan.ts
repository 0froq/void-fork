import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';
import { tokenizeSql } from './tokenize.ts';

export const MIGRATION_CLASSIFIER_VERSION = 1;
export const UNSPLIT_MULTI_STATEMENT_PRAGMA = '-- void:allow-unsplit-multi-statement';
export const DESTRUCTIVE_PRAGMA = '-- void:allow-destructive';

export type MigrationExecutionPlan = {
  name: string;
  dialect: 'sqlite';
  classifierVersion: number;
  sqlHash: string;
  planHash: string;
  stability: 'stable' | 'legacy';
  warnings?: Array<string>;
} & (
  | {
      kind: 'single-statement';
    }
  | {
      kind: 'breakpoint-framed';
      statements: Array<string>;
    }
  | {
      kind: 'legacy-unsplit-multi-statement';
      allowLegacy: boolean;
    }
);

export type MigrationPlanBundle = {
  protocolVersion: 2;
  classifierVersion: number;
  migrationListHash: string;
  destructiveValidation: 'passed';
  plans: Array<MigrationExecutionPlan>;
};

type MigrationExecutionPlanInput = Omit<MigrationExecutionPlan, 'planHash' | 'warnings'> & {
  allowLegacy?: boolean;
  statements?: Array<string>;
};

export function canonicalSql(sql: string): string {
  const withoutBom = sql.charCodeAt(0) === 0xfeff ? sql.slice(1) : sql;
  return withoutBom.replace(/\r\n?/g, '\n');
}

export function sha256Hex(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function getPlanHashInput(plan: MigrationExecutionPlanInput): unknown {
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

function hashPlan(plan: MigrationExecutionPlanInput): string {
  return sha256Hex(canonicalJson(getPlanHashInput(plan)));
}

export function computeMigrationListHash(plans: ReadonlyArray<MigrationExecutionPlan>): string {
  return sha256Hex(canonicalJson(plans.map((plan) => [plan.name, plan.sqlHash, plan.planHash])));
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

function getExecutableSql(sql: string): string {
  let out = '';
  for (const segment of tokenizeSql(sql)) {
    if (segment.kind === 'sql') {
      out += sql.slice(segment.start, segment.end);
    } else {
      out += ' '.repeat(segment.end - segment.start);
    }
  }
  return out;
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

function includesTransactionControl(sql: string): string | null {
  const executable = getExecutableSql(sql);
  const match = executable.match(
    /(?:^|;)\s*(BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE|TRANSACTION))?|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i,
  );
  return match?.[1]?.toUpperCase() ?? null;
}

export function classifyMigration(migration: {
  name: string;
  sql: string;
}): MigrationExecutionPlan {
  const sql = canonicalSql(migration.sql);
  const sqlHash = sha256Hex(sql);
  const transactionControl = includesTransactionControl(sql);
  if (transactionControl) {
    throw new Error(
      `Migration ${migration.name} contains ${transactionControl}; Void owns the stable D1 transaction boundary.`,
    );
  }

  let base: MigrationExecutionPlanInput;
  const warnings: Array<string> = [];
  if (hasStatementBreakpointOutsideLiterals(sql)) {
    const statements = splitBreakpointFramedSql(sql);
    if (statements.length === 0) {
      throw new Error(
        `Migration ${migration.name} has statement breakpoints but no SQL statements.`,
      );
    }
    base = {
      classifierVersion: MIGRATION_CLASSIFIER_VERSION,
      dialect: 'sqlite',
      kind: 'breakpoint-framed',
      name: migration.name,
      sqlHash,
      stability: 'stable',
      statements,
    };
  } else if (isSingleStatement(sql)) {
    base = {
      classifierVersion: MIGRATION_CLASSIFIER_VERSION,
      dialect: 'sqlite',
      kind: 'single-statement',
      name: migration.name,
      sqlHash,
      stability: 'stable',
    };
  } else {
    const allowLegacy = hasStandalonePragma(sql, UNSPLIT_MULTI_STATEMENT_PRAGMA);
    warnings.push(
      `Migration ${migration.name} contains multiple statements without Drizzle statement breakpoints; it will run through the legacy D1 path.`,
    );
    base = {
      allowLegacy,
      classifierVersion: MIGRATION_CLASSIFIER_VERSION,
      dialect: 'sqlite',
      kind: 'legacy-unsplit-multi-statement',
      name: migration.name,
      sqlHash,
      stability: 'legacy',
    };
  }

  return {
    ...base,
    planHash: hashPlan(base),
    ...(warnings.length > 0 ? { warnings } : {}),
  } as MigrationExecutionPlan;
}

export function buildMigrationPlanBundle(
  migrations: ReadonlyArray<{ name: string; sql: string }>,
): MigrationPlanBundle {
  const plans = migrations.map((migration) => classifyMigration(migration));
  return {
    classifierVersion: MIGRATION_CLASSIFIER_VERSION,
    destructiveValidation: 'passed',
    migrationListHash: computeMigrationListHash(plans),
    plans,
    protocolVersion: 2,
  };
}
