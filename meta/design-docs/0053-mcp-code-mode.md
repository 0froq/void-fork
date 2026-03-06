---
title: MCP Code Mode for Platform API
status: approved
---

# MCP Code Mode for Platform API

Add a `query` tool to the Void MCP server that lets AI agents write JavaScript to compose read-only platform API calls, inspired by [Cloudflare's Code Mode MCP](https://blog.cloudflare.com/code-mode-mcp/).

## Motivation

The current MCP server (`void mcp`) only exposes documentation tools. Agents that need platform data (projects, deployments, logs) must shell out to CLI commands and parse text output. A code mode tool lets agents compose multiple API queries in a single invocation with structured results.

## Design Decisions

- **Read-only operations only.** Mutations (deploy, create/delete project, set/delete secret, add/delete domain) stay in the CLI. Code mode is for querying and composing data.
- **Local execution.** Code runs in the `void mcp` process via `new AsyncFunction()`. No remote sandbox — the SDK methods are pre-authenticated HTTP calls to `api.void.cloud`, which already has auth and rate limiting.
- **Implicit auth.** The MCP server reads `~/.void/token` (or `VOID_TOKEN` env) at startup, same as the CLI. The token never enters the LLM context.
- **Coexists with docs tools.** The 3 existing tools (`list_pages`, `get_page`, `search_docs`) remain unchanged. `query` is a 4th tool.

## Tool Definition

```json
{
  "name": "query",
  "description": "Execute JavaScript to query the Void platform API. ...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "code": {
        "type": "string",
        "description": "JavaScript async arrow function to execute"
      }
    },
    "required": ["code"]
  }
}
```

The tool description includes the full SDK type signatures so the LLM knows what methods are available and what they return.

## SDK Methods

The `void` object is passed as the sole argument to the executed function. It wraps `PlatformClient` read-only methods:

| Method                                   | Maps to                                   | Returns                |
| ---------------------------------------- | ----------------------------------------- | ---------------------- |
| `void.me()`                              | `client.whoami()`                         | `{ login, plan }`      |
| `void.projects()`                        | `client.listProjects()`                   | `ProjectResponse[]`    |
| `void.deployments(projectId)`            | `client.listDeployments(projectId)`       | `DeploymentResponse[]` |
| `void.logs(projectId, opts?)`            | `client.getLogs(projectId, since, limit)` | `LogEntry[]`           |
| `void.secrets(projectId)`                | `client.listSecrets(projectId)`           | `{ name }[]`           |
| `void.domains(projectId)`                | `client.listDomains(projectId)`           | `DomainResponse[]`     |
| `void.domainStatus(projectId, domainId)` | `client.getDomainStatus(...)`             | `DomainStatusResponse` |

`logs()` accepts an optional options object: `{ since?: string, limit?: number }`. Defaults: `since = "1h"`, `limit = 200`.

## Execution Model

```typescript
const sdk = createQuerySdk(token);
const fn = new AsyncFunction("void", `return await (${code})()`);
const result = await Promise.race([
  fn(sdk),
  new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10_000)),
]);
```

- 10-second timeout via `Promise.race`
- Errors caught and returned as MCP error responses (`isError: true`)
- Result serialized via `JSON.stringify`

## Examples

**List projects:**

```js
async () => await void.projects()
```

**Recent errors for a specific project:**

```js
async () => {
  const projects = await void.projects();
  const p = projects.find(p => p.slug === "my-app");
  const logs = await void.logs(p.id, { since: "1h" });
  return logs.filter(l => l.exceptions.length > 0);
}
```

**Deployment status across all projects:**

```js
async () => {
  const projects = await void.projects();
  return Promise.all(projects.map(async p => {
    const deps = await void.deployments(p.id);
    const latest = deps[0];
    return { slug: p.slug, status: latest?.status, deployedAt: latest?.deployed_at };
  }));
}
```

## File Changes

All in the framework submodule:

1. **`packages/void/src/cli/mcp.ts`** — Add `query` tool definition, SDK factory, code execution handler. Import `PlatformClient` and auth utilities.
2. **`packages/void/test/unit/mcp.test.ts`** — Tests for the query tool with mocked API calls.

No new files. No new dependencies.
