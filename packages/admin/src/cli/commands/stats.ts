import type { AdminClient } from "../client";

export async function statsCommand(client: AdminClient): Promise<void> {
  const data = (await client.get("/admin/stats")) as {
    users: number;
    projects: number;
    deployments: number;
  };
  console.log("");
  console.log(`Users:        ${data.users}`);
  console.log(`Projects:     ${data.projects}`);
  console.log(`Deployments:  ${data.deployments}`);
}
