import { pgTable, serial, text, boolean, timestamp } from "void/schema-pg";
import * as v from "valibot";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  email: v.pipe(v.string(), v.minLength(1)),
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  authorId: serial("author_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPostSchema = v.object({
  title: v.pipe(v.string(), v.minLength(1)),
  body: v.string(),
  authorId: v.number(),
});
