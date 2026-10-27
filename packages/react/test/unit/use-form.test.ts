// @vitest-environment happy-dom

import { act, createElement, startTransition } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { VoidActionError, type VoidRouter } from 'void/pages-client';
import { RouterContext } from '../../src/runtime/context.ts';
import { useForm as typedUseForm } from '../../src/runtime/use-form.ts';

type TestForm = {
  errors: Record<string, string>;
  error: VoidActionError | null;
  wasSuccessful: boolean;
  post(formData: FormData): void;
};

const useForm = typedUseForm as unknown as (
  url: string,
  defaults: Record<string, unknown>,
  options?: {
    onSuccess?: () => void;
    onError?: (error: Record<string, string> | VoidActionError) => void;
  },
) => TestForm;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

function routerWithVisit(visit: VoidRouter['visit']): VoidRouter {
  return {
    _hoverDelay: 75,
    get url() {
      return new URL('http://localhost/');
    },
    get path() {
      return '/';
    },
    get query() {
      return new URLSearchParams();
    },
    get params() {
      return {};
    },
    visit,
    refresh: vi.fn(),
    prefetch: vi.fn(),
    flush: vi.fn(),
    flushAll: vi.fn(),
  };
}

async function mountForm(
  visit: VoidRouter['visit'],
  options?: {
    onSuccess?: () => void;
    onError?: (error: Record<string, string> | VoidActionError) => void;
  },
) {
  const router = routerWithVisit(visit);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  const formRef: { current: TestForm | null } = { current: null };

  function App() {
    formRef.current = useForm('/notes?create', { title: '' }, options);
    return null;
  }

  await act(async () => {
    root.render(
      createElement(
        RouterContext.Provider,
        { value: router },
        createElement(App),
      ),
    );
  });

  if (!formRef.current) {
    throw new Error('useForm did not mount.');
  }

  return formRef;
}

async function waitForFormSettle() {
  for (let attempt = 0; attempt < 20; attempt++) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(() => resolve());
      });
    });
  }
}

async function submitPost(form: TestForm) {
  await act(async () => {
    startTransition(() => {
      form.post(new FormData());
    });
  });
  await waitForFormSettle();
}

describe('useForm callbacks', () => {
  it('calls onSuccess after a successful submit', async () => {
    const onSuccess = vi.fn();
    const formRef = await mountForm(vi.fn(async () => ({})), { onSuccess });
    await submitPost(formRef.current!);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(formRef.current!.wasSuccessful).toBe(true);
  });

  it('calls onError with validation errors', async () => {
    const onError = vi.fn();
    const formRef = await mountForm(
      vi.fn(async () => ({ errors: { title: 'Required' } })),
      { onError },
    );
    await submitPost(formRef.current!);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ title: 'Required' });
    expect(formRef.current!.errors).toEqual({ title: 'Required' });
  });

  it('calls onError with VoidActionError for non-validation failures', async () => {
    const actionError = new VoidActionError({
      body: 'Missing',
      status: 404,
      statusText: 'Not Found',
      url: '/notes',
    });
    const onError = vi.fn();
    const formRef = await mountForm(
      vi.fn(async () => {
        throw actionError;
      }),
      { onError },
    );
    await submitPost(formRef.current!);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(actionError);
    expect(formRef.current!.error).toBe(actionError);
  });

  it('fires onSuccess on each successful submit', async () => {
    const onSuccess = vi.fn();
    const formRef = await mountForm(vi.fn(async () => ({})), { onSuccess });
    await submitPost(formRef.current!);
    await submitPost(formRef.current!);
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('does not call onError when a submit is aborted', async () => {
    const onError = vi.fn();
    const abortError = new DOMException('Navigation aborted', 'AbortError');
    const formRef = await mountForm(
      vi.fn(async () => {
        throw abortError;
      }),
      { onError },
    );
    await submitPost(formRef.current!);
    expect(onError).not.toHaveBeenCalled();
  });
});
