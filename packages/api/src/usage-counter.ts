import { DurableObject } from "cloudflare:workers";
import { getPlanLimits, isWithinLimit } from "./tiers";
import { createDb, suspendUser } from "./db";
import { queryProjectAiUsage } from "./routes/usage";
import type { ApiEnv } from "./env";

// --- Exported types ---

export interface CounterState {
  totalRequests: number;
  totalNeurons: number;
  plan: string;
  billingPeriodStart: string; // ISO date
  requestsSuspended: boolean;
  aiSuspended: boolean;
  projectSlugs: Record<string, string>; // projectId → slug
}

export interface UsageEvent {
  projectId: string;
  userId: string;
  slug: string;
  requests: number;
  responseBytes: number;
}

// --- Pure functions (exported for unit testing) ---

/** Returns true if adding incomingRequests would exceed the plan's requestsPerMonth limit. */
export function evaluateRequestLimit(state: CounterState, incomingRequests: number): boolean {
  const limits = getPlanLimits(state.plan);
  return !isWithinLimit(limits.requestsPerMonth, state.totalRequests + incomingRequests);
}

/** Returns true if totalNeurons exceeds the plan's aiNeuronsPerMonth limit. Works for ALL plans. */
export function evaluateAiLimit(state: CounterState): boolean {
  const limits = getPlanLimits(state.plan);
  return !isWithinLimit(limits.aiNeuronsPerMonth, state.totalNeurons);
}

// --- Default state ---

function defaultState(): CounterState {
  return {
    totalRequests: 0,
    totalNeurons: 0,
    plan: "free",
    billingPeriodStart: new Date().toISOString(),
    requestsSuspended: false,
    aiSuspended: false,
    projectSlugs: {},
  };
}

// --- UsageCounter Durable Object ---

export class UsageCounter extends DurableObject<ApiEnv["Bindings"]> {
  private state: CounterState | null = null;

  private async getState(): Promise<CounterState> {
    if (this.state) return this.state;
    const stored = await this.ctx.storage.get<CounterState>("state");
    this.state = stored ?? defaultState();
    return this.state;
  }

  private async saveState(state: CounterState): Promise<void> {
    this.state = state;
    await this.ctx.storage.put("state", state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/record") {
      return this.handleRecord(request);
    }
    if (request.method === "POST" && path === "/rollover") {
      return this.handleRollover(request);
    }
    if (request.method === "POST" && path === "/init") {
      return this.handleInit(request);
    }
    if (request.method === "GET" && path === "/state") {
      return this.handleGetState();
    }

    return new Response("not found", { status: 404 });
  }

  private async handleRecord(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      events: UsageEvent[];
      plan?: string;
      userId: string;
    };
    const state = await this.getState();

    // Sum incoming requests
    const incomingRequests = body.events.reduce((sum, e) => sum + e.requests, 0);
    state.totalRequests += incomingRequests;

    // Update projectSlugs map
    for (const event of body.events) {
      state.projectSlugs[event.projectId] = event.slug;
    }

    // Update plan if provided
    if (body.plan) {
      state.plan = body.plan;
    }

    // Evaluate request limit
    const exceedsLimit = evaluateRequestLimit(state, 0); // already added above
    if (exceedsLimit && !state.requestsSuspended) {
      state.requestsSuspended = true;
      await this.suspendProjects(state.projectSlugs, "requests_exceeded");
      const db = createDb(this.env.DB);
      await suspendUser(db, body.userId, "requests_exceeded");
    }

