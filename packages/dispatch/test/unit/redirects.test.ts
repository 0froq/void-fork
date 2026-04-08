import { describe, it, expect } from 'vitest';
import { applyRedirectRules } from '../../src/redirects';

describe('applyRedirectRules', () => {
  it('returns null when no rules', () => {
    expect(applyRedirectRules('/foo')).toBeNull();
    expect(applyRedirectRules('/foo', [])).toBeNull();
  });

  it('returns null when no match', () => {
    const rules = [{ source: '/old', destination: '/new', status: 301 }];
    expect(applyRedirectRules('/other', rules)).toBeNull();
  });

  it('matches exact paths', () => {
    const rules = [{ source: '/old', destination: '/new', status: 301 }];
    const res = applyRedirectRules('/old', rules);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(301);
    expect(res!.headers.get('Location')).toBe('/new');
  });

  it('matches wildcard patterns', () => {
    const rules = [{ source: '/blog/*', destination: '/posts', status: 302 }];
    const res = applyRedirectRules('/blog/hello-world', rules);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
    expect(res!.headers.get('Location')).toBe('/posts');
  });

  it('last match wins', () => {
    const rules = [
      { source: '/*', destination: '/catch-all', status: 302 },
      { source: '/specific', destination: '/targeted', status: 301 },
    ];
    const res = applyRedirectRules('/specific', rules);
    expect(res!.status).toBe(301);
    expect(res!.headers.get('Location')).toBe('/targeted');
  });

  it('substitutes :splat in destination', () => {
    const rules = [{ source: '/blog/*', destination: '/posts/:splat', status: 301 }];
    const res = applyRedirectRules('/blog/hello-world', rules);
    expect(res!.headers.get('Location')).toBe('/posts/hello-world');
  });

  it('returns correct status code', () => {
    const rules = [{ source: '/temp', destination: '/new', status: 307 }];
    const res = applyRedirectRules('/temp', rules);
    expect(res!.status).toBe(307);
  });

  it('returns empty body', () => {
    const rules = [{ source: '/old', destination: '/new', status: 301 }];
    const res = applyRedirectRules('/old', rules);
    expect(res!.body).toBeNull();
  });
});
