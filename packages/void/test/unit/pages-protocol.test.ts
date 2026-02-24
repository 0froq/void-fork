import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  handlePageGet,
  handlePageMutation,
  flattenValidationErrors,
  ValidationError,
} from "../../src/pages/protocol";

/** Create a minimal Hono context for testing */
function createTestContext(
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    shared?: Record<string, unknown>;
  } = {},
): Promise<any> {
  const app = new Hono();
  let resolveContext: (c: any) => void;
  const contextPromise = new Promise<any>((resolve) => {
    resolveContext = resolve;
  });

  app.use(async (c, next) => {
    if (options.shared) {
      (c as any).set("shared", options.shared);
    }
    await next();
  });

  app.all("*", (c) => {
    resolveContext!(c);
    return c.text("ok");
  });

  const url = `http://localhost${path}`;
  const req = new Request(url, { method, headers: options.headers });
  app.fetch(req);

  return contextPromise;
}

const mockRenderFn = vi.fn(async (pageObj: any) => `<html>${pageObj.component}</html>`);
const mockGetAssetTags = vi.fn(async () => ({ head: "", body: "" }));

describe("handlePageGet", () => {
  it("returns JSON page object when X-VoidPages header present", async () => {
    const c = await createTestContext("GET", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const handler = vi.fn(() => ({ users: [1, 2, 3] }));
    const response = await handlePageGet(handler, c, "users", mockRenderFn, mockGetAssetTags);

    expect(response.headers.get("X-VoidPages")).toBe("true");
    expect(response.headers.get("Vary")).toBe("X-VoidPages");
    const body = (await response.json()) as any;
    expect(body.component).toBe("users");
    expect(body.props).toEqual({ users: [1, 2, 3] });
    expect(body.url).toBe("/users");
    expect(body.errors).toBeNull();
  });

  it("calls renderFn and returns HTML when no X-VoidPages header", async () => {
    const c = await createTestContext("GET", "/users");

    const handler = vi.fn(() => ({ users: [] }));
    const response = await handlePageGet(handler, c, "users", mockRenderFn, mockGetAssetTags);

    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain("users");
  });

  it("handles undefined handler (empty props)", async () => {
    const c = await createTestContext("GET", "/", {
      headers: { "x-voidpages": "true" },
    });

    const response = await handlePageGet(undefined, c, "index", mockRenderFn, mockGetAssetTags);

    const body = (await response.json()) as any;
    expect(body.props).toEqual({});
    expect(body.component).toBe("index");
  });

  it("passes through redirect Response from loader", async () => {
    const c = await createTestContext("GET", "/auth/callback");

    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/" },
    });
    const handler = vi.fn(() => redirect);
    const renderFn = vi.fn(async (pageObj: any) => `<html>${pageObj.component}</html>`);
    const response = await handlePageGet(handler, c, "callback", renderFn, mockGetAssetTags);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(renderFn).not.toHaveBeenCalled();
  });

  it("island=true always renders HTML even with X-VoidPages header", async () => {
    const c = await createTestContext("GET", "/", {
      headers: { "x-voidpages": "true" },
    });

    const renderFn = vi.fn(async () => "<html>island</html>");
    const response = await handlePageGet(undefined, c, "index", renderFn, mockGetAssetTags, true);

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(renderFn).toHaveBeenCalled();
  });

  it("island=false returns JSON for X-VoidPages requests (unchanged)", async () => {
    const c = await createTestContext("GET", "/", {
      headers: { "x-voidpages": "true" },
    });

    const renderFn = vi.fn(async () => "<html></html>");
    const response = await handlePageGet(undefined, c, "index", renderFn, mockGetAssetTags, false);

    expect(response.headers.get("X-VoidPages")).toBe("true");
    expect(renderFn).not.toHaveBeenCalled();
  });

  it("includes shared data from context", async () => {
    const c = await createTestContext("GET", "/", {
      headers: { "x-voidpages": "true" },
      shared: { auth: { user: { name: "Test" } } },
    });

    const response = await handlePageGet(undefined, c, "index", mockRenderFn, mockGetAssetTags);

    const body = (await response.json()) as any;
    expect(body.shared).toEqual({ auth: { user: { name: "Test" } } });
  });
});

