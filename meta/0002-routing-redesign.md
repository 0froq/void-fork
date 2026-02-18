# Design Document: Typed File-Based API Routes for Hono

**Date:** 2026-02-16
**Status:** Completed

---

## 1. Problem Statement

Building type-safe APIs in full-stack TypeScript applications requires bridging the gap between server-side route handlers and client-side data fetching. Current solutions each have significant tradeoffs.

**Hono's built-in RPC** provides end-to-end type safety through inference on chained route definitions, but degrades severely at scale. TypeScript must instantiate complex generic types for every route in the chain, leading to IDE slowdowns around 50–100 routes and build times exceeding 8 minutes for large applications. The root cause is architectural: Hono's RPC requires the entire app type—including ORM models, business logic, and all middleware—to be compiled just to produce what is essentially an input/output manifest.

**Nitro-style code generation** avoids the inference scaling problem by emitting a static declaration file mapping route paths to response types. However, Nitro only generates types for responses—not inputs. Request body, query parameters, and path parameters remain untyped on the client.

**Next.js** offers a clean file-based routing convention with colocated HTTP methods but provides no built-in type bridge between server handlers and client code.

This design combines the strengths of all three: Next.js-style file routing with colocated methods, a `defineHandler` API that captures both input and output types, Hono as the runtime, and Nitro-style code generation that emits a complete type manifest covering inputs _and_ outputs.

---

## 2. Prior Art Summary

### 2.1 Next.js: File-Based Route Convention

Next.js App Router maps filesystem paths to API endpoints. A file at `app/api/users/[id]/route.ts` becomes `/api/users/:id`. Each file exports named functions (`GET`, `POST`, etc.) for HTTP methods.

**Strengths:** Simple mental model; colocated methods; pure filesystem convention.

**Weaknesses:** No type bridge to client. `NextResponse.json()` returns opaque `NextResponse`—the payload shape is not extractable via `ReturnType`. Multiple return paths (success vs. error) further complicate static extraction.

### 2.2 Nuxt/Nitro: Code Generation for Response Types

Nitro scans handlers and generates `nitro-routes.d.ts` mapping paths and methods to response types via `Awaited<ReturnType<typeof import(...)>>`. This powers typed `$fetch`/`useFetch` with route path autocomplete.

**Strengths:** Response types are fully automatic; scales to any route count without inference cost.

**Weaknesses:** One handler per file (no method colocation). Input types (body, query, params) are not generated—open request since early 2023. Requires dev server to produce type files.

### 2.3 TanStack Start: Inference Chains

Types thread through `createServerFn().inputValidator().handler()`. The input validator simultaneously defines runtime schema and TypeScript type. Return types flow from handler → loader → `useLoaderData()` via pure inference.

**Strengths:** End-to-end type safety for inputs and outputs; no code generation; works without dev server.

**Weaknesses:** Tightly coupled to TanStack ecosystem; requires buying into the full framework.

### 2.4 Hono RPC: Inference at Scale

Hono exports `typeof app` and uses the `hc` client for typed API calls. Validators like `zValidator` capture input types inline.

**Strengths:** Full input and output type safety; works with any validator.

**Weaknesses:** Type instantiation scales linearly with route count. IDE becomes unusable at 50–100+ endpoints. Build times grow to minutes. The entire app—including ORM, business logic, middleware—must be compiled to produce RPC types.

---

## 3. Design Goals

