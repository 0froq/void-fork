import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function readToken(): string {
  const credPath = join(homedir(), ".vite-cloud", "credentials.json");
  try {
    const data = JSON.parse(readFileSync(credPath, "utf-8")) as { token?: string };
    if (!data.token) {
      throw new Error("No token found in credentials.json. Run `vcd login` first.");
    }
    return data.token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Not logged in. Run `vcd login` first.");
    }
    throw err;
  }
}

export interface AdminClient {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
}

export function createClient(apiUrl: string): AdminClient {
  const token = readToken();

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }

    return res.json();
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
  };
}
