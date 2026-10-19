export function isSameOrigin(url: URL, origin: string): boolean {
  // Custom schemes have an opaque URL.origin, even for different hosts.
  if (url.protocol === 'capacitor:') {
    const current = new URL(origin);
    return current.protocol === 'capacitor:' && url.host !== '' && url.host === current.host;
  }
  return url.origin === origin;
}
