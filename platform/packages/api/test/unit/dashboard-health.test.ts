import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vite-plus/test';
import { DashboardPage } from '../../src/admin/views/dashboard.tsx';

// A minimal DOM records text insertion and rejects HTML insertion. The test
// executes the actual inline script emitted by the dashboard, not a copy.
class Element {
  children: Array<Element> = [];
  style: Record<string, string> = {};
  private text = '';
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set innerHTML(_value: string) {
    throw new Error('Health diagnostics must not be inserted as HTML.');
  }
  append(...children: Array<Element>) {
    this.children.push(...children);
  }
  replaceChildren() {
    this.text = '';
    this.children = [];
  }
}

function dashboard(fetch: ReturnType<typeof vi.fn>) {
  const html = String(
    DashboardPage({
      stats: { users: 1, projects: 0, deployments: 0 },
      projects: [],
      deployments: [],
      topProjects: [],
      siteDomain: 'example.com',
      platformName: 'Example Platform',
      username: 'admin',
    }),
  );
  const script = Array.from(
    html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g),
    (match) => match[1],
  ).find((source) => source?.includes("fetch('/admin/health'"));
  expect(script).toBeDefined();
  const elements: Record<string, Element> = {
    'health-status': new Element(),
    'health-summary': new Element(),
    'health-checks': new Element(),
  };
  const interval = vi.fn();
  runInNewContext(script!, {
    document: {
      getElementById: (id: string) => elements[id],
      createElement: () => new Element(),
      createTextNode: (text: string) => {
        const node = new Element();
        node.textContent = text;
        return node;
      },
    },
    fetch,
    setInterval: interval,
  });
  expect(interval).toHaveBeenCalledWith(expect.any(Function), 30_000);
  return {
    summary: elements['health-summary']!,
    checks: elements['health-checks']!,
    poll: interval.mock.calls[0]![0] as () => void,
  };
}

it('renders failed checks with their reason as text, including untrusted error strings', async () => {
  const malicious = '<img src=x onerror="alert(1)">';
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      allOk: false,
      checks: [
        { name: 'api', ok: true, latencyMs: 0 },
        { name: 'proxy', ok: false, latencyMs: 2, error: 'HTTP 403' },
        { name: 'dispatch', ok: false, latencyMs: 5, error: malicious },
      ],
    }),
  );
  const view = dashboard(fetch);
  await vi.waitFor(() => expect(view.summary.textContent).toBe('2 health checks failed'));
  expect(view.checks.textContent).toContain('proxy (2ms) — HTTP 403');
  expect(view.checks.textContent).toContain(`dispatch (5ms) — ${malicious}`);
  expect(fetch).toHaveBeenCalledWith('/admin/health', {
    credentials: 'same-origin',
    redirect: 'error',
  });
});

it.each(['http-error', 'network-error', 'invalid-json'])(
  'does not leave stale green checks after a polling failure (%s)',
  async (failure) => {
    const healthy = () =>
      Response.json({ allOk: true, checks: [{ name: 'api', ok: true, latencyMs: 0 }] });
    const fetch = vi.fn().mockImplementation(async () => healthy());
    const view = dashboard(fetch);
    await vi.waitFor(() => expect(view.summary.textContent).toBe('All health checks passed'));
    if (failure === 'network-error') {
      fetch.mockRejectedValueOnce(new Error('network unavailable'));
    } else {
      fetch.mockResolvedValueOnce(
        failure === 'http-error' ? new Response('', { status: 403 }) : new Response('not-json'),
      );
    }
    view.poll();
    await vi.waitFor(() => expect(view.summary.textContent).toBe('Unable to check system status'));
    expect(view.checks.textContent).toBe('');
    view.poll();
    await vi.waitFor(() => expect(view.summary.textContent).toBe('All health checks passed'));
  },
);
