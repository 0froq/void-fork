import { Hono } from "hono";
import type { AdminEnv } from "./env";
import { adminAuthMiddleware } from "./middleware/auth";
import login from "./routes/login";
import system from "./routes/system";
import users from "./routes/users";
import projects from "./routes/projects";
import deployments from "./routes/deployments";

const app = new Hono<AdminEnv>();

// Public routes (no auth)
app.route("/", login);

// Protected routes (admin auth via cookie)
app.use("/*", adminAuthMiddleware);
app.route("/", system);
app.route("/users", users);
app.route("/projects", projects);
app.route("/deployments", deployments);

export { app };

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<AdminEnv["Bindings"]>;
