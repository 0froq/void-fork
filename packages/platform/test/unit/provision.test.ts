import { describe, it, expect, vi, beforeEach } from "vitest";
import { provisionBindings } from "../../src/provisioning/provision";
import type { DeployManifest, Resource } from "../../src/types";

// Mock the CF API module
vi.mock("../../src/provisioning/cloudflare-api", () => ({
  createD1Database: vi.fn().mockResolvedValue({ uuid: "d1-uuid-123", name: "test-DB" }),
  createKVNamespace: vi.fn().mockResolvedValue({ id: "kv-id-456", title: "test-KV" }),
  createR2Bucket: vi.fn().mockResolvedValue({ name: "test-STORAGE" }),
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
} from "../../src/provisioning/cloudflare-api";
import { getProjectResources, createResource } from "../../src/db";

const ACCOUNT_ID = "test-account";
const API_TOKEN = "test-token";
const PROJECT_ID = "proj_abc123";
const mockDb = {} as D1Database;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProjectResources).mockResolvedValue([]);
});

describe("provisionBindings", () => {
  it("provisions D1 when manifest requires it and no resource exists", async () => {
    const manifest: DeployManifest = { bindings: { d1: ["DB"] } };

    const bindings = await provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest);

    expect(createD1Database).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, `${PROJECT_ID}-DB`);
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, "d1", "d1-uuid-123", "DB");
    expect(bindings).toEqual([{ type: "d1", name: "DB", id: "d1-uuid-123" }]);
  });

  it("provisions KV when manifest requires it", async () => {
    const manifest: DeployManifest = { bindings: { kv: ["KV"] } };

    const bindings = await provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest);

    expect(createKVNamespace).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, `${PROJECT_ID}-KV`);
    expect(createResource).toHaveBeenCalledWith(mockDb, PROJECT_ID, "kv", "kv-id-456", "KV");
    expect(bindings).toEqual([{ type: "kv_namespace", name: "KV", namespace_id: "kv-id-456" }]);
  });

  it("provisions R2 when manifest requires it", async () => {
    const manifest: DeployManifest = { bindings: { r2: ["STORAGE"] } };

    const bindings = await provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest);

    expect(createR2Bucket).toHaveBeenCalledWith(ACCOUNT_ID, API_TOKEN, `${PROJECT_ID}-STORAGE`);
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

    const manifest: DeployManifest = { bindings: { d1: ["DB"] } };
    const bindings = await provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest);

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled();
    expect(bindings).toEqual([{ type: "d1", name: "DB", id: "existing-d1-id" }]);
  });

  it("handles multiple bindings in one deploy", async () => {
    const manifest: DeployManifest = {
      bindings: { d1: ["DB"], kv: ["KV"], r2: ["STORAGE"] },
    };

    const bindings = await provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest);

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
    const manifest: DeployManifest = { bindings: {} };

    const bindings = await provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest);

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createKVNamespace).not.toHaveBeenCalled();
    expect(createR2Bucket).not.toHaveBeenCalled();
    expect(createResource).not.toHaveBeenCalled();
    expect(bindings).toEqual([]);
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
      bindings: { d1: ["DB"], kv: ["KV"] },
    };

    const bindings = await provisionBindings(mockDb, ACCOUNT_ID, API_TOKEN, PROJECT_ID, manifest);

    expect(createD1Database).not.toHaveBeenCalled();
    expect(createKVNamespace).toHaveBeenCalledOnce();
    expect(bindings).toHaveLength(2);
    expect(bindings[0]).toEqual({ type: "d1", name: "DB", id: "existing-d1-id" });
    expect(bindings[1]).toEqual({ type: "kv_namespace", name: "KV", namespace_id: "kv-id-456" });
  });
});
