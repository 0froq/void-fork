import { DurableObject } from "cloudflare:workers";
import { createDb, getUser, getProject } from "./db";
import { sendErrorAlertEmail } from "./email";
import type { ApiEnv } from "./env";
import { DEFAULT_DASHBOARD_URL } from "./constants";

const DEBOUNCE_MS = 120_000; // 2 minutes
const COUNT_CAP = 100; // immediate fire
const COOLDOWN_MS = 86_400_000; // 24 hours

interface ErrorAlertState {
  count: number;
  projectId: string;
  userId: string;
  slug: string;
  lastAlertAt: number | null;
}

export class ErrorAlertMonitor extends DurableObject<ApiEnv["Bindings"]> {
  private state: ErrorAlertState | null = null;

  private async getState(): Promise<ErrorAlertState> {
    if (this.state) return this.state;
    const stored = await this.ctx.storage.get<ErrorAlertState>("state");
    this.state = stored ?? {
      count: 0,
      projectId: "",
      userId: "",
      slug: "",
      lastAlertAt: null,
    };
    return this.state;
  }

  private async saveState(state: ErrorAlertState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put("state", state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/record") {
      return this.handleRecord(request);
    }
    return new Response("not found", { status: 404 });
  }

  private async handleRecord(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      projectId: string;
      count: number;
      userId: string;
      slug: string;
    };

    const state = await this.getState();
    state.count += body.count;
    state.projectId = body.projectId;
    state.userId = body.userId;
    state.slug = body.slug;

    // Within cooldown — accumulate but don't schedule alarm
    if (state.lastAlertAt && Date.now() - state.lastAlertAt < COOLDOWN_MS) {
      await this.saveState(state);
      return Response.json({ ok: true });
    }

    // Count cap — fire immediately
    if (state.count >= COUNT_CAP) {
      await this.fireAlert(state);
      return Response.json({ ok: true });
    }

    // Debounce — reset alarm to now + 2 minutes
    await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
    await this.saveState(state);
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    const state = await this.getState();

    if (state.lastAlertAt && Date.now() - state.lastAlertAt < COOLDOWN_MS) {
      state.count = 0;
      await this.saveState(state);
      return;
    }

    await this.fireAlert(state);
  }

  private async fireAlert(state: ErrorAlertState): Promise<void> {
    if (!this.env.EMAIL) {
      state.count = 0;
      await this.ctx.storage.deleteAlarm();
      await this.saveState(state);
      return;
    }

    try {
      const db = createDb(this.env.HYPERDRIVE.connectionString);
      const user = await getUser(db, state.userId);
      if (!user?.email) {
        // No email on record — not transient, don't retry
        state.count = 0;
        await this.ctx.storage.deleteAlarm();
        await this.saveState(state);
        return;
      }
      // Resolve canonical slug from DB — dispatch may have sent a hostname for custom-domain traffic
      const project = await getProject(db, state.projectId);
      const slug = project?.slug ?? state.slug;
      const dashboardUrl = this.env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;
      await sendErrorAlertEmail(this.env.EMAIL, user.email, slug, state.count, dashboardUrl);
      // Success — cooldown and reset
      state.lastAlertAt = Date.now();
      state.count = 0;
      await this.ctx.storage.deleteAlarm();
      await this.saveState(state);
    } catch (err) {
      // Transient failure — keep count and schedule retry
      console.error("[error-alert-monitor] failed to send alert:", err);
      await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
      await this.saveState(state);
    }
  }
}
