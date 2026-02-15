import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempHomes: string[] = [];

function setIsolatedHome(): void {
  const dir = mkdtempSync(join(tmpdir(), "vite-cloud-home-"));
  tempHomes.push(dir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

async function importRunListCommand() {
  vi.resetModules();
  const mod = await import("../../src/cli/list");
  return mod.runListCommand;
}

describe("runListCommand", () => {
  afterEach(() => {
    delete process.env.VITE_CLOUD_TOKEN;
    delete process.env.VITE_CLOUD_API_URL;

    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    while (tempHomes.length > 0) {
      const dir = tempHomes.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints projects for the authenticated user", async () => {
    setIsolatedHome();
    process.env.VITE_CLOUD_TOKEN = "test-token";
    process.env.VITE_CLOUD_API_URL = "https://api.example.test";

    const fetchMock = vi.fn(async () =>
      Response.json([
        {
          id: "proj_1",
          user_id: "user_1",
          slug: "star-tracker",
          name: "Star Tracker",
          created_at: "2026-02-15T00:00:00.000Z",
        },
        {
          id: "proj_2",
          user_id: "user_1",
          slug: "todo-app",
          name: "Todo App",
          created_at: "2026-02-15T00:00:00.000Z",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runListCommand = await importRunListCommand();
    await runListCommand();

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/projects", {
      headers: { Authorization: "Bearer test-token" },
    });
    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toContain("name");
    expect(lines[0]).toContain("project id");
    expect(lines[0]).toContain("url");
    expect(lines[0]).toContain("\x1b[1m");
    expect(lines[0]).toContain("\x1b[36m");
    expect(lines[0]).toContain("\x1b[0m");
    expect(lines[1]).toContain("star-tracker");
    expect(lines[1]).toContain("proj_1");
    expect(lines[1]).toContain("https://star-tracker.vitecloud.app");
    expect(lines[2]).toContain("todo-app");
    expect(lines[2]).toContain("proj_2");
    expect(lines[2]).toContain("https://todo-app.vitecloud.app");
  });

  it("prints a friendly message when there are no projects", async () => {
    setIsolatedHome();
    process.env.VITE_CLOUD_TOKEN = "test-token";
    process.env.VITE_CLOUD_API_URL = "https://api.example.test";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const runListCommand = await importRunListCommand();
    await runListCommand();

    expect(logSpy).toHaveBeenCalledWith("No projects found.");
  });

  it("exits with error when not logged in", async () => {
    setIsolatedHome();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    const runListCommand = await importRunListCommand();
    await expect(runListCommand()).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Not logged in. Run `vcd login` first.");
    expect(exitSpy).toHaveBeenCalled();
  });
});
