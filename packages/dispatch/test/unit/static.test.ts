import { describe, it, expect } from 'vitest';
import { resolveStaticPath, getContentType } from '../../src/static.ts';
import type { AssetConfig } from '../../src/static.ts';

const manifest: Record<string, string> = {
  '/index.html': 'hash_index',
  '/about.html': 'hash_about',
  '/about/index.html': 'hash_about_index',
  '/blog/post.html': 'hash_post',
  '/blog/index.html': 'hash_blog_index',
  '/assets/style.css': 'hash_css',
  '/404.html': 'hash_404',
};

describe('resolveStaticPath', () => {
  describe('exact match', () => {
    it('returns exact match for any html_handling mode', () => {
      const config: AssetConfig = { html_handling: 'none' };
      expect(resolveStaticPath('/assets/style.css', manifest, config)).toEqual({
        path: '/assets/style.css',
        hash: 'hash_css',
      });
    });
  });

  describe('html_handling: auto-trailing-slash (default)', () => {
    const config: AssetConfig = {};

    it('resolves /about to /about.html', () => {
      expect(resolveStaticPath('/about', manifest, config)).toEqual({
        path: '/about.html',
        hash: 'hash_about',
      });
    });

    it('resolves /blog to /blog/index.html when no .html exists', () => {
      const m = { '/blog/index.html': 'hash_blog_index' };
      expect(resolveStaticPath('/blog', m, config)).toEqual({
        path: '/blog/index.html',
        hash: 'hash_blog_index',
      });
    });

    it('resolves / to /index.html', () => {
      expect(resolveStaticPath('/', manifest, config)).toEqual({
        path: '/index.html',
        hash: 'hash_index',
      });
    });

    it('prefers .html over /index.html when both exist', () => {
      expect(resolveStaticPath('/about', manifest, config)).toEqual({
        path: '/about.html',
        hash: 'hash_about',
      });
    });
  });

  describe('html_handling: force-trailing-slash', () => {
    const config: AssetConfig = { html_handling: 'force-trailing-slash' };

    it('redirects /about to /about/ when /about/index.html exists', () => {
      expect(resolveStaticPath('/about', manifest, config)).toEqual({
        path: '/about/index.html',
        hash: 'hash_about_index',
        redirect: '/about/',
      });
    });

    it('serves /about/ directly from /about/index.html', () => {
      expect(resolveStaticPath('/about/', manifest, config)).toEqual({
        path: '/about/index.html',
        hash: 'hash_about_index',
      });
    });

    it('serves / from /index.html (no redirect for root)', () => {
      expect(resolveStaticPath('/', manifest, config)).toEqual({
        path: '/index.html',
        hash: 'hash_index',
      });
    });
  });

  describe('html_handling: drop-trailing-slash', () => {
    const config: AssetConfig = { html_handling: 'drop-trailing-slash' };

    it('redirects /about/ to /about when /about.html exists', () => {
      expect(resolveStaticPath('/about/', manifest, config)).toEqual({
        path: '/about.html',
        hash: 'hash_about',
        redirect: '/about',
      });
    });

    it('serves /about directly from /about.html', () => {
      expect(resolveStaticPath('/about', manifest, config)).toEqual({
        path: '/about.html',
        hash: 'hash_about',
      });
    });

    it('serves / from /index.html (no redirect for root)', () => {
      expect(resolveStaticPath('/', manifest, config)).toEqual({
        path: '/index.html',
        hash: 'hash_index',
      });
    });
  });

  describe('html_handling: none', () => {
    const config: AssetConfig = { html_handling: 'none' };

    it('returns null for /about (no exact match)', () => {
      const m = { '/about.html': 'hash' };
      expect(resolveStaticPath('/about', m, config)).toBeNull();
    });

    it('returns exact match for /about.html', () => {
      expect(resolveStaticPath('/about.html', manifest, config)).toEqual({
        path: '/about.html',
        hash: 'hash_about',
      });
    });
  });

  describe('not_found_handling: single-page-application', () => {
    const config: AssetConfig = {
      html_handling: 'none',
      not_found_handling: 'single-page-application',
    };

    it('falls back to /index.html for unknown paths', () => {
      expect(resolveStaticPath('/unknown/path', manifest, config)).toEqual({
        path: '/index.html',
        hash: 'hash_index',
        spa: true,
      });
    });
  });

  describe('not_found_handling: 404-page', () => {
    const config: AssetConfig = {
      html_handling: 'none',
      not_found_handling: '404-page',
    };

    it('falls back to /404.html for unknown paths', () => {
      expect(resolveStaticPath('/unknown', manifest, config)).toEqual({
        path: '/404.html',
        hash: 'hash_404',
        notFound: true,
      });
    });

    it('returns null when /404.html does not exist', () => {
      const m = { '/index.html': 'hash' };
      expect(resolveStaticPath('/unknown', m, config)).toBeNull();
    });
  });

  describe('not_found_handling: none', () => {
    const config: AssetConfig = {
      html_handling: 'none',
      not_found_handling: 'none',
    };

    it('returns null for unknown paths', () => {
      expect(resolveStaticPath('/unknown', manifest, config)).toBeNull();
    });
  });
});

describe('getContentType', () => {
  it('returns text/html for .html files', () => {
    expect(getContentType('/index.html')).toBe('text/html; charset=utf-8');
  });

  it('returns text/css for .css files', () => {
    expect(getContentType('/assets/style.css')).toBe('text/css; charset=utf-8');
  });

  it('returns text/javascript for .js files', () => {
    expect(getContentType('/app.js')).toBe('text/javascript; charset=utf-8');
  });

  it('returns application/json for .json files', () => {
    expect(getContentType('/data.json')).toBe('application/json; charset=utf-8');
  });

  it('returns image/png for .png files', () => {
    expect(getContentType('/logo.png')).toBe('image/png');
  });

  it('returns application/wasm for .wasm files', () => {
    expect(getContentType('/module.wasm')).toBe('application/wasm');
  });

  it('returns application/octet-stream for unknown extensions', () => {
    expect(getContentType('/file.xyz')).toBe('application/octet-stream');
  });

  it('returns application/octet-stream for files with no extension', () => {
    expect(getContentType('/LICENSE')).toBe('application/octet-stream');
  });
});
