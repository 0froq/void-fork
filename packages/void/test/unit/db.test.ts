import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { createDb, type QueryClient } from "../../src/runtime/db";

// Augment DbTables/DbInsertTables for type-level tests
declare module "../../src/runtime/db" {
  interface DbTables {
    users: {
      id: number;
      name: string;
      email: string;
      created_at: string | null;
    };
    posts: {
      id: number;
      title: string;
      user_id: number;
    };
  }
  interface DbInsertTables {
    users: {
      id?: number;
      name: string;
      email: string;
      created_at?: string | null;
    };
    posts: {
      id?: number;
      title: string;
      user_id: number;
    };
  }
}

// Mock D1 database
function createMockD1() {
  const mockResult = { results: [], success: true, meta: {} };
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue(mockResult),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue(mockResult),
  };
  const mockDb = {
    prepare: vi.fn().mockReturnValue(mockStmt),
  };
  return { db: mockDb as unknown as D1Database, stmt: mockStmt, mock: mockDb };
}

describe("createDb", () => {
  let mockD1: ReturnType<typeof createMockD1>;
  // Use `any` because DbTables stub is empty (TableName = never).
  // In real usage, generated db.d.ts augments the interface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  beforeEach(() => {
    mockD1 = createMockD1();
    db = createDb(mockD1.db);
  });

  describe("list", () => {
    it("generates basic SELECT", async () => {
      await db.list("users");
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT * FROM users");
      expect(mockD1.stmt.bind).toHaveBeenCalledWith();
      expect(mockD1.stmt.all).toHaveBeenCalled();
    });

    it("generates SELECT with WHERE", async () => {
      await db.list("users", { where: { name: "Alice", active: 1 } });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE name = ? AND active = ?",
      );
      expect(mockD1.stmt.bind).toHaveBeenCalledWith("Alice", 1);
    });

    it("generates WHERE with IN for array values", async () => {
      await db.list("users", { where: { id: [1, 2, 3] } });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT * FROM users WHERE id IN (?, ?, ?)");
      expect(mockD1.stmt.bind).toHaveBeenCalledWith(1, 2, 3);
    });

    it("generates WHERE mixing scalar and array values", async () => {
      await db.list("users", { where: { name: "Alice", id: [1, 2] } });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE name = ? AND id IN (?, ?)",
      );
      expect(mockD1.stmt.bind).toHaveBeenCalledWith("Alice", 1, 2);
    });

    it("generates SELECT with select columns", async () => {
      await db.list("users", { select: ["name", "email"] });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT name, email FROM users");
    });

    it("generates SELECT with ORDER BY", async () => {
      await db.list("users", { orderBy: "name DESC" });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT * FROM users ORDER BY name DESC");
    });

    it("generates SELECT with orderBy array", async () => {
      await db.list("users", { orderBy: ["name ASC", "created_at DESC"] });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith(
        "SELECT * FROM users ORDER BY name ASC, created_at DESC",
      );
    });

    it("generates SELECT with LIMIT and OFFSET", async () => {
      await db.list("users", { limit: 10, offset: 20 });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT * FROM users LIMIT ? OFFSET ?");
      expect(mockD1.stmt.bind).toHaveBeenCalledWith(10, 20);
    });

    it("combines WHERE, ORDER BY, LIMIT", async () => {
      await db.list("users", {
        where: { active: 1 },
        orderBy: "name",
        limit: 5,
      });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE active = ? ORDER BY name LIMIT ?",
      );
      expect(mockD1.stmt.bind).toHaveBeenCalledWith(1, 5);
    });
  });

  describe("get", () => {
    it("generates SELECT with LIMIT 1", async () => {
      await db.get("users");
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT * FROM users LIMIT 1");
      expect(mockD1.stmt.first).toHaveBeenCalled();
    });

    it("generates SELECT with WHERE and LIMIT 1", async () => {
      await db.get("users", { where: { id: 1 } });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT * FROM users WHERE id = ? LIMIT 1");
      expect(mockD1.stmt.bind).toHaveBeenCalledWith(1);
    });

    it("generates SELECT with select columns", async () => {
      await db.get("users", { select: ["name"] });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT name FROM users LIMIT 1");
    });
  });

  describe("insert", () => {
    it("generates INSERT statement", async () => {
      await db.insert("users", { name: "Alice", email: "a@b.com" });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith(
        "INSERT INTO users (name, email) VALUES (?, ?)",
      );
      expect(mockD1.stmt.bind).toHaveBeenCalledWith("Alice", "a@b.com");
      expect(mockD1.stmt.run).toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("generates UPDATE statement", async () => {
      await db.update("users", {
        set: { name: "Bob" },
        where: { id: 1 },
      });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("UPDATE users SET name = ? WHERE id = ?");
      expect(mockD1.stmt.bind).toHaveBeenCalledWith("Bob", 1);
      expect(mockD1.stmt.run).toHaveBeenCalled();
    });

    it("generates UPDATE without WHERE", async () => {
      await db.update("users", { set: { active: 0 } });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("UPDATE users SET active = ?");
      expect(mockD1.stmt.bind).toHaveBeenCalledWith(0);
    });

    it("throws when set is empty", async () => {
      await expect(db.update("users", { set: {} })).rejects.toThrow(
        "update() requires at least one column in `set`",
      );
    });
  });

  describe("delete", () => {
    it("generates DELETE statement", async () => {
      await db.delete("users", { where: { id: 1 } });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("DELETE FROM users WHERE id = ?");
      expect(mockD1.stmt.bind).toHaveBeenCalledWith(1);
      expect(mockD1.stmt.run).toHaveBeenCalled();
    });

    it("generates DELETE without WHERE", async () => {
      await db.delete("users");
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("DELETE FROM users");
    });
  });

  describe("raw", () => {
    it("passes SQL and bindings through", async () => {
      await db.raw("SELECT * FROM users WHERE id = ?", [42]);
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT * FROM users WHERE id = ?");
      expect(mockD1.stmt.bind).toHaveBeenCalledWith(42);
      expect(mockD1.stmt.all).toHaveBeenCalled();
    });

    it("works without bindings", async () => {
      await db.raw("SELECT 1");
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT 1");
      expect(mockD1.stmt.all).toHaveBeenCalled();
    });
  });

  describe("count", () => {
    it("generates COUNT query", async () => {
      mockD1.stmt.first.mockResolvedValue({ count: 42 });
      const result = await db.count("users");
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT COUNT(*) AS count FROM users");
      expect(result).toBe(42);
    });

    it("generates COUNT with WHERE", async () => {
      mockD1.stmt.first.mockResolvedValue({ count: 5 });
      const result = await db.count("users", { where: { active: 1 } });
      expect(mockD1.mock.prepare).toHaveBeenCalledWith(
        "SELECT COUNT(*) AS count FROM users WHERE active = ?",
      );
      expect(mockD1.stmt.bind).toHaveBeenCalledWith(1);
      expect(result).toBe(5);
    });
  });

  describe("identifier validation", () => {
    it("rejects invalid table names", async () => {
      await expect(db.list("users; DROP TABLE users--")).rejects.toThrow("Invalid identifier");
    });

    it("rejects invalid column names in where clause", async () => {
      await expect(db.list("users", { where: { "1=1; --": "x" } })).rejects.toThrow(
        "Invalid identifier",
      );
    });

    it("allows valid identifiers with underscores", async () => {
      await db.list("user_profiles");
      expect(mockD1.mock.prepare).toHaveBeenCalledWith("SELECT * FROM user_profiles");
    });
  });
});

