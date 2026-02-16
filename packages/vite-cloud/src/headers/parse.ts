export interface HeaderRule {
  pattern: string;
  headers: [string, string][];
}

/**
 * Parse a Netlify-compatible `_headers` file.
 *
 * Format:
 * - Pattern lines start with `/` and are not indented
 * - Header lines are indented, contain `Name: value`
 * - `#` comments and blank lines are ignored
 */
export function parseHeaders(content: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;

  for (const raw of content.split("\n")) {
    // Strip comments (only full-line comments)
    const line = raw.replace(/#.*$/, "");

    // Skip blank lines
    if (line.trim() === "") continue;

    // Pattern line: starts with `/` and is NOT indented
    if (line[0] === "/") {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
      continue;
    }

    // Header line: indented, belongs to the current pattern
    if (current && (line[0] === " " || line[0] === "\t")) {
      const trimmed = line.trim();
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;
      const name = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (name) {
        current.headers.push([name, value]);
      }
    }
  }

  return rules;
}
