import { sqliteTable, integer, text, sql } from "void/schema-helpers";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});
