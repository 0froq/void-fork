/** Expand complete route tokens without changing query strings or fragments. */
export function interpolateRouteParams(path: string, params?: Record<string, string>): string {
  if (!params) {
    return path;
  }
  const suffixIndex = path.search(/[?#]/);
  const pathname = suffixIndex === -1 ? path : path.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : path.slice(suffixIndex);
  return (
    pathname.replace(
      /(^|\/):([^/{}]+)(\{\.\+\})?(?=\/|$)/g,
      (token: string, prefix: string, name: string, catchAll: string | undefined) => {
        if (!Object.hasOwn(params, name)) {
          return token;
        }
        const value = params[name];
        return (
          prefix +
          (catchAll
            ? value.split('/').map(encodeURIComponent).join('/')
            : encodeURIComponent(value))
        );
      },
    ) + suffix
  );
}
