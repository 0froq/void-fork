import { Hono } from "hono";
import type { PlatformEnv } from "./env";
import auth from "./routes/auth";
import projects from "./routes/projects";
import deploy from "./routes/deploy";
import deleteRoute from "./routes/delete";
import revalidate from "./routes/revalidate";
import secrets from "./routes/secrets";
import { authMiddleware } from "./middleware/auth";

const app = new Hono<PlatformEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/auth", auth);
app.use("/me", authMiddleware);
app.get("/me", (c) => c.json({ login: c.get("userLogin") }));
app.use("/projects/*", authMiddleware);
app.route("/projects", projects);
app.route("/projects", deploy);
app.route("/projects", deleteRoute);
app.route("/projects", revalidate);
app.route("/projects", secrets);

export default app;
