import { Hono } from "hono";
import type { ApiEnv } from "../../env";
import { getAllowlist, putAllowlist } from "../../signup-allowlist";
import { SignupControlPage } from "../views/signup-control";

const app = new Hono<ApiEnv>();

// GET /signup-control
app.get("/", async (c) => {
  const enabled = (await c.env.ROUTING.get("signup:enabled")) === "true";
  const entries = await getAllowlist(c.env.ROUTING);
  return c.html(
    <SignupControlPage enabled={enabled} entries={entries} username={c.get("user").login} />,
  );
});

// POST /signup-control/toggle
app.post("/toggle", async (c) => {
  const current = (await c.env.ROUTING.get("signup:enabled")) === "true";
  await c.env.ROUTING.put("signup:enabled", String(!current));
  return c.redirect("/admin/signup-control");
});

// POST /signup-control/add
app.post("/add", async (c) => {
  const body = await c.req.parseBody();
  const type = body.type as string;
  const pattern = (body.pattern as string)?.trim();
  const note = ((body.note as string) || "").trim();

  if (!pattern || (type !== "github" && type !== "email")) {
    return c.html("<h1>Invalid entry</h1>", 400);
  }

  const entries = await getAllowlist(c.env.ROUTING);
  entries.push({ type: type as "github" | "email", pattern, note: note || undefined });
  await putAllowlist(c.env.ROUTING, entries);
  return c.redirect("/admin/signup-control");
});

// POST /signup-control/delete
app.post("/delete", async (c) => {
  const body = await c.req.parseBody();
  const index = parseInt(body.index as string, 10);
  const entries = await getAllowlist(c.env.ROUTING);

  if (isNaN(index) || index < 0 || index >= entries.length) {
    return c.html("<h1>Invalid index</h1>", 400);
  }

  entries.splice(index, 1);
  await putAllowlist(c.env.ROUTING, entries);
  return c.redirect("/admin/signup-control");
});

export default app;
