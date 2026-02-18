import * as p from "@clack/prompts";
import type { AdminClient } from "../client";
import type { User, Project } from "@vite-cloud/platform/types";

export async function usersCommand(
  client: AdminClient,
  subcommand: string | undefined,
  args: string[],
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  switch (subcommand) {
    case "list": {
      const params = new URLSearchParams();
      if (values.plan) params.set("search", values.plan as string);
      if (values.limit) params.set("limit", values.limit as string);
      const query = params.toString();
      const data = (await client.get(`/admin/users${query ? `?${query}` : ""}`)) as {
        users: User[];
      };
      if (data.users.length === 0) {
        p.log.info("No users found.");
        return;
      }
      console.log("");
      console.log(
        `${"ID".padEnd(20)} ${"Login".padEnd(20)} ${"Plan".padEnd(10)} ${"Role".padEnd(8)} Status`,
      );
      console.log("-".repeat(70));
      for (const user of data.users) {
        const status = user.suspended_reason ? `suspended (${user.suspended_reason})` : "active";
        console.log(
          `${user.id.padEnd(20)} ${user.login.padEnd(20)} ${user.plan.padEnd(10)} ${user.role.padEnd(8)} ${status}`,
        );
      }
      console.log(`\n${data.users.length} user(s)`);
      break;
    }

    case "get": {
      const id = args[0];
      if (!id) {
        p.log.error("Usage: vca users get <id>");
        process.exit(1);
      }
      const data = (await client.get(`/admin/users/${id}`)) as {
        user: User;
        projects: Project[];
      };
      console.log("");
      console.log(`ID:        ${data.user.id}`);
      console.log(`Login:     ${data.user.login}`);
      console.log(`Provider:  ${data.user.provider}`);
      console.log(`Email:     ${data.user.email ?? "-"}`);
      console.log(`Plan:      ${data.user.plan}`);
      console.log(`Role:      ${data.user.role}`);
      console.log(`Status:    ${data.user.suspended_reason ?? "active"}`);
      console.log(`Created:   ${data.user.created_at}`);
      if (data.projects.length > 0) {
        console.log(`\nProjects (${data.projects.length}):`);
        for (const project of data.projects) {
          console.log(`  ${project.slug} (${project.id}) - ${project.mode}`);
        }
      }
      break;
    }

    case "plan": {
      const id = args[0];
      const plan = args[1];
      if (!id || !plan) {
        p.log.error("Usage: vca users plan <id> <plan>");
        process.exit(1);
      }
      await client.post(`/admin/users/${id}/plan`, { plan });
      p.log.success(`Updated user ${id} to plan: ${plan}`);
      break;
    }

    case "suspend": {
      const id = args[0];
      if (!id) {
        p.log.error("Usage: vca users suspend <id>");
        process.exit(1);
      }
      await client.post(`/admin/users/${id}/suspend`, { reason: "admin_suspended" });
      p.log.success(`Suspended user ${id}`);
      break;
    }

    case "unsuspend": {
      const id = args[0];
      if (!id) {
        p.log.error("Usage: vca users unsuspend <id>");
        process.exit(1);
      }
      await client.post(`/admin/users/${id}/unsuspend`);
      p.log.success(`Unsuspended user ${id}`);
      break;
    }

    default:
      p.log.error(`Unknown users subcommand: ${subcommand}`);
      process.exit(1);
  }
}
