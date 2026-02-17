---
outline: deep
---

# Vite Cloud MCP Server

The Vite Cloud documentation is available as an [MCP](https://modelcontextprotocol.io/) server at:

```
https://mcp.vite.cloud/mcp
```

It provides three tools: `list_pages`, `get_page`, and `search_docs` — giving your AI agent full access to the Vite Cloud documentation.

## Setup

### Claude Code

```sh
claude mcp add vite-cloud --transport http https://mcp.vite.cloud/mcp
```

### Codex CLI

```sh
codex mcp add vite-cloud --url https://mcp.vite.cloud/mcp
```

### Cursor

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vite-cloud": {
      "url": "https://mcp.vite.cloud/mcp"
    }
  }
}
```

### Gemini CLI

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "vercel": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.vite.cloud/mcp"]
    }
  }
}
```
