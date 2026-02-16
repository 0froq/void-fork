import * as v from "valibot";
import { defineHandler } from "vite-cloud";

interface User {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

export const GET = defineHandler(async (c) => {
  const result = await c.env.DB.prepare("SELECT * FROM users").all<User>();
  return result.results;
});

export const POST = defineHandler.withValidator({
  body: v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    email: v.pipe(v.string(), v.email()),
  }),
})(async (c, { body }) => {
  await c.env.DB.prepare("INSERT INTO users (name, email) VALUES (?, ?)")
    .bind(body.name, body.email)
    .run();
  return { created: true };
});
