import { describe, it, expect, vi, beforeEach } from "vitest";
import { provisionBindings } from "../../src/provisioning/provision";
import type { Db } from "../../src/db";
import type { DeployManifest, Resource } from "../../src/types";

// Mock the CF API module
vi.mock("../../src/provisioning/cloudflare-api", () => ({
  createD1Database: vi.fn().mockResolvedValue({ uuid: "d1-uuid-123", name: "test-DB" }),
  createKVNamespace: vi.fn().mockResolvedValue({ id: "kv-id-456", title: "test-KV" }),
  createR2Bucket: vi.fn().mockResolvedValue({ name: "test-STORAGE" }),
  createQueue: vi.fn().mockResolvedValue({ queue_id: "queue-id-789", queue_name: "test-queue" }),
  getD1DatabaseByName: vi.fn().mockResolvedValue({ uuid: "d1-looked-up", name: "test-DB" }),
  getKVNamespaceByTitle: vi.fn().mockResolvedValue({ id: "kv-looked-up", title: "test-KV" }),
  getQueueByName: vi.fn().mockResolvedValue({ queue_id: "queue-looked-up", queue_name: "test-q" }),
}));

// Mock db module
vi.mock("../../src/db", () => ({
  getProjectResources: vi.fn().mockResolvedValue([]),
  createResource: vi
    .fn()
    .mockImplementation(
      (_db: unknown, projectId: string, type: string, cfId: string, bindingName: string) =>
        Promise.resolve({
          id: `res_mock`,
          project_id: projectId,
          type,
          cf_id: cfId,
          binding_name: bindingName,
          created_at: new Date().toISOString(),
        }),
    ),
}));

import {
  createD1Database,
  createKVNamespace,
  createR2Bucket,
  getD1DatabaseByName,
  getKVNamespaceByTitle,
} from "../../src/provisioning/cloudflare-api";
import { getProjectResources, createResource } from "../../src/db";

const ACCOUNT_ID = "test-account";
const API_TOKEN = "test-token";
const PROJECT_ID = "proj_abc123";
const JWT_SECRET = "test-jwt-secret";
const mockDb = {} as Db;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProjectResources).mockResolvedValue([]);
});

