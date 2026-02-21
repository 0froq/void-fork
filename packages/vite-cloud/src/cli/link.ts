import { intro, outro, log, cancel } from "@clack/prompts";
import { getToken, getSiteDomain } from "./auth";
import { PlatformClient } from "./client";
import { readProjectConfig, writeProjectConfig } from "./project";
import { promptProjectSelection } from "./prompt";
import { cliTitle } from "./output";

export async function runLink(root: string, slug?: string): Promise<void> {
  console.log();
  intro(cliTitle("link"));

  // Check if already linked
  const existing = readProjectConfig(root);
  if (existing) {
    log.warn(`Already linked to ${existing.slug} (${existing.slug}.${getSiteDomain()})`);
    outro("To re-link, delete .vite-cloud/project.json and run again.");
    return;
  }

  // Auth
  const token = getToken();
  if (!token) {
    cancel("No auth token found. Run `vcc login` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);
  const projects = await client.listProjects();

  if (slug) {
    // Non-interactive: link by slug
    const project = projects.find((p) => p.slug === slug);
    if (!project) {
      cancel(`No project found with slug "${slug}".`);
      process.exit(1);
    }
    writeProjectConfig(root, { projectId: project.id, slug: project.slug });
    outro(`Linked to ${project.slug} (${project.slug}.${getSiteDomain()})`);
    return;
  }

  // Interactive: prompt user to select
  if (projects.length === 0) {
    cancel("No projects found. Run `vcc deploy` to create one.");
    process.exit(1);
  }

  const result = await promptProjectSelection(projects);

  if (result.action === "create") {
    outro("Run `vcc deploy` to create a new project.");
    return;
  }

  writeProjectConfig(root, { projectId: result.project.id, slug: result.project.slug });
  outro(`Linked to ${result.project.slug} (${result.project.slug}.${getSiteDomain()})`);
}
