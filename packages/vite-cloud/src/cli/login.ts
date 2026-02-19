import { intro, outro, log, spinner, select, isCancel, cancel } from "@clack/prompts";
import { getToken, runLogin, saveToken, isStagingMode } from "./auth";

export async function runLoginCommand(): Promise<void> {
  console.log();
  intro("\x1b[34mvite-cloud login\x1b[0m");

  const existing = getToken();
  if (existing) {
    log.warn("Already logged in.");
    outro("To re-login, run `vcd logout` first.");
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
    outro(
      isStagingMode()
        ? "Staging token saved to ~/.vite-cloud/config.json"
        : "Token saved to ~/.vite-cloud/config.json",
    );
  } catch (err) {
    s.stop("Login failed");
    throw err;
  }
}