describe("handlePageMutation", () => {
  it("void return — re-runs GET, returns fresh props", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const mutationHandler = vi.fn(() => undefined);
    const getHandler = vi.fn(() => ({ users: ["new"] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.props).toEqual({ users: ["new"] });
    expect(body.errors).toBeNull();
  });

  it("Response redirect — passes through", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/users/1" },
    });
    const mutationHandler = vi.fn(() => redirect);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/users/1");
  });

  it("ValidationError thrown — re-runs GET with errors", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const mutationHandler = vi.fn(() => {
      throw new ValidationError({ name: "required" });
    });
    const getHandler = vi.fn(() => ({ users: [] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.errors).toEqual({ name: "required" });
    expect(body.props).toEqual({ users: [] });
  });

  it("Response 400 (withValidator) — extracts errors, re-runs GET", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const validationResponse = Response.json(
      {
        issues: [
          {
            slot: "body",
            issues: [{ message: "required", path: "name" }],
          },
        ],
      },
      { status: 400 },
    );
    const mutationHandler = vi.fn(() => validationResponse);
    const getHandler = vi.fn(() => ({ users: [] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.errors).toEqual({ name: "required" });
  });

  it("Response 204 (void from withValidator) — re-runs GET", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const voidResponse = new Response(null, { status: 204 });
    const mutationHandler = vi.fn(() => voidResponse);
    const getHandler = vi.fn(() => ({ users: ["created"] }));

    const response = await handlePageMutation(
      mutationHandler,
      getHandler,
      c,
      "users",
      mockRenderFn,
      mockGetAssetTags,
    );

    const body = (await response.json()) as any;
    expect(body.props).toEqual({ users: ["created"] });
    expect(body.errors).toBeNull();
  });

  it("re-throws non-ValidationError errors", async () => {
    const c = await createTestContext("POST", "/users", {
      headers: { "x-voidpages": "true" },
    });

    const mutationHandler = vi.fn(() => {
      throw new Error("boom");
    });

    await expect(
      handlePageMutation(mutationHandler, undefined, c, "users", mockRenderFn, mockGetAssetTags),
    ).rejects.toThrow("boom");
  });

  it("island mutation — ValidationError returns JSON 422", async () => {
    const c = await createTestContext("POST", "/contact");

    const mutationHandler = vi.fn(() => {
      throw new ValidationError({ email: "required" });
    });

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      c,
      "contact",
      mockRenderFn,
      mockGetAssetTags,
      true,
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as any;
    expect(body.errors).toEqual({ email: "required" });
  });

  it("island mutation — withValidator 400 returns JSON 422", async () => {
    const c = await createTestContext("POST", "/contact");

    const validationResponse = Response.json(
      {
        issues: [
          {
            slot: "body",
            issues: [{ message: "required", path: "email" }],
          },
        ],
      },
      { status: 400 },
    );
    const mutationHandler = vi.fn(() => validationResponse);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      c,
      "contact",
      mockRenderFn,
      mockGetAssetTags,
      true,
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as any;
    expect(body.errors).toEqual({ email: "required" });
  });

  it("island mutation — success returns JSON 200", async () => {
    const c = await createTestContext("POST", "/contact");

    const mutationHandler = vi.fn(() => undefined);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      c,
      "contact",
      mockRenderFn,
      mockGetAssetTags,
      true,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.success).toBe(true);
  });

  it("island mutation — redirect passes through", async () => {
    const c = await createTestContext("POST", "/contact");

    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/dashboard" },
    });
    const mutationHandler = vi.fn(() => redirect);

    const response = await handlePageMutation(
      mutationHandler,
      undefined,
      c,
      "contact",
      mockRenderFn,
      mockGetAssetTags,
      true,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/dashboard");
  });
});

describe("flattenValidationErrors", () => {
  it("flattens nested issues format into flat map", () => {
    const body = {
      issues: [
        {
          slot: "body",
          issues: [
            { message: "required", path: "name" },
            { message: "invalid", path: "email" },
          ],
        },
      ],
    };

    expect(flattenValidationErrors(body)).toEqual({
      name: "required",
      email: "invalid",
    });
  });

  it("uses slot as key fallback when no path", () => {
    const body = {
      issues: [
        {
          slot: "body",
          issues: [{ message: "invalid body" }],
        },
      ],
    };

    expect(flattenValidationErrors(body)).toEqual({
      body: "invalid body",
    });
  });

  it("returns empty object for null/undefined input", () => {
    expect(flattenValidationErrors(null)).toEqual({});
    expect(flattenValidationErrors(undefined)).toEqual({});
  });
});
