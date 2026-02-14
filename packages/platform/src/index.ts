import { Hono } from "hono";
import type { PlatformEnv } from "./env";
import auth from "./routes/auth";
import projects from "./routes/projects";
import deploy from "./routes/deploy";
import { authMiddleware } from "./middleware/auth";

const app = new Hono<PlatformEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/auth", auth);
app.use("/projects/*", authMiddleware);
app.route("/projects", projects);
app.route("/projects", deploy);

export default app;
