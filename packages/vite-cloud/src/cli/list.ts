import { intro, outro, log } from "@clack/prompts";
import { getToken } from "./auth";
import { PlatformClient } from "./client";

export async function runListCommand(): Promise<void> {
  console.log();
  intro("\x1b[34mvite-cloud list\x1b[0m");

  const token = getToken();
  if (!token) {
    log.error("Not logged in. Run `vcd login` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);
  const projects = await client.listProjects();

  if (projects.length === 0) {
    outro("No projects found.");
    return;
  }

  for (const project of projects) {
    log.info(`${project.slug}  ${project.id}  https://${project.slug}.vitecloud.app`);
  }

  outro(`${projects.length} project(s)`);
}
