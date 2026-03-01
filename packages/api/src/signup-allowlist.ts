export type AllowlistEntry = {
  type: "github" | "email";
  pattern: string;
  note?: string;
};

/**
 * Check if a signup should be allowed based on the allowlist.
 * If entries is empty, all signups are allowed.
 */
export function isSignupAllowed(
  provider: string,
  login: string,
  email: string | null,
  entries: AllowlistEntry[],
): boolean {
  if (entries.length === 0) return true;

  return entries.some((entry) => {
    if (entry.type === "github") {
      return provider === "github" && entry.pattern.toLowerCase() === login.toLowerCase();
    }
    // email entry — matches any provider if they have a matching email
    if (!email) return false;
    if (entry.pattern.startsWith("*@")) {
      const domain = entry.pattern.slice(1).toLowerCase();
      return email.toLowerCase().endsWith(domain);
    }
    return entry.pattern.toLowerCase() === email.toLowerCase();
  });
}
