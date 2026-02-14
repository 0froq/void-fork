export interface RouteDefinition {
  /** URL pattern, e.g. "/api/users/:id" */
  pattern: string;
  /** HTTP method (lowercase) or "*" for all methods */
  method: string;
  /** Parameter names extracted from the pattern */
  params: string[];
  /** Whether this route has a catch-all parameter */
  catchAll: boolean;
  /** Environment restriction: "dev", "prod", or null */
  env: string | null;
  /** Original relative file path */
  filePath: string;
}

const EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];
const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];
const ENV_SUFFIXES = ["dev", "prod"];

/**
 * Parse a route filename (relative to routes/) into a RouteDefinition.
 *
 * Rules (applied in order):
 * 1. Strip file extension (.ts, .js, .mts, .mjs)
 * 2. Check for env suffix (.dev, .prod) → strip and record
 * 3. Check for HTTP method suffix (.get, .post, etc.) → strip and record; default "*"
 * 4. Strip trailing "index" segment
 * 5. Remove route group directories: (groupname)
 * 6. Convert [param] → :param, [...param] → **:param, [...] → **
 * 7. Prefix with /
 */
export function parseRouteFilename(relativePath: string): RouteDefinition {
  const filePath = relativePath;

  // Normalize path separators
  let path = relativePath.replace(/\\/g, "/");

  // 1. Strip extension
  for (const ext of EXTENSIONS) {
    if (path.endsWith(ext)) {
      path = path.slice(0, -ext.length);
      break;
    }
  }

  // Split into segments for processing
  const segments = path.split("/");
  let filename = segments.pop()!;

  // 2. Check for env suffix
  let env: string | null = null;
  for (const suffix of ENV_SUFFIXES) {
    if (filename.endsWith(`.${suffix}`)) {
      env = suffix;
      filename = filename.slice(0, -(suffix.length + 1));
      break;
    }
  }

  // 3. Check for HTTP method suffix
  let method = "*";
  for (const m of HTTP_METHODS) {
    if (filename.endsWith(`.${m}`)) {
      method = m;
      filename = filename.slice(0, -(m.length + 1));
      break;
    }
  }

  // Reassemble segments
  segments.push(filename);

  // 4. Strip trailing "index"
  if (segments[segments.length - 1] === "index") {
    segments.pop();
  }

  // 5. Remove route groups: (groupname)
  const filtered = segments.filter((s) => !s.startsWith("(") || !s.endsWith(")"));

  // 6. Convert dynamic segments
  const params: string[] = [];
  let catchAll = false;

  const converted = filtered.map((segment) => {
    // [...param] - catch-all with named param
    if (segment.startsWith("[...") && segment.endsWith("]")) {
      const paramName = segment.slice(4, -1);
      catchAll = true;
      if (paramName) {
        params.push(paramName);
        return `**:${paramName}`;
      }
      return "**";
    }
    // [param] - single dynamic param
    if (segment.startsWith("[") && segment.endsWith("]")) {
      const paramName = segment.slice(1, -1);
      params.push(paramName);
      return `:${paramName}`;
    }
    return segment;
  });

  // 7. Build pattern with leading /
  const pattern = "/" + converted.join("/");

  return {
    pattern,
    method,
    params,
    catchAll,
    env,
    filePath,
  };
}
