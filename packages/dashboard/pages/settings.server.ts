import { defineHandler } from "void";
import { createClient, type API } from "../lib/api";

export type Props = {
  user: API<"me">;
};

export const loader = defineHandler<Props>(async (c) => {
  const client = createClient(c);
  const res = await client.me.$get();
  const user = (await res.json()) as Props["user"];
  return { user };
});
