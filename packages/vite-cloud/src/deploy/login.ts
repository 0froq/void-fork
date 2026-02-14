import { intro, outro, spinner } from "@clack/prompts";
import { getToken, runLogin, saveToken } from "./auth";

export async function runLoginCommand(): Promise<void> {
  intro("vite-cloud login");

  const existing = getToken();
  if (existing) {
    console.log("Already logged in.");
    console.log("To re-login, delete ~/.vite-cloud/credentials.json and run again.");
    return;
  }

  const s = spinner();
  s.start("Opening browser for GitHub login...");

  try {
    const token = await runLogin();
    saveToken(token);
    s.stop("Logged in!");
    outro("Token saved to ~/.vite-cloud/credentials.json");
  } catch (err) {
    s.stop("Login failed");
    throw err;
  }
}
