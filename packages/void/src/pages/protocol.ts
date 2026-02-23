import { ValidationError } from "./validation-error";

export { ValidationError };

export interface PageObject {
  component: string;
  props: Record<string, unknown>;
  shared: Record<string, unknown>;
  url: string;
  errors: Record<string, string> | null;
}

function isPagesRequest(c: any): boolean {
  return c.req.header("x-voidpages") === "true";
}

function pageJsonResponse(pageObj: PageObject): Response {
  return Response.json(pageObj, {
    headers: { "X-VoidPages": "true", Vary: "X-VoidPages" },
  });
}

/** Extract props from a handler result, handling Response wrapping from withValidator */
async function extractProps(result: unknown): Promise<Record<string, unknown>> {
  if (result instanceof Response) {
    const ct = result.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return (await result.json()) as Record<string, unknown>;
    }
    return {};
  }
  return (result as Record<string, unknown>) ?? {};
}

/** Flatten withValidator's { issues: [{ slot, issues: [{ message, path }] }] } into { field: message } */
export function flattenValidationErrors(body: any): Record<string, string> {
  const errors: Record<string, string> = {};
  if (body?.issues) {
    for (const slotIssue of body.issues) {
      for (const issue of slotIssue.issues) {
        // path is a dot-joined string from flattenIssues (e.g. "name", "address.city")
        const key = typeof issue.path === "string" ? issue.path : slotIssue.slot;
        if (typeof key === "string") errors[key] = issue.message;
      }
    }
  }
  return errors;
}

/** Handle GET page request — run handler, return page object or SSR HTML */
export async function handlePageGet(
  handler: Function | undefined,
  c: any,
  componentId: string,
  renderFn: (pageObj: PageObject, assetTags: { head: string; body: string }) => Promise<string>,
  getAssetTags: (req: Request, env: any) => Promise<{ head: string; body: string }>,
): Promise<Response> {
  const shared = c.get("shared") || {};

  // Run loader and check for redirect/non-data responses before extracting props
  let props: Record<string, unknown> = {};
  if (handler) {
    const result = await handler(c);
    if (result instanceof Response) {
      const status = result.status;
      if (status >= 300 && status < 400) return result;
    }
    props = await extractProps(result);
  }
  const pageObj: PageObject = {
    component: componentId,
    props,
    shared,
    url: c.req.path,
    errors: null,
  };

  if (isPagesRequest(c)) {
    return pageJsonResponse(pageObj);
  }

  const assetTags = await getAssetTags(c.req.raw, c.env);
  const html = await renderFn(pageObj, assetTags);
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Handle POST/PUT/DELETE page request — run mutation, then re-run GET or redirect */
export async function handlePageMutation(
  mutationHandler: Function | undefined,
  getHandler: Function | undefined,
  c: any,
  componentId: string,
  renderFn: (pageObj: PageObject, assetTags: { head: string; body: string }) => Promise<string>,
  getAssetTags: (req: Request, env: any) => Promise<{ head: string; body: string }>,
): Promise<Response> {
  const shared = c.get("shared") || {};

  let result: unknown;
  try {
    result = mutationHandler ? await mutationHandler(c) : undefined;
  } catch (e) {
    if (e instanceof ValidationError) {
      const props = getHandler ? await extractProps(await getHandler(c)) : {};
      const pageObj: PageObject = {
        component: componentId,
        props,
        shared,
        url: c.req.path,
        errors: e.errors,
      };
      if (isPagesRequest(c)) return pageJsonResponse(pageObj);
      const assetTags = await getAssetTags(c.req.raw, c.env);
      return new Response(await renderFn(pageObj, assetTags), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    throw e;
  }

  // Handle Response results (from withValidator or explicit redirect)
  if (result instanceof Response) {
    const status = result.status;
    // Redirect
    if (status >= 300 && status < 400) return result;
    // withValidator 400
    if (status === 400) {
      const body = await result.json();
      const errors = flattenValidationErrors(body);
      const props = getHandler ? await extractProps(await getHandler(c)) : {};
      const pageObj: PageObject = {
        component: componentId,
        props,
        shared,
        url: c.req.path,
        errors,
      };
      if (isPagesRequest(c)) return pageJsonResponse(pageObj);
      const assetTags = await getAssetTags(c.req.raw, c.env);
      return new Response(await renderFn(pageObj, assetTags), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    // 204 (void from withValidator) — fall through to re-run GET
    if (status !== 204) return result;
  }

  // void — re-run GET with fresh props
  const props = getHandler ? await extractProps(await getHandler(c)) : {};
  const pageObj: PageObject = {
    component: componentId,
    props,
    shared,
    url: c.req.path,
    errors: null,
  };
  if (isPagesRequest(c)) return pageJsonResponse(pageObj);
  const assetTags = await getAssetTags(c.req.raw, c.env);
  return new Response(await renderFn(pageObj, assetTags), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