describe("provisionBindings", () => {
  it("provisions D1 when manifest requires it and no resource exists", async () => {
    const manifest: DeployManifest = { version: 1, bindings: { d1: ["DB"] } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
    );

    expect(createD1Database).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, "proj-abc123-db");
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, "d1", "d1-uuid-123", "DB");
    expect(bindings).toEqual([{ type: "d1", name: "DB", id: "d1-uuid-123" }]);
  });

  it("provisions KV when manifest requires it", async () => {
    const manifest: DeployManifest = { version: 1, bindings: { kv: ["KV"] } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
    );

    expect(createKVNamespace).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, "proj-abc123-kv");
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, "kv", "kv-id-456", "KV");
    expect(bindings).toEqual([{ type: "kv_namespace", name: "KV", namespace_id: "kv-id-456" }]);
  });

  it("provisions R2 when manifest requires it", async () => {
    const manifest: DeployManifest = { version: 1, bindings: { r2: ["STORAGE"] } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
    );

    expect(createR2Bucket).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, "proj-abc123-storage");
    expect(createResource).toHaveBeenCalledWith(
      mockDb,
      PROJECT_ID,
      "r2",
      "test-STORAGE",
      "STORAGE",
    );
    expect(bindings).toEqual([{ type: "r2_bucket", name: "STORAGE", bucket_name: "test-STORAGE" }]);
  });

  it("skips provisioning when resources already exist", async () => {
    const existingResources: Resource[] = [
      {
        id: "res_existing",
        project_id: PROJECT_ID,
        type: "d1",
        cf_id: "existing-d1-id",
        binding_name: "DB",
        created_at: new Date().toISOString(),
      },
    ];
    vi.mocked(getProjectResources).mockResolvedValue(existingResources);

    const manifest: DeployManifest = { version: 1, bindings: { d1: ["DB"] } };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
    );

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled();
    expect(bindings).toEqual([{ type: "d1", name: "DB", id: "existing-d1-id" }]);
  });

  it("handles multiple bindings in one deploy", async () => {
    const manifest: DeployManifest = {
      version: 1,
      bindings: { d1: ["DB"], kv: ["KV"], r2: ["STORAGE"] },
    };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
    );

    expect(createD1Database).toHaveBeenCalledOnce();
    expect(createKVNamespace).toHaveBeenCalledOnce();
    expect(createR2Bucket).toHaveBeenCalledOnce();
    expect(bindings).toHaveLength(3);
    expect(bindings[0]).toEqual({ type: "d1", name: "DB", id: "d1-uuid-123" });
    expect(bindings[1]).toEqual({ type: "kv_namespace", name: "KV", namespace_id: "kv-id-456" });
    expect(bindings[2]).toEqual({
      type: "r2_bucket",
      name: "STORAGE",
      bucket_name: "test-STORAGE",
    });
  });

  it("handles empty manifest (no bindings needed)", async () => {
    const manifest: DeployManifest = { version: 1, bindings: {} };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
    );

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createKVNamespace).not.toHaveBeenCalled();
    expect(createR2Bucket).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled();
    expect(bindings).toEqual([]);
  });

  it("provisions AI bindings with signed token when manifest requires ai", async () => {
    const manifest: DeployManifest = { version: 1, bindings: { ai: true } };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
    );

    expect(bindings).toHaveLength(3);
    expect(bindings[0]).toEqual({ type: "service", name: "__AI_PROXY", service: "void-proxy" });
    expect(bindings[1]).toEqual({ type: "plain_text", name: "__PROJECT_ID", text: PROJECT_ID });
    expect(bindings[2].type).toBe("plain_text");
    expect(bindings[2].name).toBe("__AI_TOKEN");
    // Token should be a non-empty string (HMAC signature)
    expect(typeof bindings[2].text).toBe("string");
    expect(bindings[2].text!.length).toBeGreaterThan(0);
  });

  it("provisions only missing resources when some already exist", async () => {
    const existingResources: Resource[] = [
      {
        id: "res_existing",
        project_id: PROJECT_ID,
        type: "d1",
        cf_id: "existing-d1-id",
        binding_name: "DB",
        created_at: new Date().toISOString(),
      },
    ];
    vi.mocked(getProjectResources).mockResolvedValue(existingResources);

    const manifest: DeployManifest = {
      version: 1,
      bindings: { d1: ["DB"], kv: ["KV"] },
    };

    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
    );

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createKVNamespace).toHaveBeenCalledOnce();
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toEqual({ type: "d1", name: "DB", id: "existing-d1-id" });
    expect(bindings[1]).toEqual({ type: "kv_namespace", name: "KV", namespace_id: "kv-id-456" });
  });
});

describe("ensureResource — already exists fallback", () => {
  it("falls back to lookup when D1 create returns 'already exists'", async () => {
    vi.mocked(createD1Database).mockRejectedValueOnce(
      new Error("Cloudflare API error: A database with that name already exists"),
    );

    const manifest: DeployManifest = { version: 1, bindings: { d1: ["DB"] } };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
    );

    expect(createD1Database).toHaveBeenCalledOnce();
    expect(getD1DatabaseByName).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, "proj-abc123-db");
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, "d1", "d1-looked-up", "DB");
    expect(bindings).toEqual([{ type: "d1", name: "DB", id: "d1-looked-up" }]);
  });

  it("falls back to lookup when KV create returns 'already exists'", async () => {
    vi.mocked(createKVNamespace).mockRejectedValueOnce(
      new Error("Cloudflare API error: A namespace with that title already exists"),
    );

    const manifest: DeployManifest = { version: 1, bindings: { kv: ["KV"] } };
    const bindings = await provisionBindings(
      mockDb,
      ACCOUNT_ID,
      API_TOKEN,
      PROJECT_ID,
      manifest,
      JWT_SECRET,
    );

    expect(createKVNamespace).toHaveBeenCalledOnce();
    expect(getKVNamespaceByTitle).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, "proj-abc123-kv");
    expect(bindings).toEqual([{ type: "kv_namespace", name: "KV", namespace_id: "kv-looked-up" }]);
  });

  it("propagates non-'already exists' errors", async () => {
    vi.mocked(createD1Database).mockRejectedValueOnce(
      new Error("Cloudflare API error: rate limit exceeded"),
    );

    const manifest: DeployManifest = { version: 1, bindings: { d1: ["DB"] } };
    await expect(
      provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest, JWT_SECRET),
    ).rejects.toThrow("rate limit exceeded");

    expect(getD1DatabaseByName).not.toHaveBeenCalled();
  });
});