    // Schedule AI alarm if not already set
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + 15 * 60 * 1000);
    }

    await this.saveState(state);

    return Response.json({
      totalRequests: state.totalRequests,
      suspended: state.requestsSuspended,
    });
  }

  private async handleRollover(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      billingPeriodStart: string;
      plan: string;
    };
    const state = await this.getState();

    // Only act if billingPeriodStart differs
    if (state.billingPeriodStart === body.billingPeriodStart) {
      return Response.json({
        rolled: false,
        unsuspendRequests: false,
        unsuspendAi: false,
        projectSlugs: state.projectSlugs,
      });
    }

    const wasRequestsSuspended = state.requestsSuspended;
    const wasAiSuspended = state.aiSuspended;

    state.totalRequests = 0;
    state.totalNeurons = 0;
    state.plan = body.plan;
    state.billingPeriodStart = body.billingPeriodStart;

    if (wasRequestsSuspended) {
      state.requestsSuspended = false;
    }
    if (wasAiSuspended) {
      state.aiSuspended = false;
    }

    await this.saveState(state);

    return Response.json({
      rolled: true,
      unsuspendRequests: wasRequestsSuspended,
      unsuspendAi: wasAiSuspended,
      projectSlugs: state.projectSlugs,
    });
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      plan: string;
      billingPeriodStart: string;
      projectSlugs: Record<string, string>;
    };
    const state = await this.getState();

    // Merge projectSlugs
    Object.assign(state.projectSlugs, body.projectSlugs);
    state.plan = body.plan;
    state.billingPeriodStart = body.billingPeriodStart;

    await this.saveState(state);
    return Response.json({ ok: true });
  }

  private async handleGetState(): Promise<Response> {
    const state = await this.getState();
    return Response.json(state);
  }

  // --- AI alarm handler ---

  async alarm(): Promise<void> {
    const state = await this.getState();
    const limits = getPlanLimits(state.plan);

    // Skip if plan has unlimited AI
    if (limits.aiNeuronsPerMonth === 0) return;

    // Skip if no projects
    const projectIds = Object.keys(state.projectSlugs);
    if (projectIds.length === 0) return;

    // Query AI Gateway for each project's neuron usage
    const since = new Date(state.billingPeriodStart);
    let totalNeurons = 0;
    for (const projectId of projectIds) {
      const result = await queryProjectAiUsage(
        this.env.CF_ACCOUNT_ID,
        this.env.CF_API_TOKEN,
        projectId,
        since,
      );
      totalNeurons += result.neurons;
    }

    state.totalNeurons = totalNeurons;

    // Evaluate AI limit
    const exceedsAi = evaluateAiLimit(state);
    if (exceedsAi && !state.aiSuspended) {
      state.aiSuspended = true;
      // Write ai-block KV keys for each project
      for (const projectId of projectIds) {
        await this.env.ROUTING.put(`ai-block:${projectId}`, "1");
      }
    } else if (!exceedsAi && state.aiSuspended) {
      state.aiSuspended = false;
      // Delete ai-block KV keys
      for (const projectId of projectIds) {
        await this.env.ROUTING.delete(`ai-block:${projectId}`);
      }
    }

    await this.saveState(state);

    // Re-schedule alarm for 15 minutes later
    await this.ctx.storage.setAlarm(Date.now() + 15 * 60 * 1000);
  }

  // --- Private helpers ---

  private async suspendProjects(
    projectSlugs: Record<string, string>,
    reason: string,
  ): Promise<void> {
    for (const slug of Object.values(projectSlugs)) {
      const raw = await this.env.ROUTING.get(slug);
      if (!raw) continue;
      const entry = JSON.parse(raw) as Record<string, unknown>;
      if (entry.suspended) continue; // already suspended
      entry.suspended = reason;
      await this.env.ROUTING.put(slug, JSON.stringify(entry));
    }
  }

  private async unsuspendProjects(
    projectSlugs: Record<string, string>,
    reason: string,
  ): Promise<void> {
    for (const slug of Object.values(projectSlugs)) {
      const raw = await this.env.ROUTING.get(slug);
      if (!raw) continue;
      const entry = JSON.parse(raw) as Record<string, unknown>;
      if (entry.suspended !== reason) continue; // only remove matching reason
      delete entry.suspended;
      await this.env.ROUTING.put(slug, JSON.stringify(entry));
    }
  }
}
