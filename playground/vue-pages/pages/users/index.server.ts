import { defineHandler } from "vite-cloud";
import * as v from "valibot";
import { USERS } from "./_data";

export const loader = defineHandler(() => {
  return { users: USERS };
});

export const action = defineHandler.withValidator({
  body: v.object({
    name: v.pipe(v.string(), v.minLength(1, "Name is required")),
    email: v.pipe(v.string(), v.minLength(1, "Email is required")),
  }),
})(async (c, { body }) => {
  USERS.push({ id: USERS.length + 1, name: body.name.trim(), email: body.email.trim() });
});
