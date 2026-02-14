const DOMAIN_SUFFIX = ".vitecloud.app";

/**
 * Extract the project slug from a hostname.
 * Returns null if the hostname doesn't match the expected pattern.
 *
 * Examples:
 *   "my-app.vitecloud.app" → "my-app"
 *   "vitecloud.app" → null
 *   "foo.bar.vitecloud.app" → null (no subdomains)
 *   "example.com" → null
 */
export function extractSlug(hostname: string): string | null {
  if (!hostname.endsWith(DOMAIN_SUFFIX)) {
    return null;
  }

  const slug = hostname.slice(0, -DOMAIN_SUFFIX.length);

  // Must be non-empty and contain no dots (no nested subdomains)
  if (!slug || slug.includes(".")) {
    return null;
  }

  // Validate slug format: lowercase alphanumeric + dashes, no leading/trailing dash
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return null;
  }

  return slug;
}