1. **Next.js-style file routing.** One file per route path, multiple HTTP methods colocated via named exports.
2. **Full input and output type safety.** Both request schemas (body, query, params) and response types flow to the client automatically.
3. **Hono as runtime.** Handlers receive Hono's `Context` and use Hono's middleware, routing, and ecosystem.
4. **Code generation over inference.** A build step emits a static type manifest, avoiding Hono RPC's scaling problems.
5. **Validator-driven input types via Standard Schema.** Any schema library implementing the Standard Schema spec (Zod, Valibot, ArkType, Effect, etc.) can be used interchangeably. The `withValidator` API accepts `StandardSchemaV1` instances, using `InferInput` for client-facing types and `InferOutput` for handler parameters. The codegen extracts types from the handler's generic signature, not by analyzing runtime values.
6. **Scalable.** IDE performance and build time are O(1) per route at the client, regardless of total route count, because the client only sees the generated declaration file.

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Developer writes route files                       │
│  routes/api/users/[id].ts                           │
│    export const GET = defineHandler(...)             │
│    export const POST = defineHandler                 │
│      .withValidator(schema)(handler)                 │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
          ▼                         ▼
   ┌─────────────┐        ┌─────────────────┐
   │  Router      │        │  Codegen CLI     │
   │  (runtime)   │        │  (build step)    │
   │              │        │                  │
   │  Scans files,│        │  Scans files,    │
   │  registers   │        │  extracts types  │
   │  Hono routes │        │  via typeof      │
   │              │        │  import(...)      │
   └──────┬──────┘        └────────┬─────────┘
          │                         │
          ▼                         ▼
   ┌─────────────┐        ┌─────────────────┐
   │  Hono app   │        │  routes.d.ts     │
   │  (serves     │        │  (generated      │
   │   requests)  │        │   type manifest) │
   └─────────────┘        └────────┬─────────┘
                                    │
                                    ▼
                           ┌─────────────────┐
                           │  Typed $fetch    │
                           │  client helper   │
                           │                  │
                           │  Reads manifest, │
                           │  enforces input  │
                           │  types, infers   │
                           │  output types    │
                           └─────────────────┘
