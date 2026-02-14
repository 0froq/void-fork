import { describe, expect, it } from "vitest";
import { parseRouteFilename } from "../../src/router/parse-filename";

describe("parseRouteFilename", () => {
  describe("static routes", () => {
    it("simple file", () => {
      const r = parseRouteFilename("api/hello.ts");
      expect(r.pattern).toBe("/api/hello");
      expect(r.method).toBe("*");
      expect(r.params).toEqual([]);
      expect(r.catchAll).toBe(false);
      expect(r.env).toBeNull();
    });

    it("nested file", () => {
      const r = parseRouteFilename("api/users/profile.ts");
      expect(r.pattern).toBe("/api/users/profile");
    });

    it("index file becomes directory", () => {
      const r = parseRouteFilename("api/users/index.ts");
      expect(r.pattern).toBe("/api/users");
    });

    it("root index", () => {
      const r = parseRouteFilename("index.ts");
      expect(r.pattern).toBe("/");
    });
  });

  describe("file extensions", () => {
    it(".ts", () => {
      expect(parseRouteFilename("hello.ts").pattern).toBe("/hello");
    });

    it(".js", () => {
      expect(parseRouteFilename("hello.js").pattern).toBe("/hello");
    });

    it(".mts", () => {
      expect(parseRouteFilename("hello.mts").pattern).toBe("/hello");
    });

    it(".mjs", () => {
      expect(parseRouteFilename("hello.mjs").pattern).toBe("/hello");
    });
  });

  describe("HTTP methods", () => {
    it(".get suffix", () => {
      const r = parseRouteFilename("hello.get.ts");
      expect(r.pattern).toBe("/hello");
      expect(r.method).toBe("get");
    });

    it(".post suffix", () => {
      const r = parseRouteFilename("users.post.ts");
      expect(r.pattern).toBe("/users");
      expect(r.method).toBe("post");
    });

    it(".put suffix", () => {
      const r = parseRouteFilename("users.put.ts");
      expect(r.method).toBe("put");
    });

    it(".delete suffix", () => {
      const r = parseRouteFilename("users.delete.ts");
      expect(r.method).toBe("delete");
    });

    it(".patch suffix", () => {
      const r = parseRouteFilename("users.patch.ts");
      expect(r.method).toBe("patch");
    });

    it("no method suffix defaults to *", () => {
      const r = parseRouteFilename("hello.ts");
      expect(r.method).toBe("*");
    });

    it("method with nested path", () => {
      const r = parseRouteFilename("api/users/index.get.ts");
      expect(r.pattern).toBe("/api/users");
      expect(r.method).toBe("get");
    });
  });

  describe("environment suffixes", () => {
    it(".dev suffix", () => {
      const r = parseRouteFilename("debug.get.dev.ts");
      expect(r.pattern).toBe("/debug");
      expect(r.method).toBe("get");
      expect(r.env).toBe("dev");
    });

    it(".prod suffix", () => {
      const r = parseRouteFilename("health.get.prod.ts");
      expect(r.pattern).toBe("/health");
      expect(r.method).toBe("get");
      expect(r.env).toBe("prod");
    });

    it("env without method", () => {
      const r = parseRouteFilename("debug.dev.ts");
      expect(r.pattern).toBe("/debug");
      expect(r.method).toBe("*");
      expect(r.env).toBe("dev");
    });
  });

  describe("dynamic params", () => {
    it("single param", () => {
      const r = parseRouteFilename("users/[id].ts");
      expect(r.pattern).toBe("/users/:id");
      expect(r.params).toEqual(["id"]);
      expect(r.catchAll).toBe(false);
    });

    it("single param with method", () => {
      const r = parseRouteFilename("users/[id].get.ts");
      expect(r.pattern).toBe("/users/:id");
      expect(r.method).toBe("get");
      expect(r.params).toEqual(["id"]);
    });

    it("multiple params in nested dirs", () => {
      const r = parseRouteFilename("api/[org]/[repo]/index.ts");
      expect(r.pattern).toBe("/api/:org/:repo");
      expect(r.params).toEqual(["org", "repo"]);
    });

    it("param as directory with static child", () => {
      const r = parseRouteFilename("api/[org]/[repo]/issues.ts");
      expect(r.pattern).toBe("/api/:org/:repo/issues");
      expect(r.params).toEqual(["org", "repo"]);
    });
  });

  describe("catch-all", () => {
    it("named catch-all", () => {
      const r = parseRouteFilename("hello/[...name].ts");
      expect(r.pattern).toBe("/hello/**:name");
      expect(r.params).toEqual(["name"]);
      expect(r.catchAll).toBe(true);
    });

    it("unnamed catch-all (404)", () => {
      const r = parseRouteFilename("[...].ts");
      expect(r.pattern).toBe("/**");
      expect(r.params).toEqual([]);
      expect(r.catchAll).toBe(true);
    });
  });

  describe("route groups", () => {
    it("single group", () => {
      const r = parseRouteFilename("api/(admin)/users.ts");
      expect(r.pattern).toBe("/api/users");
    });

    it("nested group", () => {
      const r = parseRouteFilename("api/(admin)/(v2)/reports.ts");
      expect(r.pattern).toBe("/api/reports");
    });

    it("group with dynamic param", () => {
      const r = parseRouteFilename("api/(public)/[id].get.ts");
      expect(r.pattern).toBe("/api/:id");
      expect(r.method).toBe("get");
      expect(r.params).toEqual(["id"]);
    });
  });

  describe("complex combinations", () => {
    it("nested dynamic with method and env", () => {
      const r = parseRouteFilename("api/users/[id].get.dev.ts");
      expect(r.pattern).toBe("/api/users/:id");
      expect(r.method).toBe("get");
      expect(r.env).toBe("dev");
      expect(r.params).toEqual(["id"]);
    });

    it("catch-all with method", () => {
      const r = parseRouteFilename("files/[...path].get.ts");
      expect(r.pattern).toBe("/files/**:path");
      expect(r.method).toBe("get");
      expect(r.catchAll).toBe(true);
      expect(r.params).toEqual(["path"]);
    });

    it("preserves filePath", () => {
      const r = parseRouteFilename("api/hello.get.ts");
      expect(r.filePath).toBe("api/hello.get.ts");
    });
  });
});
