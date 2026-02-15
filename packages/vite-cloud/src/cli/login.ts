import { intro, outro, log, spinner, select, isCancel, cancel } from "@clack/prompts";
import { getToken, runLogin, saveToken } from "./auth";

export async function runLoginCommand(): Promise<void> {
  intro("vite-cloud login");

  const existing = getToken();
  if (existing) {
    log.warn("Already logged in.");
    outro("To re-login, delete ~/.vite-cloud/credentials.json and run again.");
    return;
  }

  const provider = await select({
    message: "Choose a login provider:",
    options: [
      { value: "github", label: "GitHub" },
      { value: "google", label: "Google" },
    ],
  });

  if (isCancel(provider)) {
    cancel("Login cancelled.");
    process.exit(0);
  }

  const providerName = provider === "github" ? "GitHub" : "Google";
  const s = spinner();
  s.start(`Opening browser for ${providerName} login...`);

  try {
    const token = await runLogin(provider);
    saveToken(token);
    s.stop("Logged in!");
    outro("Token saved to ~/.vite-cloud/credentials.json");
  } catch (err) {
    s.stop("Login failed");
    throw err;
  }
}
