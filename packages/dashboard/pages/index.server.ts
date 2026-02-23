import { defineHandler } from "void";
import { createClient, type API } from "../lib/api";

export type Props = {
  projects: API<"projects">;
  usage: API<"usage">;
};

export const loader = defineHandler<Props>(async (c) => {
  const client = createClient(c);
  const [projectsRes, usageRes] = await Promise.all([client.projects.$get(), client.usage.$get()]);
  const projects = await projectsRes.json();
  const usage = await usageRes.json();
  return { projects, usage };
});
