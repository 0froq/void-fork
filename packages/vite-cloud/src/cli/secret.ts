import { getToken } from "./auth";
import { PlatformClient } from "./client";
import { readProjectConfig } from "./project";
import { getRequestedProjectSlug, resolveProjectBySlug } from "./deploy";
import type { SecretArgs } from "./secret-args";
import { cancel, isCancel, password } from "@clack/prompts";

export async function runSecretCommand(root: string, args: SecretArgs): Promise<void> {
  const token = getToken();
  if (!token) {
    console.error("Not logged in. Run `vcd login` first.");
    process.exit(1);
  }

  const client = new PlatformClient(token);
  const requestedProjectName = getRequestedProjectSlug({ projectSlug: args.projectName });
  let projectId: string;
  if (requestedProjectName) {
    const projects = await client.listProjects();
    projectId = resolveProjectBySlug(projects, requestedProjectName).projectId;
  } else {
    const config = readProjectConfig(root);
    if (!config) {
      throw new Error(
        "No linked project found. Run `vcd link`, `vcd deploy`, or pass --project <name>.",
      );
    }
    projectId = config.projectId;
  }

  if (args.action === "put") {
    const value = await readSecretValue();
    await client.setSecret(projectId, args.name, value);
    console.log(`Secret ${args.name} set.`);
    return;
  }

  await client.deleteSecret(projectId, args.name);
  console.log(`Secret ${args.name} deleted.`);
}

async function readSecretValue(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const value = Buffer.concat(chunks).toString("utf-8");
    if (value.length === 0) {
      throw new Error("Secret value is required.");
    }
    return value;
  }

  const result = await password({
    message: "Enter secret value:",
    mask: "*",
  });

  if (isCancel(result)) {
    cancel("Secret command cancelled.");
    process.exit(0);
  }

  const value = result ?? "";
  if (value.length === 0) {
    throw new Error("Secret value is required.");
  }
  return value;
}
