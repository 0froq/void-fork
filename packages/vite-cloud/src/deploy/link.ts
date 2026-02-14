import { intro, outro } from "@clack/prompts";
import { getToken } from "./auth";
import { PlatformClient } from "./client";
import { readProjectConfig, writeProjectConfig } from "./project";
import { promptProjectSelection } from "./prompt";

export async function runLink(root: string, slug?: string): Promise<void> {
  intro("vite-cloud link");

  // Check if already linked
  const existing = readProjectConfig(root);
  if (existing) {
    console.log(`Already linked to ${existing.slug} (${existing.slug}.vitecloud.app)`);
    console.log(`To re-link, delete .vite-cloud/project.json and run again.`);
    return;
  }

  // Auth
  const token = getToken();
  if (!token) {
    console.error(
      "Error: No auth token found.\n" +
        "Set VITE_CLOUD_TOKEN environment variable or run `vite-cloud login`.",
    );
    process.exit(1);
  }

  const client = new PlatformClient(token);
  const projects = await client.listProjects();

  if (slug) {
    // Non-interactive: link by slug
    const project = projects.find((p) => p.slug === slug);
    if (!project) {
      console.error(`Error: No project found with slug "${slug}".`);
      process.exit(1);
    }
    writeProjectConfig(root, { projectId: project.id, slug: project.slug });
    outro(`Linked to ${project.slug} (${project.slug}.vitecloud.app)`);
    return;
  }

  // Interactive: prompt user to select
  if (projects.length === 0) {
    console.error("No projects found. Run `vite-cloud deploy` to create one.");
    process.exit(1);
  }

  const result = await promptProjectSelection(projects);

  if (result.action === "create") {
    console.log("Run `vite-cloud deploy` to create a new project.");
    return;
  }

  writeProjectConfig(root, { projectId: result.project.id, slug: result.project.slug });
  outro(`Linked to ${result.project.slug} (${result.project.slug}.vitecloud.app)`);
}
