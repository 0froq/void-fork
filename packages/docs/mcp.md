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
npx vcc init --agents
```

Detects your coding agent once and writes MCP config using that same context. If auto-detection fails, it asks you to choose from Claude Code, Cursor, Codex, Gemini CLI, or Generic.

- Agents with project-level config support (Claude, Cursor, etc.): `vcc init --agents` writes the config file for you.
- Agents without project-level config support (Codex, Gemini CLI, etc.): it prints the CLI command to register `npx vcc mcp`.
- Generic mode: it prints MCP JSON you can paste into your agent config.

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
