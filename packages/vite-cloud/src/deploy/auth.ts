import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
  const credentialsPath = join(homedir(), ".vite-cloud", "credentials.json");
  try {
    const raw = readFileSync(credentialsPath, "utf-8");
    const credentials = JSON.parse(raw);
    if (credentials.token) {
      return credentials.token;
    }
  } catch {
    // File doesn't exist or is invalid
  }

  return null;
}
