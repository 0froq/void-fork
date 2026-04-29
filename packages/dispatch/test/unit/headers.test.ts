import { describe, it, expect } from 'vitest';
import { applyHeaderRules, type HeaderRule } from '../../src/headers.ts';

describe('applyHeaderRules', () => {
  it('returns original response when no rules', () => {
    const original = new Response('body', {
      headers: { 'Content-Type': 'text/html' },
    });
    const result = applyHeaderRules(original, '/index.html');
    expect(result).toBe(original);
  });

  it('returns original response when rules is empty array', () => {
    const original = new Response('body');
    const result = applyHeaderRules(original, '/index.html', []);
    expect(result).toBe(original);
  });

  it('returns original response when no rules match', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/assets/*', headers: [['Cache-Control', 'immutable']] },
    ];
    const original = new Response('body');
    const result = applyHeaderRules(original, '/index.html', rules);
    expect(result).toBe(original);
  });

  it('applies matching rule headers', () => {
    const rules: Array<HeaderRule> = [{ pattern: '/*', headers: [['X-Frame-Options', 'DENY']] }];
    const original = new Response('body', {
      headers: { 'Content-Type': 'text/html' },
    });
    const result = applyHeaderRules(original, '/index.html', rules);
    expect(result).not.toBe(original);
    expect(result.headers.get('X-Frame-Options')).toBe('DENY');
    expect(result.headers.get('Content-Type')).toBe('text/html');
  });

  it('overrides existing headers from matching rules', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/assets/*', headers: [['Cache-Control', 'public, max-age=31536000, immutable']] },
    ];
    const original = new Response('body', {
      headers: { 'Cache-Control': 'no-cache' },
    });
    const result = applyHeaderRules(original, '/assets/app.js', rules);
    expect(result.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('merges headers from multiple matching rules', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['X-Frame-Options', 'DENY']] },
      { pattern: '/assets/*', headers: [['Cache-Control', 'immutable']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/assets/app.js', rules);
    expect(result.headers.get('X-Frame-Options')).toBe('DENY');
    expect(result.headers.get('Cache-Control')).toBe('immutable');
  });

  it('last matching rule wins for same header name', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Cache-Control', 'no-cache']] },
      { pattern: '/assets/*', headers: [['Cache-Control', 'immutable']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/assets/app.js', rules);
    expect(result.headers.get('Cache-Control')).toBe('immutable');
  });

  it('preserves response body and status', async () => {
    const rules: Array<HeaderRule> = [{ pattern: '/*', headers: [['X-Custom', 'value']] }];
    const original = new Response('hello', { status: 201 });
    const result = applyHeaderRules(original, '/test', rules);
    expect(result.status).toBe(201);
    expect(await result.text()).toBe('hello');
  });

  it('blocks Set-Cookie header', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Set-Cookie', 'session=abc123']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('Set-Cookie')).toBeNull();
  });

  it('blocks set-cookie header (lowercase)', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['set-cookie', 'session=abc123']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('set-cookie')).toBeNull();
  });

  it('allows Strict-Transport-Security header (per-domain, safe)', () => {
    const rules: Array<HeaderRule> = [
      { pattern: '/*', headers: [['Strict-Transport-Security', 'max-age=31536000']] },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  });

  it('allows normal headers like X-Custom-Header', () => {
    const rules: Array<HeaderRule> = [{ pattern: '/*', headers: [['X-Custom-Header', 'hello']] }];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('X-Custom-Header')).toBe('hello');
  });

  it('allows Cache-Control and Content-Type headers', () => {
    const rules: Array<HeaderRule> = [
      {
        pattern: '/*',
        headers: [
          ['Cache-Control', 'public, max-age=3600'],
          ['Content-Type', 'text/plain'],
        ],
      },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(result.headers.get('Content-Type')).toBe('text/plain');
  });

  it('blocks only blocked headers while allowing others in same rule', () => {
    const rules: Array<HeaderRule> = [
      {
        pattern: '/*',
        headers: [
          ['X-Frame-Options', 'DENY'],
          ['Set-Cookie', 'evil=true'],
          ['Cache-Control', 'no-cache'],
        ],
      },
    ];
    const result = applyHeaderRules(new Response('body'), '/index.html', rules);
    expect(result.headers.get('X-Frame-Options')).toBe('DENY');
    expect(result.headers.get('Set-Cookie')).toBeNull();
    expect(result.headers.get('Cache-Control')).toBe('no-cache');
  });
});
