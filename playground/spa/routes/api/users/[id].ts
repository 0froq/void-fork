import * as v from "valibot";
import { defineHandler } from "vite-cloud";

interface User {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

export const GET = defineHandler.withValidator({
  params: v.object({ id: v.string() }),
})(async (c, { params }) => {
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(params.id)
    .first<User>();

  if (!user) {
    return new Response("Not found", { status: 404 });
  }
  return user;
});
