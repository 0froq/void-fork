/** Stub interfaces augmented by generated .vite-cloud/db.d.ts */
export interface DbTables {}
export interface DbInsertTables {}

type TableName = keyof DbTables & string;
type Row<T extends TableName> = DbTables[T];

type WhereClause<T extends TableName> = {
  [K in keyof Row<T>]?: Row<T>[K];
};

interface ListOptions<T extends TableName> {
  where?: WhereClause<T>;
  limit?: number;
  offset?: number;
  orderBy?:
    | `${Extract<keyof Row<T>, string>}`
    | `${Extract<keyof Row<T>, string>} ${"ASC" | "DESC"}`;
}

interface GetOptions<T extends TableName> {
  where?: WhereClause<T>;
}

interface UpdateOptions<T extends TableName> {
  set: Partial<Row<T>>;
  where?: WhereClause<T>;
}

interface DeleteOptions<T extends TableName> {
  where?: WhereClause<T>;
}

export interface QueryClient {
  list<T extends TableName>(table: T, options?: ListOptions<T>): Promise<Row<T>[]>;
  get<T extends TableName>(table: T, options?: GetOptions<T>): Promise<Row<T> | null>;
  insert<T extends TableName>(table: T, data: DbInsertTables[T]): Promise<D1Result>;
  update<T extends TableName>(table: T, options: UpdateOptions<T>): Promise<D1Result>;
  delete<T extends TableName>(table: T, options?: DeleteOptions<T>): Promise<D1Result>;
  raw<R = Record<string, unknown>>(sql: string, bindings?: unknown[]): Promise<R[]>;
}

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return name;
}

function buildWhere(where: Record<string, unknown>): { clause: string; bindings: unknown[] } {
  const keys = Object.keys(where);
  if (keys.length === 0) return { clause: "", bindings: [] };
  const conditions = keys.map((key) => `${validateIdentifier(key)} = ?`);
  const bindings = keys.map((key) => where[key]);
  return { clause: ` WHERE ${conditions.join(" AND ")}`, bindings };
}

/** Create a query client for a specific D1 instance. */
export function createDb(database: D1Database): QueryClient {
  return createQueryClient(() => database);
}

function createQueryClient(getDB: () => D1Database): QueryClient {
  return {
    async list(table, options) {
      const tableName = validateIdentifier(table);
      let sql = `SELECT * FROM ${tableName}`;
      const bindings: unknown[] = [];

      if (options?.where) {
        const w = buildWhere(options.where as Record<string, unknown>);
        sql += w.clause;
        bindings.push(...w.bindings);
      }

      if (options?.orderBy) {
        const parts = options.orderBy.split(" ");
        const col = validateIdentifier(parts[0]);
        const dir = parts[1]?.toUpperCase();
        sql += ` ORDER BY ${col}`;
        if (dir === "ASC" || dir === "DESC") sql += ` ${dir}`;
      }

      if (options?.limit != null) {
        sql += " LIMIT ?";
        bindings.push(options.limit);
      }

      if (options?.offset != null) {
        sql += " OFFSET ?";
        bindings.push(options.offset);
      }

      const result = await getDB()
        .prepare(sql)
        .bind(...bindings)
        .all();
      return result.results as any;
    },

    async get(table, options) {
      const tableName = validateIdentifier(table);
      let sql = `SELECT * FROM ${tableName}`;
      const bindings: unknown[] = [];

      if (options?.where) {
        const w = buildWhere(options.where as Record<string, unknown>);
        sql += w.clause;
        bindings.push(...w.bindings);
      }

      sql += " LIMIT 1";

      return getDB()
        .prepare(sql)
        .bind(...bindings)
        .first() as any;
    },

    async insert(table, data) {
      const tableName = validateIdentifier(table);
      const entries = Object.entries(data as Record<string, unknown>);
      const cols = entries.map(([key]) => validateIdentifier(key));
      const placeholders = cols.map(() => "?");
      const bindings = entries.map(([, value]) => value);

      const sql = `INSERT INTO ${tableName} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`;
      return getDB()
        .prepare(sql)
        .bind(...bindings)
        .run();
    },

    async update(table, options) {
      const tableName = validateIdentifier(table);
      const setEntries = Object.entries(options.set as Record<string, unknown>);
      if (setEntries.length === 0) {
        throw new Error("update() requires at least one column in `set`");
      }
      const setCols = setEntries.map(([key]) => `${validateIdentifier(key)} = ?`);
      const bindings = setEntries.map(([, value]) => value);

      let sql = `UPDATE ${tableName} SET ${setCols.join(", ")}`;

      if (options.where) {
        const w = buildWhere(options.where as Record<string, unknown>);
        sql += w.clause;
        bindings.push(...w.bindings);
      }

      return getDB()
        .prepare(sql)
        .bind(...bindings)
        .run();
    },

    async delete(table, options) {
      const tableName = validateIdentifier(table);
      let sql = `DELETE FROM ${tableName}`;
      const bindings: unknown[] = [];

      if (options?.where) {
        const w = buildWhere(options.where as Record<string, unknown>);
        sql += w.clause;
        bindings.push(...w.bindings);
      }

      return getDB()
        .prepare(sql)
        .bind(...bindings)
        .run();
    },

    async raw(sql, bindings) {
      const stmt = bindings?.length
        ? getDB()
            .prepare(sql)
            .bind(...bindings)
        : getDB().prepare(sql);
      const result = await stmt.all();
      return result.results as any;
    },
  };
}

import { env } from "cloudflare:workers";

/** Default query client — uses `env.DB` from `cloudflare:workers`. */
export const db: QueryClient = createQueryClient(() => (env as any).DB);
