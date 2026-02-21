---
outline: deep
---

# Vite Cloud MCP Server

Vite Cloud ships with a built-in [MCP](https://modelcontextprotocol.io/) server that runs locally via stdio. It provides three tools — `list_pages`, `get_page`, and `search_docs` — giving your AI agent full access to the Vite Cloud documentation, version-matched and offline-capable.

```sh
npx vcc mcp
```

## Automatic Setup

```sh
npx vcc init --mcp
```

Detects which coding agents are present in your project and writes the MCP server config to the appropriate file. Supports Claude Code, Cursor, Windsurf, GitHub Copilot, and Roo Code. For agents without project-level config (Codex, Gemini CLI, etc.), prints the CLI command to run instead.

## Manual Setup

### Claude Code

```sh
claude mcp add vite-cloud -- npx vcc mcp
```

### Codex CLI

```sh
codex mcp add vite-cloud -- npx vcc mcp
```

### Cursor

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vite-cloud": {
      "command": "npx",
      "args": ["vcc", "mcp"]
    }
  }
}
```

### Gemini CLI

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "vite-cloud": {
      "command": "npx",
      "args": ["vcc", "mcp"]
    }
  }
}
```
