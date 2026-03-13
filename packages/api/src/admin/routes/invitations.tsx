import { Hono } from "hono";
import type { ApiEnv } from "../../env";
import { getAllowlist, putAllowlist } from "../../signup-allowlist";
import {
  createInvitation,
  revokeInvitation,
  getInvitation,
  getPendingInvitationByEmail,
  getAllInvitations,
  countInvitations,
  getUserByEmail,
} from "../../db";
import { sendInvitationEmail } from "../../email";
import { InvitationsPage } from "../views/invitations";

const PAGE_SIZE = 50;

const app = new Hono<ApiEnv>();

// GET /invitations
app.get("/", async (c) => {
  const db = c.get("db");
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [rows, total] = await Promise.all([
    getAllInvitations(db, PAGE_SIZE, offset),
    countInvitations(db),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return c.html(
    <InvitationsPage
      invitations={rows}
      page={page}
      totalPages={totalPages}
      username={c.get("userLogin")}
    />,
  );
});

// POST /invitations/send
app.post("/send", async (c) => {
  const db = c.get("db");
  const body = await c.req.parseBody();
  const email = (body.email as string)?.trim().toLowerCase();

  if (!email || !email.includes("@")) {
    return c.html("<h1>Invalid email address</h1>", 400);
  }

  const [existingUser, existingInvitation, entries] = await Promise.all([
    getUserByEmail(db, email),
    getPendingInvitationByEmail(db, email),
    getAllowlist(c.env.ROUTING),
  ]);

  if (existingUser) {
    return c.html("<h1>A user with this email already exists</h1>", 400);
  }

  if (existingInvitation) {
    return c.html("<h1>A pending invitation already exists for this email</h1>", 400);
  }

  if (entries.some((e) => e.type === "email" && e.pattern.toLowerCase() === email)) {
    return c.html("<h1>This email is already on the signup allowlist</h1>", 400);
  }

  const userId = c.get("userId");
  const login = c.get("userLogin");

  await createInvitation(db, email, userId);

  entries.push({ type: "email", pattern: email, note: `Invited by ${login}` });
  try {
    await putAllowlist(c.env.ROUTING, entries);
  } catch (err) {
    console.error(`Failed to update signup allowlist after inviting ${email}:`, err);
    return c.html("<h1>Invitation created but failed to update signup allowlist</h1>", 500);
  }

  // Send email (non-fatal — invitation + allowlist are already committed)
  if (c.env.EMAIL) {
    try {
      const baseUrl = c.req.url.startsWith("https://api.staging")
        ? "https://api.staging.void.cloud"
        : "https://api.void.cloud";
      await sendInvitationEmail(c.env.EMAIL, email, `${baseUrl}/invite`);
    } catch (err) {
      console.error(`Failed to send invitation email to ${email}:`, err);
    }
  }

  return c.redirect("/admin/invitations");
});

// POST /invitations/revoke
app.post("/revoke", async (c) => {
  const db = c.get("db");
  const body = await c.req.parseBody();
  const id = body.id as string;

  if (!id) {
    return c.html("<h1>Missing invitation ID</h1>", 400);
  }

  const invitation = await getInvitation(db, id);
  if (!invitation || invitation.status !== "pending") {
    return c.html("<h1>Invitation not found or not pending</h1>", 400);
  }

  // Remove from allowlist first so the invitee cannot sign up even if the DB
  // update below fails (admin can retry; the reverse leaves a stale entry).
  const entries = await getAllowlist(c.env.ROUTING);
  const filtered = entries.filter(
    (e) => !(e.type === "email" && e.pattern.toLowerCase() === invitation.email),
  );
  if (filtered.length !== entries.length) {
    await putAllowlist(c.env.ROUTING, filtered);
  }

  await revokeInvitation(db, id, c.get("userId"));

  return c.redirect("/admin/invitations");
});

export default app;
