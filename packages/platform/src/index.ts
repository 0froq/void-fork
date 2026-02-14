import { Hono } from "hono";
import type { PlatformEnv } from "./env";
import projects from "./routes/projects";
import deploy from "./routes/deploy";

const app = new Hono<PlatformEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/projects", projects);
app.route("/projects", deploy);

export default app;
