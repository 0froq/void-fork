export interface ColumnDef {
  name: string;
  type: "INTEGER" | "REAL" | "TEXT" | "BLOB";
  nullable: boolean;
  hasDefault: boolean;
  primaryKey: boolean;
}

export interface TableSchema {
  name: string;
  columns: ColumnDef[];
}

export type SchemaMap = Map<string, TableSchema>;

/**
 * Replay ordered migration DDL to build the final schema.
 * Pure function — no I/O, no deps.
 */
export function parseMigrationSchema(migrations: { name: string; sql: string }[]): SchemaMap {
  const schema: SchemaMap = new Map();

  for (const migration of migrations) {
    const cleaned = stripComments(migration.sql);
    const statements = splitStatements(cleaned);

    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      const upper = trimmed.toUpperCase();

      if (upper.startsWith("CREATE TABLE")) {
        handleCreateTable(trimmed, schema);
      } else if (upper.startsWith("ALTER TABLE")) {
        handleAlterTable(trimmed, schema);
      } else if (upper.startsWith("DROP TABLE")) {
        handleDropTable(trimmed, schema);
      }
      // Everything else (INSERT, CREATE INDEX, etc.) — ignored
    }
  }

  return schema;
}

function handleCreateTable(stmt: string, schema: SchemaMap): void {
  // CREATE TABLE [IF NOT EXISTS] name (columns...)
  const match = stmt.match(
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+|"[^"]+"|`[^`]+`)\s*\(([\s\S]*)\)\s*;?\s*$/i,
  );
  if (!match) return;

  const tableName = unquote(match[1]);
  const body = match[2];
  const defs = splitColumnDefs(body);

  const columns: ColumnDef[] = [];
  const compositePKColumns = new Set<string>();

  for (const def of defs) {
    const trimDef = def.trim();
    if (!trimDef) continue;
    const upperDef = trimDef.toUpperCase();

    // Skip table constraints
    if (
      upperDef.startsWith("PRIMARY KEY") ||
      upperDef.startsWith("FOREIGN KEY") ||
      upperDef.startsWith("UNIQUE") ||
      upperDef.startsWith("CHECK") ||
      upperDef.startsWith("CONSTRAINT")
    ) {
      // Extract column names from composite PRIMARY KEY
      if (upperDef.startsWith("PRIMARY KEY")) {
        const pkMatch = trimDef.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
        if (pkMatch) {
          const pkCols = pkMatch[1].split(",").map((c) => unquote(c.trim()));
          for (const col of pkCols) {
            compositePKColumns.add(col);
          }
        }
      }
      continue;
    }

    const col = parseColumnDef(trimDef);
    if (col) columns.push(col);
  }

  // Apply composite PK
  for (const col of columns) {
    if (compositePKColumns.has(col.name)) {
      col.primaryKey = true;
      col.nullable = false;
    }
  }

  schema.set(tableName, { name: tableName, columns });
}

function handleAlterTable(stmt: string, schema: SchemaMap): void {
  const upper = stmt.toUpperCase();

  // ALTER TABLE name RENAME TO newname
  const renameTableMatch = stmt.match(
    /^ALTER\s+TABLE\s+(\w+|"[^"]+"|`[^`]+`)\s+RENAME\s+TO\s+(\w+|"[^"]+"|`[^`]+`)\s*;?\s*$/i,
  );
  if (renameTableMatch) {
    const oldName = unquote(renameTableMatch[1]);
    const newName = unquote(renameTableMatch[2]);
    const table = schema.get(oldName);
    if (table) {
      schema.delete(oldName);
      table.name = newName;
      schema.set(newName, table);
    }
    return;
  }

  // ALTER TABLE name RENAME COLUMN old TO new
  const renameColMatch = stmt.match(
    /^ALTER\s+TABLE\s+(\w+|"[^"]+"|`[^`]+`)\s+RENAME\s+COLUMN\s+(\w+|"[^"]+"|`[^`]+`)\s+TO\s+(\w+|"[^"]+"|`[^`]+`)\s*;?\s*$/i,
  );
  if (renameColMatch) {
    const tableName = unquote(renameColMatch[1]);
    const oldCol = unquote(renameColMatch[2]);
    const newCol = unquote(renameColMatch[3]);
    const table = schema.get(tableName);
    if (table) {
      const col = table.columns.find((c) => c.name === oldCol);
      if (col) col.name = newCol;
    }
    return;
  }

  // ALTER TABLE name ADD [COLUMN] coldef
  const addColMatch = stmt.match(
    /^ALTER\s+TABLE\s+(\w+|"[^"]+"|`[^`]+`)\s+ADD\s+(?:COLUMN\s+)?([\s\S]+?)\s*;?\s*$/i,
  );
  if (addColMatch && !upper.includes(" DROP ") && !upper.includes(" RENAME ")) {
    const tableName = unquote(addColMatch[1]);
    const table = schema.get(tableName);
    if (table) {
      const col = parseColumnDef(addColMatch[2].trim());
      if (col) table.columns.push(col);
    }
    return;
  }

  // ALTER TABLE name DROP [COLUMN] name
  const dropColMatch = stmt.match(
    /^ALTER\s+TABLE\s+(\w+|"[^"]+"|`[^`]+`)\s+DROP\s+(?:COLUMN\s+)?(\w+|"[^"]+"|`[^`]+`)\s*;?\s*$/i,
  );
  if (dropColMatch) {
    const tableName = unquote(dropColMatch[1]);
    const colName = unquote(dropColMatch[2]);
    const table = schema.get(tableName);
    if (table) {
      table.columns = table.columns.filter((c) => c.name !== colName);
    }
  }
}

function handleDropTable(stmt: string, schema: SchemaMap): void {
  const match = stmt.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+|"[^"]+"|`[^`]+`)\s*;?\s*$/i);
  if (match) {
    schema.delete(unquote(match[1]));
  }
}

