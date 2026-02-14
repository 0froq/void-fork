import { select, isCancel, cancel } from "@clack/prompts";
import type { ProjectResponse } from "./client";

interface SelectResult {
  action: "select";
  project: ProjectResponse;
}

interface CreateResult {
  action: "create";
}

export type PromptResult = SelectResult | CreateResult;

export async function promptProjectSelection(projects: ProjectResponse[]): Promise<PromptResult> {
  const options = [
    ...projects.map((p) => ({
      value: p.id,
      label: `${p.slug} (${p.slug}.vitecloud.app)`,
    })),
    { value: "__create__", label: "Create new project" },
  ];

  const result = await select({
    message: "Select a project to deploy to:",
    options,
  });

  if (isCancel(result)) {
    cancel("Deploy cancelled.");
    process.exit(0);
  }

  if (result === "__create__") {
    return { action: "create" };
  }

  const project = projects.find((p) => p.id === result)!;
  return { action: "select", project };
}
