import { defineHandler, type InferProps } from "void";

export type Props = InferProps<typeof loader>;

export const loader = defineHandler((c) => {
  const user = c.get("user");
  return { user: user ?? null };
});