function unquote(name: string): string {
  if (
    (name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("`") && name.endsWith("`"))
  ) {
    return name.slice(1, -1);
  }
  return name;
}

/**
 * Strip SQL comments (single-line -- and block comments).
 * Preserves content inside string literals.
 */
export function stripComments(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    // String literal
    if (sql[i] === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2; // escaped quote
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      result += sql.slice(start, i);
      continue;
    }
    // Single-line comment
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += sql[i];
    i++;
  }
  return result;
}

/**
 * Split SQL into individual statements on `;`.
 * Respects string literals and parenthesized expressions.
 */
export function splitStatements(sql: string): string[] {
  const stmts: string[] = [];
  let current = "";
  let i = 0;
  let depth = 0;

  while (i < sql.length) {
    if (sql[i] === "'") {
      current += sql[i];
      i++;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += sql[i + 1];
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    if (sql[i] === "(") depth++;
    if (sql[i] === ")") depth--;
    if (sql[i] === ";" && depth <= 0) {
      stmts.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += sql[i];
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) stmts.push(trimmed);
  return stmts;
}

/**
 * Split the body of a CREATE TABLE (...) into individual column/constraint defs.
 * Tracks paren depth so DEFAULT (expr) isn't split on its internal commas.
 */
export function splitColumnDefs(body: string): string[] {
  const defs: string[] = [];
  let current = "";
  let depth = 0;

  for (let i = 0; i < body.length; i++) {
    if (body[i] === "'") {
      current += body[i];
      i++;
      while (i < body.length) {
        current += body[i];
        if (body[i] === "'" && body[i + 1] === "'") {
          current += body[i + 1];
          i += 2;
        } else if (body[i] === "'") {
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    if (body[i] === "(") depth++;
    if (body[i] === ")") depth--;
    if (body[i] === "," && depth === 0) {
      defs.push(current.trim());
      current = "";
      continue;
    }
    current += body[i];
  }
  const trimmed = current.trim();
  if (trimmed) defs.push(trimmed);
  return defs;
}

/**
 * Parse a single column definition like `name TEXT NOT NULL DEFAULT 'foo'`.
 */
export function parseColumnDef(text: string): ColumnDef | null {
  // Tokenize: first token is name, second is optional type
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;

  const name = unquote(tokens[0]);

  // Determine type — second token (if it looks like a type name)
  let typeName = "";
  if (tokens.length > 1) {
    const second = tokens[1].toUpperCase();
    // Check if second token is a constraint keyword (not a type)
    if (!isConstraintKeyword(second)) {
      typeName = second;
    }
  }

  const type = mapSqliteType(typeName);
  const primaryKey = /\bPRIMARY\s+KEY\b/i.test(text);
  const autoincrement = /\bAUTOINCREMENT\b/i.test(text);
  const notNull = /\bNOT\s+NULL\b/i.test(text);
  const hasDefault = /\bDEFAULT\b/i.test(text) || autoincrement;
  const nullable = !notNull && !primaryKey;

  return { name, type, nullable, hasDefault, primaryKey };
}

function isConstraintKeyword(token: string): boolean {
  return [
    "PRIMARY",
    "NOT",
    "NULL",
    "UNIQUE",
    "CHECK",
    "DEFAULT",
    "REFERENCES",
    "CONSTRAINT",
  ].includes(token);
}

/**
 * Simple tokenizer — splits on whitespace, respects quotes and parens.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    // Skip whitespace
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;

    // Quoted identifier
    if (text[i] === '"' || text[i] === "`") {
      const quote = text[i];
      const start = i;
      i++;
      while (i < text.length && text[i] !== quote) i++;
      i++; // closing quote
      tokens.push(text.slice(start, i));
      continue;
    }

    // Parenthesized expression
    if (text[i] === "(") {
      const start = i;
      let depth = 1;
      i++;
      while (i < text.length && depth > 0) {
        if (text[i] === "(") depth++;
        if (text[i] === ")") depth--;
        i++;
      }
      tokens.push(text.slice(start, i));
      continue;
    }

    // Regular token
    const start = i;
    while (i < text.length && !/\s/.test(text[i]) && text[i] !== "(" && text[i] !== ")") i++;
    tokens.push(text.slice(start, i));
  }
  return tokens;
}

/**
 * Map a SQL type name to SQLite type affinity.
 * Follows SQLite's affinity rules:
 * 1. Contains "INT" → INTEGER
 * 2. Contains "CHAR" / "CLOB" / "TEXT" → TEXT
 * 3. Contains "REAL" / "FLOA" / "DOUB" → REAL
 * 4. Contains "BLOB" or empty → BLOB
 */
export function mapSqliteType(typeName: string): ColumnDef["type"] {
  const upper = typeName.toUpperCase();
  if (upper.includes("INT")) return "INTEGER";
  if (upper.includes("CHAR") || upper.includes("CLOB") || upper.includes("TEXT")) return "TEXT";
  if (upper.includes("REAL") || upper.includes("FLOA") || upper.includes("DOUB")) return "REAL";
  if (upper.includes("BLOB") || upper === "") return "BLOB";
  // Fallback: treat as TEXT for named types we don't recognize (e.g. NUMERIC, BOOLEAN)
  return "TEXT";
}
