export function validateProjectSlug(value: string | undefined): string | undefined {
  const slug = (value ?? '').trim();
  if (slug.length === 0) {
    return 'Project slug is required.';
  }

  // Allows lowercase alphanumeric with interior dashes.
  const valid =
    slug.length === 1 ? /^[a-z0-9]$/.test(slug) : /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug);
  if (!valid) {
    return 'Slug must be lowercase alphanumeric with dashes.';
  }
  if (slug.length <= 5) {
    return 'Slugs of 5 characters or fewer require a paid plan. Use at least 6 characters.';
  }

  return undefined;
}
