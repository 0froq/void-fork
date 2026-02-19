import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".vite-cloud");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

interface Config {
  token?: string;
  stagingToken?: string;
  staging?: boolean;
  api?: string;
}

function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function isStagingMode(): boolean {
  return readConfig().staging === true || !!process.env.STAGING;
}

export function setStagingMode(on: boolean): void {
  const config = readConfig();
  if (on) {
    config.staging = true;
  } else {
    delete config.staging;
  }
  writeConfig(config);
}

export function getSiteDomain(): string {
  return isStagingMode() ? "staging.vitecloud.app" : "vitecloud.app";
}

export function printStagingBanner(): void {
  if (isStagingMode()) {
    console.log("\x1b[43m\x1b[30m \u26a0 STAGING MODE \x1b[0m\n");
  }
}

/**
 * Read the deploy token from environment or config file.
 * Priority: VITE_CLOUD_TOKEN env var > ~/.vite-cloud/config.json
 */
export function getToken(): string | null {
  const envToken = process.env.VITE_CLOUD_TOKEN;
  if (envToken) {
    return envToken;
  }

  const config = readConfig();
  return (isStagingMode() ? config.stagingToken : config.token) ?? null;
}

export function getTokenSource(): "ci" | "manual" {
  return process.env.VITE_CLOUD_TOKEN ? "ci" : "manual";
}

export function saveToken(token: string): void {
  const config = readConfig();
  if (isStagingMode()) {
    config.stagingToken = token;
  } else {
    config.token = token;
  }
  writeConfig(config);
}

export function removeToken(): boolean {
  try {
    const config = readConfig();
    const key = isStagingMode() ? "stagingToken" : "token";
    if (!config[key]) return false;
    delete config[key];
    writeConfig(config);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_API_URL = "https://platform.vite.cloud";
const STAGING_API_URL = "https://platform.staging.vite.cloud";

/**
 * Read the API URL from environment or config file.
 * Priority: VITE_CLOUD_API_URL env var > ~/.vite-cloud/config.json > default
 */
export function getApiUrl(): string {
  return (
    process.env.VITE_CLOUD_API_URL ??
    readConfig().api ??
    (isStagingMode() ? STAGING_API_URL : DEFAULT_API_URL)
  );
}

function page(title: string, message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - Vite Cloud</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#111}.card{text-align:center;padding:3rem}h1{font-size:1.5rem;font-weight:600;margin-bottom:.75rem}p{color:#666;font-size:1rem}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * Start a local HTTP server, open the browser to the platform login page,
 * and wait for the OAuth callback with a JWT token.
 */
export async function runLogin(provider = "github"): Promise<string> {
  const http = await import("node:http");
  const { exec } = await import("node:child_process");

  const apiUrl = getApiUrl();

  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      if (error === "email_conflict") {
        const existing = url.searchParams.get("existing_provider");
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          page(
            "Login failed",
            `This email is already registered with ${existing}. Please log in with ${existing} instead.`,
          ),
        );
        server.close();
        reject(
          new Error(
            `This email is already registered with ${existing}. Please log in with ${existing} instead.`,
          ),
        );
        return;
      }

      const token = url.searchParams.get("token");
      if (!token) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(page("Login failed", "No token received. Please try again."));
        server.close();
        reject(new Error("No token received from callback"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page("Login successful!", "You can close this tab and return to the terminal."));
      server.close();
      resolve(token);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start local server"));
        return;
      }

      const port = addr.port;
      const redirect = `http://localhost:${port}/callback`;
      const loginUrl = `${apiUrl}/auth/login?redirect=${encodeURIComponent(redirect)}&provider=${provider}`;

      // Open browser with platform detection
      const platform = process.platform;
      const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
      exec(`${cmd} "${loginUrl}"`);
    });

    // 5-minute timeout
    const timeout = setTimeout(
      () => {
        server.close();
        reject(new Error("Login timed out after 5 minutes"));
      },
      5 * 60 * 1000,
    );
    timeout.unref();
  });
}
