import { getToken } from "./auth";
import { PlatformClient } from "./client";

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

export async function runListCommand(): Promise<void> {
  const token = getToken();
  if (!token) {
    console.error("Not logged in. Run `vcd login` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);
  const projects = await client.listProjects();

  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }

  const rows = projects.map((project) => ({
    name: project.slug,
    projectId: project.id,
    url: `https://${project.slug}.vitecloud.app`,
  }));
  const nameWidth = Math.max("name".length, ...rows.map((r) => r.name.length));
  const idWidth = Math.max("project id".length, ...rows.map((r) => r.projectId.length));

  const header = `${"name".padEnd(nameWidth)}  ${"project id".padEnd(idWidth)}  url`;
  console.log(`${BOLD}${CYAN}${header}${RESET}`);

  for (const row of rows) {
    console.log(`${row.name.padEnd(nameWidth)}  ${row.projectId.padEnd(idWidth)}  ${row.url}`);
  }
}
