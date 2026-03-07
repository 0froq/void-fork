import { db } from "void/db";
import { users, posts } from "@schema";

await db.insert(users).values([
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
  { name: "Charlie", email: "charlie@example.com" },
]);

await db.insert(posts).values([
  { title: "Hello World", body: "First post from Alice", authorId: 1 },
  { title: "PostgreSQL Tips", body: "Hyperdrive is fast", authorId: 2 },
  { title: "Drizzle ORM", body: "Type-safe queries are great", authorId: 1 },
]);

console.log("Seeded 3 users and 3 posts");
