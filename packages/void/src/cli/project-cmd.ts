import type { ProjectArgs } from "./project-args";
import { runProjectsCommand } from "./projects";

export async function runProjectCommand(root: string, args: ProjectArgs): Promise<void> {
  if (args.subcommand === "list") {
    return runProjectsCommand();
  }
  if (args.subcommand === "rm") {
    const { runDeleteCommand } = await import("./delete");
    return runDeleteCommand(root, args.name || undefined);
  }
}