```

---

## 5. API Design

### 5.1 File Routing Convention

Routes live in a configurable directory (default: `routes/`). The filesystem path maps to the URL path. Dynamic segments use bracket syntax.

```
routes/
  api/
    health.ts             →  /api/health
    users.ts              →  /api/users
    users/
      [id].ts             →  /api/users/:id
      [id]/
        posts.ts          →  /api/users/:id/posts
    files/
      [...path].ts        →  /api/files/*
```

Each file exports named HTTP method handlers: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD`.

### 5.2 `defineHandler` — Basic Usage (No Input Validation)

For handlers that don't need input validation (typically GET endpoints), `defineHandler` wraps a Hono-style handler and makes its return type extractable:

```typescript
// routes/api/health.ts
import { defineHandler } from "@lib/handler";

export const GET = defineHandler(async (c) => {
  return c.json({ status: "ok", timestamp: Date.now() });
});
```

The codegen can extract the output type via `typeof import(...).GET`, since `defineHandler` preserves the return type in its generic signature.

### 5.3 `defineHandler.withValidator` — Input Validation

For handlers that accept structured input, `.withValidator(schema)` returns a typed handler factory. The `withValidator` API accepts any schema that implements the Standard Schema v1 interface (`StandardSchemaV1`)—this includes Zod, Valibot, ArkType, Effect Schema, and any future compliant library. The schema's inferred type flows into the handler's parameters automatically.

```typescript
// routes/api/users.ts
import { defineHandler } from "@lib/handler";
import { z } from "zod";

const CreateUser = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["admin", "user"]).optional(),
});

export const GET = defineHandler(async (c) => {
  const users = await db.users.findMany();
  return c.json(users);
});

export const POST = defineHandler.withValidator({ body: CreateUser })(async (c, { body }) => {
  //                                          ^ typed as { name: string; email: string; role?: 'admin' | 'user' }
  const user = await db.users.create({ data: body });
  return c.json(user, 201);
});
```

The same handler works identically with any Standard Schema-compliant library:

```typescript
// With Valibot
import * as v from "valibot";
const CreateUser = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  email: v.pipe(v.string(), v.email()),
  role: v.optional(v.picklist(["admin", "user"])),
});

export const POST = defineHandler.withValidator({ body: CreateUser })(async (c, { body }) => {
  // Same types, same codegen output, zero adapters
  return c.json(await db.users.create({ data: body }), 201);
});
```

```typescript
// With ArkType
import { type } from "arktype";
const CreateUser = type({
  name: "string > 0",
  email: "string.email",
  "role?": "'admin' | 'user'",
});

export const POST = defineHandler.withValidator({ body: CreateUser })(async (c, { body }) => {
  return c.json(await db.users.create({ data: body }), 201);
});
```

The `withValidator` function is curried: it accepts a schema descriptor, captures the inferred types, and returns a function that accepts the handler. This ensures the validated input type is available both inside the handler (for the developer) and on the exported type (for the codegen).

### 5.4 Validator Slots

Input validation supports separate slots for body, query, and params, since they map to different parts of the HTTP request and different fields in the client's fetch options. Each slot accepts any Standard Schema-compliant schema:

```typescript
export const POST = defineHandler.withValidator({
  body: z.object({ title: z.string() }), // Zod
  query: v.object({ dryRun: v.optional(v.boolean()) }), // Valibot — mix freely
  params: z.object({ id: z.string().uuid() }), // Zod
})(async (c, { body, query, params }) => {
  // body:   { title: string }
  // query:  { dryRun?: boolean }
  // params: { id: string }
  return c.json({ ok: true });
});
```

Because each slot only requires `StandardSchemaV1`, different validator libraries can even be mixed within the same handler — though in practice most teams will standardize on one.

The `params` slot is optional and complements the filesystem-based param inference. When provided, it adds runtime validation; when omitted, params are inferred as `string` from the path.

### 5.5 Type Signature

The core types are built on Standard Schema's `StandardSchemaV1` interface rather than any specific validation library. The key insight is the distinction between `InferInput` (what the client sends — before transforms and defaults) and `InferOutput` (what the handler receives — after validation, transforms, and defaults are applied).

```typescript
import type { StandardSchemaV1 } from "@standard-schema/spec";

// Each validator slot accepts any Standard Schema-compliant schema
type ValidatorSlots = {
  body?: StandardSchemaV1;
  query?: StandardSchemaV1;
  params?: StandardSchemaV1;
};

// What the HANDLER receives (InferOutput — after transforms/defaults)
// Used inside the handler function parameter
type HandlerInput<V extends ValidatorSlots> = {
  [K in "body" | "query" | "params" as V[K] extends StandardSchemaV1
    ? K
    : never]: StandardSchemaV1.InferOutput<NonNullable<V[K]>>;
};

// What the CLIENT must send (InferInput — before transforms/defaults)
// Used in the generated RouteMap for $fetch enforcement
type ClientInput<V extends ValidatorSlots> = {
  [K in "body" | "query" | "params" as V[K] extends StandardSchemaV1
    ? K
    : never]: StandardSchemaV1.InferInput<NonNullable<V[K]>>;
};

// Basic handler — no validation
declare function defineHandler<R>(handler: (c: Context) => R): TypedHandler<{}, R>;

// Curried validator — captures input types, returns handler factory
declare namespace defineHandler {
  function withValidator<V extends ValidatorSlots>(
    validators: V,
  ): <R>(handler: (c: Context, input: HandlerInput<V>) => R) => TypedHandler<V, R>;
}

// TypedHandler carries both input schemas and output types for codegen extraction
type TypedHandler<V, R> = {
  __validators: V; // codegen reads this to extract input types
  __output: R; // codegen reads this to extract output type
  (c: Context): R; // actual callable at runtime
};
```

**Why `InferInput` vs. `InferOutput` matters:** Consider a schema with a default value:

```typescript
const CreateUser = z.object({
  name: z.string(),
  role: z.enum(["admin", "user"]).default("user"),
});

// InferInput:  { name: string; role?: 'admin' | 'user' | undefined }
//   → client can omit `role`, it has a default
// InferOutput: { name: string; role: 'admin' | 'user' }
//   → handler always receives `role`, default has been applied
```

The codegen uses `InferInput` for client-facing types (so callers can omit fields with defaults) and `InferOutput` for the handler parameter types (so handler code sees the post-validation shape). Getting this wrong causes false type errors when clients omit optional-with-default fields.

The `__validators` and `__output` properties exist only at the type level (using branded types or declaration merging) — they are not present at runtime. The codegen reads them via `typeof import(...)`.

---

## 6. Code Generation

### 6.1 What It Produces

A CLI command (e.g., `generate-routes` or a dev server plugin) scans the route directory and emits a single declaration file. Input types are extracted using `StandardSchemaV1.InferInput` (what the client sends), and output types use `Serialize` to account for JSON serialization:

```typescript
// .generated/routes.d.ts  (auto-generated, do not edit)
import type { Serialize } from "@lib/serialize";
import type { StandardSchemaV1 } from "@standard-schema/spec";

export interface RouteMap {
  "/api/health": {
    GET: {
      input: {};
      output: Serialize<{ status: string; timestamp: number }>;
    };
  };
  "/api/users": {
    GET: {
      input: {};
      output: Serialize<Array<{ id: string; name: string; email: string }>>;
    };
    POST: {
      input: {
        body: { name: string; email: string; role?: "admin" | "user" };
        //     ^ InferInput: role is optional because the schema has a default
      };
      output: Serialize<{ id: string; name: string; email: string }>;
    };
  };
  "/api/users/:id": {
    GET: {
      input: {
        params: { id: string };
      };
      output: Serialize<{ id: string; name: string; email: string }>;
    };
  };
}
```

### 6.2 How It Extracts Types

For each route file, the codegen emits `typeof import(...)` references for each exported method, using Standard Schema's `InferInput` for client-facing types:

```typescript
// Internal codegen template per route
import type { StandardSchemaV1 } from "@standard-schema/spec";

// Output: extracted from handler return type
type _UsersGET_Output = Awaited<ReturnType<typeof import("../../routes/api/users").GET>>;

// Input: extracted from __validators using InferInput (what client sends)
type _UsersPOST_BodyInput = StandardSchemaV1.InferInput<
  NonNullable<(typeof import("../../routes/api/users").POST)["__validators"]["body"]>
>;

// Output: extracted from handler return type
type _UsersPOST_Output = Awaited<ReturnType<typeof import("../../routes/api/users").POST>>;
```

`InferInput` reads the phantom `types.input` property from the Standard Schema `~standard` interface. This works identically for Zod, Valibot, ArkType, or any compliant library — the codegen never needs to know which library was used. It only sees the `StandardSchemaV1` interface and extracts the type through it.

`Serialize` transforms output types for JSON serialization (`Date` → `string`, `undefined` stripped, etc.).

This approach works regardless of how the validator schema is constructed — inline, imported from another module, or returned from a factory function — because it operates on TypeScript's resolved types via `typeof import(...)`, not on AST analysis of the source code.

### 6.3 When It Runs

- **Dev server:** Watches the routes directory for changes and regenerates on save (debounced).
- **Build:** Runs as a pre-build step.
- **CLI:** `npx generate-routes` for manual invocation or CI.

### 6.4 Serialize Utility Type

The `Serialize` type accounts for JSON round-tripping:

```typescript
type Serialize<T> = T extends Date
  ? string
  : T extends BigInt
    ? never
    : T extends Function
      ? never
      : T extends undefined
        ? never
        : T extends Array<infer U>
          ? Array<Serialize<U>>
          : T extends object
            ? { [K in keyof T as T[K] extends Function ? never : K]: Serialize<T[K]> }
            : T;
```

---

## 7. Client Fetch Helper

### 7.1 Typed `$fetch`

A thin wrapper around `fetch` that reads the generated `RouteMap` to enforce input types and infer output types:

```typescript
import type { RouteMap } from ".generated/routes";

const data = await $fetch("/api/users", {
  method: "POST",
  body: { name: "Alice", email: "alice@example.com" },
  //     ^ enforced as { name: string; email: string; role?: 'admin' | 'user' }
});
// data is typed as { id: string; name: string; email: string }
```

Route paths autocomplete. Invalid paths are TypeScript errors. Method-specific input requirements are enforced.

### 7.2 Client Type Signature

```typescript
type FetchOptions<P extends keyof RouteMap, M extends keyof RouteMap[P]> = {
  method: M;
} & (RouteMap[P][M] extends { input: { body: infer B } } ? { body: B } : {}) &
  (RouteMap[P][M] extends { input: { query: infer Q } } ? { query: Q } : {});

type FetchResult<P extends keyof RouteMap, M extends keyof RouteMap[P]> = RouteMap[P][M] extends {
  output: infer O;
}
  ? O
  : unknown;

declare function $fetch<P extends keyof RouteMap, M extends keyof RouteMap[P] = "GET">(
  path: P,
  options?: FetchOptions<P, M>,
): Promise<FetchResult<P, M>>;
```

### 7.3 Path Parameter Interpolation

For routes with dynamic segments, the client accepts a params object and interpolates it into the URL:

```typescript
const user = await $fetch("/api/users/:id", {
  method: "GET",
  params: { id: "123" },
});
// Actual request goes to /api/users/123
```

---

## 8. Runtime Router

### 8.1 File Scanner → Hono Registration

At server startup (or build time for serverless), a router module scans the routes directory, imports each file, and registers handlers with Hono:

```typescript
// Pseudocode for runtime registration
import { Hono } from "hono";

const app = new Hono();

for (const routeFile of scanRouteDirectory("routes/")) {
  const module = await import(routeFile.path);
  const honoPath = toHonoPath(routeFile.relativePath);
  // e.g., 'api/users/[id].ts' → '/api/users/:id'

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    if (module[method]) {
      app.on(method, honoPath, module[method]);
    }
  }
}
```

### 8.2 Validation Middleware

When a handler is created with `.withValidator()`, the validation runs as middleware before the handler executes. At runtime, validation uses the Standard Schema `~standard.validate()` method — the same interface regardless of which library created the schema:

```typescript
// Simplified runtime implementation
async function runValidation(validators: ValidatorSlots, c: Context) {
  const input: Record<string, unknown> = {};

  if (validators.body) {
    const result = await validators.body["~standard"].validate(await c.req.json());
    if (result.issues) {
      return c.json({ errors: flattenIssues(result.issues) }, 400);
    }
    input.body = result.value;
  }

  if (validators.query) {
    const result = await validators.query["~standard"].validate(c.req.query());
    if (result.issues) {
      return c.json({ errors: flattenIssues(result.issues) }, 400);
    }
    input.query = result.value;
  }

  if (validators.params) {
    const result = await validators.params["~standard"].validate(c.req.param());
    if (result.issues) {
      return c.json({ errors: flattenIssues(result.issues) }, 400);
    }
    input.params = result.value;
  }

  return input;
}

// Standard Schema issues have a consistent shape across all libraries:
// { message: string; path?: Array<PropertyKey | { key: PropertyKey }> }
function flattenIssues(issues: StandardSchemaV1.Issue[]) {
  return issues.map((issue) => ({
    message: issue.message,
    path: issue.path?.map((p) => (typeof p === "object" ? p.key : p)).join("."),
  }));
}
```

On failure, a 400 response is returned with structured error details. The error format is consistent regardless of whether Zod, Valibot, or ArkType produced the issues, because Standard Schema normalizes the issue shape.

---

## 9. Comparison with Alternatives

| Aspect                        | This Design                  | Hono RPC                         | Nitro                        | TanStack Start          | Next.js             |
| ----------------------------- | ---------------------------- | -------------------------------- | ---------------------------- | ----------------------- | ------------------- |
| Method colocation             | Yes (named exports)          | Yes (chaining)                   | No (one file per method)     | Yes (config object)     | Yes (named exports) |
| Output type safety            | Yes (codegen)                | Yes (inference)                  | Yes (codegen)                | Yes (inference)         | No                  |
| Input type safety             | Yes (codegen + validators)   | Yes (inference)                  | No                           | Yes (inference)         | No                  |
| IDE scaling                   | O(1) per route (reads .d.ts) | O(n) (inference over all routes) | O(1) per route (reads .d.ts) | O(n) (inference chains) | N/A                 |
| Build scaling                 | O(n) one-time codegen pass   | O(n²) type instantiation         | O(n) one-time codegen pass   | O(n) inference          | N/A                 |
| Requires dev server for types | Yes                          | No                               | Yes                          | No                      | N/A                 |
| Runtime                       | Hono                         | Hono                             | H3/Nitro                     | Vinxi/Vite              | Next.js             |
| Validator agnostic            | Yes (Standard Schema)        | Yes (per-route)                  | Manual                       | Zod built-in            | Manual              |
| Input/Output type distinction | Yes (InferInput/InferOutput) | Yes (per validator)              | N/A                          | No                      | N/A                 |

---

## 10. Key Design Decisions

### 10.1 Why Codegen Over Pure Inference?

Hono RPC demonstrates that pure inference works beautifully at small scale but breaks down at production scale. The core issue is that `typeof app` forces TypeScript to instantiate the entire app's generic type tree on every IDE keystroke. Code generation moves this cost to a one-time build step and produces a flat declaration file that is trivially cheap for TypeScript to consume.

### 10.2 Why Curried `withValidator(schema)(handler)` Over Chaining?

The curried form `defineHandler.withValidator(schema)(handler)` was chosen over a builder pattern like `defineHandler().withValidator(schema).handler(fn)` for several reasons:

- **Simpler type plumbing.** The validator's inferred type constrains the handler's parameter type naturally through closure, without threading generic state through a builder.
- **Minimal API surface.** No builder object, no stateful chain—just a function that returns a function.
- **Easier adoption for Hono.** Does not require changes to Hono's core; `defineHandler` is a standalone utility.

### 10.3 Why Separate Validator Slots (body/query/params)?

A single `input` validator would be simpler, but body, query, and params are semantically distinct in HTTP and map to different fields in fetch options. Separating them allows the codegen to produce precise client types where `body` maps to the request body, `query` maps to URL query parameters, and `params` maps to path interpolation.

### 10.4 Why `Serialize<T>` Wrapper?

Data crosses a JSON serialization boundary between server and client. `Date` objects become strings, `undefined` values are stripped, functions are removed. Without `Serialize`, the client would see the server's in-memory types, which don't match what actually arrives over the wire. Nitro solved this same problem and the approach is proven.

### 10.5 Why Standard Schema Over Library-Specific Types?

The `withValidator` API could have been built directly against Zod's `ZodSchema<T>` type (the most popular validator). Instead, it accepts `StandardSchemaV1` from the Standard Schema specification. This is a ~60-line TypeScript interface created collaboratively by the authors of Zod, Valibot, and ArkType. It provides:

- **A `validate` method** that accepts `unknown` and returns `{ value: Output }` or `{ issues: Issue[] }`.
- **Phantom `types` property** carrying `Input` and `Output` TypeScript types, readable via `InferInput<S>` and `InferOutput<S>`.
- **Versioned stability** (`StandardSchemaV1`) with no breaking changes without a major version bump.

By targeting this interface rather than any specific library, the design achieves several things:

- **Zero adapters.** No `@lib/zod-adapter`, `@lib/valibot-adapter`, etc. Any compliant schema works directly.
- **No runtime dependency on the spec.** The `@standard-schema/spec` package is types-only. The runtime only calls `schema['~standard'].validate()`.
- **Future-proof.** New validation libraries that implement Standard Schema work automatically, with no changes to the handler API or codegen.
- **Correct Input/Output distinction.** Standard Schema explicitly separates input types (before transforms/defaults) from output types (after). This is critical for the design: the client sees `InferInput` (can omit fields with defaults), while the handler sees `InferOutput` (defaults applied, transforms executed). Library-specific type utilities (e.g., `z.input<T>` vs `z.output<T>`) would require per-library extraction logic in the codegen; Standard Schema unifies this.

The tradeoff is that the developer's schema must come from a Standard Schema-compliant library. As of 2025, this includes Zod, Valibot, ArkType, Effect Schema, Superstruct (via wrapper), and others. The ecosystem coverage is broad enough that this is not a practical limitation for most teams.

---

## 11. Open Questions

1. **Error response types.** Should the codegen capture error shapes (e.g., 400 validation error, 404 not found) in addition to success responses? This is hard to do automatically but valuable for client-side error handling. Possible approach: a `.withErrors()` slot or convention-based extraction. Note that Standard Schema already normalizes validation error shapes (`{ message: string; path?: ... }`), which simplifies the 400 case.

2. **Middleware type propagation.** Hono middleware can inject context variables (e.g., `c.set('user', authUser)`). Should the codegen or handler API support declaring middleware-injected types? This is where Hono's `Env` generics would integrate.

3. **Streaming and non-JSON responses.** The current design assumes JSON responses. Handlers that return streams, SSE, or binary data would need a different extraction path or an opt-out marker.

4. **Monorepo support.** When server and client live in different packages, the generated declaration file needs to be importable by the client. This likely requires either a shared package or TypeScript project references. The codegen output location should be configurable.

5. **Hot reload in dev.** The codegen should re-run on file changes, but must be fast enough to not introduce perceptible delay. For very large route trees, incremental regeneration (only re-scanning changed files) may be necessary.

6. **Async validation.** Standard Schema's `validate` method may return a `Promise`. The runtime implementation handles this (it `await`s), but the codegen and type extraction are unaffected since they only read the phantom `types` property, not the runtime result.

7. **Standard JSON Schema integration.** Standard Schema v1 also includes a `StandardJSONSchemaV1` spec for converting schemas to JSON Schema. This could enable automatic OpenAPI spec generation from the same route definitions — a natural extension of the codegen step.
