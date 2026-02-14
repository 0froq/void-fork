import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CREDENTIALS_DIR = join(homedir(), ".vite-cloud");
const CREDENTIALS_PATH = join(CREDENTIALS_DIR, "credentials.json");

/**
 * Read the deploy token from environment or credentials file.
 * Priority: VITE_CLOUD_TOKEN env var > ~/.vite-cloud/credentials.json
 */
export function getToken(): string | null {
  // 1. Check environment variable
  const envToken = process.env.VITE_CLOUD_TOKEN;
  if (envToken) {
    return envToken;
  }

  // 2. Check credentials file
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
    const credentials = JSON.parse(raw);
    if (credentials.token) {
      return credentials.token;
    }
  } catch {
    // File doesn't exist or is invalid
  }

  return null;
}

export function saveToken(token: string): void {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify({ token }, null, 2) + "\n", { mode: 0o600 });
}

const DEFAULT_API_URL = "https://api.vite.cloud";

/**
 * Start a local HTTP server, open the browser to the platform login page,
 * and wait for the OAuth callback with a JWT token.
 */
export async function runLogin(): Promise<string> {
  const http = await import("node:http");
  const { exec } = await import("node:child_process");

  const apiUrl = process.env.VITE_CLOUD_API_URL ?? DEFAULT_API_URL;

  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const token = url.searchParams.get("token");
      if (!token) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h1>Login failed</h1><p>No token received. Please try again.</p></body></html>",
        );
        server.close();
        reject(new Error("No token received from callback"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Login successful!</h1><p>You can close this tab and return to the terminal.</p></body></html>",
      );
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
      const loginUrl = `${apiUrl}/auth/login?redirect=${encodeURIComponent(redirect)}`;

      // Open browser with platform detection
      const platform = process.platform;
      const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
      exec(`${cmd} "${loginUrl}"`);
    });

    // 5-minute timeout
    setTimeout(
      () => {
        server.close();
        reject(new Error("Login timed out after 5 minutes"));
      },
      5 * 60 * 1000,
    );
  });
}