// Use a typed client for compile-time checks
const typedDb: QueryClient = null!;

describe("type-level inference", () => {
  it("type: list returns correctly typed rows", () => {
    const _check = async () => {
      const users = await typedDb.list("users");
      // row fields are accessible
      void users[0].id.toFixed();
      void users[0].name.toUpperCase();
      // nullable field
      void users[0].created_at?.toUpperCase();

      // @ts-expect-error - 'missing' does not exist on user row
      void users[0].missing;

      // @ts-expect-error - id is number, toUpperCase does not exist
      void users[0].id.toUpperCase();
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: get returns row | null", () => {
    const _check = async () => {
      const user = await typedDb.get("users");
      // result is nullable
      if (user) {
        void user.name.toUpperCase();
      }

      // @ts-expect-error - might be null, can't access directly
      void user.name;
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: rejects invalid table names", () => {
    const _check = async () => {
      // @ts-expect-error - "nonexistent" is not a valid table
      await typedDb.list("nonexistent");

      // @ts-expect-error - "nonexistent" is not a valid table
      await typedDb.get("nonexistent");

      // @ts-expect-error - "nonexistent" is not a valid table
      await typedDb.insert("nonexistent", {});

      // @ts-expect-error - "nonexistent" is not a valid table
      await typedDb.delete("nonexistent");
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: where clause only accepts valid columns and types", () => {
    const _check = async () => {
      // valid where
      await typedDb.list("users", { where: { id: 1 } });
      await typedDb.list("users", { where: { name: "Alice", email: "a@b.com" } });

      // @ts-expect-error - 'missing' is not a column on users
      await typedDb.list("users", { where: { missing: "x" } });

      // @ts-expect-error - id is number, not string
      await typedDb.list("users", { where: { id: "wrong" } });
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: orderBy only accepts valid column names", () => {
    const _check = async () => {
      await typedDb.list("users", { orderBy: "name" });
      await typedDb.list("users", { orderBy: "name ASC" });
      await typedDb.list("users", { orderBy: "id DESC" });

      // @ts-expect-error - 'missing' is not a column on users
      await typedDb.list("users", { orderBy: "missing" });

      // @ts-expect-error - 'missing' is not a column on users
      await typedDb.list("users", { orderBy: "missing DESC" });
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: insert enforces DbInsertTables shape", () => {
    const _check = async () => {
      // required fields only — compiles
      await typedDb.insert("users", { name: "Alice", email: "a@b.com" });

      // all fields including optional — compiles
      await typedDb.insert("users", { id: 1, name: "Alice", email: "a@b.com", created_at: null });

      // @ts-expect-error - missing required field 'email'
      await typedDb.insert("users", { name: "Alice" });

      // @ts-expect-error - name is string, not number
      await typedDb.insert("users", { name: 123, email: "a@b.com" });
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: update set accepts partial row types", () => {
    const _check = async () => {
      // partial set — compiles
      await typedDb.update("users", { set: { name: "Bob" } });

      // @ts-expect-error - 'missing' is not a column on users
      await typedDb.update("users", { set: { missing: "x" } });

      // @ts-expect-error - name is string, not number
      await typedDb.update("users", { set: { name: 123 } });
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: different tables have distinct types", () => {
    const _check = async () => {
      const users = await typedDb.list("users");
      const posts = await typedDb.list("posts");

      void users[0].email;
      void posts[0].title;

      // @ts-expect-error - 'title' does not exist on users
      void users[0].title;

      // @ts-expect-error - 'email' does not exist on posts
      void posts[0].email;
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: select narrows return type on list", () => {
    const _check = async () => {
      const users = await typedDb.list("users", { select: ["name", "email"] });
      // selected cols are accessible
      void users[0].name.toUpperCase();
      void users[0].email.toUpperCase();

      // @ts-expect-error - 'id' was not selected
      void users[0].id;

      // @ts-expect-error - 'created_at' was not selected
      void users[0].created_at;
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: select narrows return type on get", () => {
    const _check = async () => {
      const user = await typedDb.get("users", { select: ["name"] });
      if (user) {
        void user.name.toUpperCase();

        // @ts-expect-error - 'email' was not selected
        void user.email;
      }
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: where clause accepts array values (IN)", () => {
    const _check = async () => {
      // array of correct type compiles
      await typedDb.list("users", { where: { id: [1, 2, 3] } });
      await typedDb.list("users", { where: { name: ["Alice", "Bob"] } });

      // @ts-expect-error - id is number, not string[]
      await typedDb.list("users", { where: { id: ["wrong"] } });
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: orderBy accepts array", () => {
    const _check = async () => {
      await typedDb.list("users", { orderBy: ["name", "id DESC"] });
      await typedDb.list("users", { orderBy: ["name ASC", "created_at DESC"] });

      // @ts-expect-error - 'missing' is not a column on users
      await typedDb.list("users", { orderBy: ["missing"] });
    };
    void _check;
    expect(true).toBe(true);
  });

  it("type: count returns Promise<number>", () => {
    const _check = async () => {
      const n: number = await typedDb.count("users");
      void n.toFixed();

      await typedDb.count("users", { where: { id: 1 } });

      // @ts-expect-error - "nonexistent" is not a valid table
      await typedDb.count("nonexistent");
    };
    void _check;
    expect(true).toBe(true);
  });
});
