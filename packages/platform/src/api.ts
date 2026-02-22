// Type-only API route definition for use by the dashboard's hc client.
// This file must NOT import admin routes (.tsx) — the dashboard's tsconfig
// doesn't support Hono JSX.

import { Hono } from "hono";
import type { PlatformEnv } from "./env";
import me from "./routes/me";
import projects from "./routes/projects";
import secrets from "./routes/secrets";
import domains from "./routes/domains";
import { projectUsage, accountUsage } from "./routes/usage";

const api = new Hono<PlatformEnv>()
  .route("/me", me)
  .route("/projects", projects)
  .route("/projects", secrets)
  .route("/projects", domains)
  .route("/projects", projectUsage)
  .route("/usage", accountUsage);

export type ApiRoutes = typeof api;
