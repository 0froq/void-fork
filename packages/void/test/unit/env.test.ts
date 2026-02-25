import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getRuntimeBinding, getRuntimeEnv, withRuntimeEnv } from "../../src/runtime/env";

const globalScope = globalThis as {
  __env__?: unknown;
  __void_cf_env?: unknown;
};

const originalNuxtEnv = globalScope.__env__;
const originalVoidEnv = globalScope.__void_cf_env;

describe("runtime env resolution", () => {
  beforeEach(() => {
    delete globalScope.__env__;
    delete globalScope.__void_cf_env;
  });

  afterAll(() => {
    if (originalNuxtEnv === undefined) {
      delete globalScope.__env__;
    } else {
      globalScope.__env__ = originalNuxtEnv;
    }

    if (originalVoidEnv === undefined) {
      delete globalScope.__void_cf_env;
    } else {
      globalScope.__void_cf_env = originalVoidEnv;
    }
  });

  it("reads Nuxt env from global __env__", () => {
    globalScope.__env__ = { DB: { tag: "nuxt-db" } };
    expect(getRuntimeBinding("DB")).toEqual({ tag: "nuxt-db" });
  });

  it("prefers __void_cf_env over __env__", () => {
    globalScope.__void_cf_env = { DB: { tag: "void-db" } };
    globalScope.__env__ = { DB: { tag: "nuxt-db" } };
    expect(getRuntimeBinding("DB")).toEqual({ tag: "void-db" });
  });

  it("ignores pending Nuxt env promises", () => {
    globalScope.__env__ = Promise.resolve({ DB: { tag: "nuxt-db" } });
    expect(() => getRuntimeEnv()).toThrow("Cloudflare env is unavailable");
  });

  it("uses request-scoped context env when provided", () => {
    globalScope.__env__ = { DB: { tag: "nuxt-db" } };

    const value = withRuntimeEnv({ DB: { tag: "scoped-db" } }, () => getRuntimeBinding("DB"));
    expect(value).toEqual({ tag: "scoped-db" });
  });

  it("throws when no runtime env is available", () => {
    expect(() => getRuntimeEnv()).toThrow("Cloudflare env is unavailable");
  });
});
