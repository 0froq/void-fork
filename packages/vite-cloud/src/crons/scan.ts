import { readFileSync } from "node:fs";
import { join } from "node:path";
import { glob, globSync } from "tinyglobby";

const JOB_EXTENSIONS = ["ts", "mts", "js", "mjs"];

export interface JobDefinition {
  /** Relative file path from jobs/ */
  filePath: string;
  /** Deterministic job name (path without extension) */
  name: string;
  /** Cron expression from `export const cron = "..."` */
  cron: string;
}

function extractJobName(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, "");
}

function extractCronExpression(source: string, filePath: string): string {
  const match = source.match(/export\s+const\s+cron\s*=\s*(['"`])([^'"`]+)\1/);
  if (!match) {
    throw new Error(
      `Invalid job file "${filePath}": missing \`export const cron = "<schedule>"\` literal`,
    );
  }
  const cron = match[2].trim();
  if (!cron) {
    throw new Error(`Invalid job file "${filePath}": cron expression cannot be empty`);
  }
  return cron;
}

function parseJobFiles(root: string, jobsDir: string, files: string[]): JobDefinition[] {
  return files
    .filter((f) => !f.split("/").some((segment) => segment.startsWith("_")))
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => {
      const absPath = join(root, jobsDir, filePath);
      const source = readFileSync(absPath, "utf-8");
      return {
        filePath,
        name: extractJobName(filePath),
        cron: extractCronExpression(source, filePath),
      };
    });
}

export async function scanJobs(root: string, jobsDir = "crons"): Promise<JobDefinition[]> {
  const pattern = `**/*.{${JOB_EXTENSIONS.join(",")}}`;
  const files = await glob(pattern, { cwd: `${root}/${jobsDir}`, absolute: false }).catch(
    () => [] as string[],
  );
  return parseJobFiles(root, jobsDir, files);
}

export function scanJobsSync(root: string, jobsDir = "crons"): JobDefinition[] {
  const pattern = `**/*.{${JOB_EXTENSIONS.join(",")}}`;
  let files: string[];
  try {
    files = globSync(pattern, { cwd: `${root}/${jobsDir}`, absolute: false });
  } catch {
    files = [];
  }
  return parseJobFiles(root, jobsDir, files);
}
