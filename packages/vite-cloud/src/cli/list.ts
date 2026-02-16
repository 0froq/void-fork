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

  const rows = projects.map((p) => ({
    slug: p.slug,
    id: p.id.replace(/^proj_/, ""),
    mode: p.mode ?? "worker",
    url: `https://${p.slug}.vitecloud.app`,
  }));

  const slugWidth = Math.max("name".length, ...rows.map((r) => r.slug.length));
  const idWidth = Math.max("id".length, ...rows.map((r) => r.id.length));
  const modeWidth = Math.max("mode".length, ...rows.map((r) => r.mode.length));

  const prefix = "\x1b[90m│\x1b[0m  ";
  const header = `${prefix}\x1b[2m${"name".padEnd(slugWidth)}  ${"id".padEnd(idWidth)}  ${"mode".padEnd(modeWidth)}  url\x1b[0m`;
  const lines = rows.map(
    (row) =>
      `${prefix}\x1b[32m${row.slug}\x1b[0m${"".padEnd(slugWidth - row.slug.length)}  ${row.id.padEnd(idWidth)}  ${row.mode.padEnd(modeWidth)}  ${row.url}`,
  );
  console.log(prefix);
  console.log(header);
  for (const line of lines) console.log(line);
  outro(`${projects.length} project(s)`);
}
