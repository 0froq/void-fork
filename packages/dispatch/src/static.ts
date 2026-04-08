export interface AssetConfig {
  not_found_handling?: 'none' | 'single-page-application' | '404-page';
  html_handling?: 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';
}

export interface ResolvedAsset {
  path: string;
  hash: string;
  redirect?: string;
  notFound?: boolean;
  spa?: boolean;
}

/**
 * Resolve a request pathname to a manifest entry using AssetConfig rules.
 * Replicates Cloudflare Workers Assets path resolution behavior.
 */
export function resolveStaticPath(
  pathname: string,
  manifest: Record<string, string>,
  config: AssetConfig,
): ResolvedAsset | null {
  // Exact match always wins
  if (manifest[pathname]) {
    return { path: pathname, hash: manifest[pathname] };
  }

  const htmlHandling = config.html_handling ?? 'auto-trailing-slash';

  switch (htmlHandling) {
    case 'auto-trailing-slash': {
      // Try appending .html first (preferred over /index.html)
      const withHtml = pathname + '.html';
      if (manifest[withHtml]) {
        return { path: withHtml, hash: manifest[withHtml] };
      }
      // Try /index.html
      const withIndex = (pathname.endsWith('/') ? pathname : pathname + '/') + 'index.html';
      if (manifest[withIndex]) {
        return { path: withIndex, hash: manifest[withIndex] };
      }
      break;
    }
    case 'force-trailing-slash': {
      // If path doesn't end with /, redirect to trailing slash version
      if (!pathname.endsWith('/') && pathname !== '/') {
        const withIndex = pathname + '/index.html';
        if (manifest[withIndex]) {
          return {
            path: withIndex,
            hash: manifest[withIndex],
            redirect: pathname + '/',
          };
        }
      }
      // Serve /path/ from /path/index.html
      const indexPath = pathname + 'index.html';
      if (manifest[indexPath]) {
        return { path: indexPath, hash: manifest[indexPath] };
      }
      break;
    }
    case 'drop-trailing-slash': {
      // Root path: serve /index.html directly
      if (pathname === '/') {
        if (manifest['/index.html']) {
          return { path: '/index.html', hash: manifest['/index.html'] };
        }
        break;
      }
      // If path ends with /, redirect to non-trailing-slash version
      if (pathname.endsWith('/')) {
        const withoutSlash = pathname.slice(0, -1);
        const withHtml = withoutSlash + '.html';
        if (manifest[withHtml]) {
          return {
            path: withHtml,
            hash: manifest[withHtml],
            redirect: withoutSlash,
          };
        }
      }
      // Serve /path from /path.html
      const withHtml = pathname + '.html';
      if (manifest[withHtml]) {
        return { path: withHtml, hash: manifest[withHtml] };
      }
      break;
    }
    case 'none':
      break;
  }

  // Not found handling
  switch (config.not_found_handling ?? 'none') {
    case 'single-page-application':
      if (manifest['/index.html']) {
        return {
          path: '/index.html',
          hash: manifest['/index.html'],
          spa: true,
        };
      }
      break;
    case '404-page':
      if (manifest['/404.html']) {
        return {
          path: '/404.html',
          hash: manifest['/404.html'],
          notFound: true,
        };
      }
      break;
  }

  return null;
}

const MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  ico: 'image/x-icon',
  webp: 'image/webp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
};

/**
 * Get the Content-Type header value for a given file path based on its extension.
 */
export function getContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}
