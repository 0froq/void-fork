---
outline: deep
---

# Using Void with Coding Agents

[TODO]

Void ships with a built-in [MCP](https://modelcontextprotocol.io/) server that runs locally via stdio. It provides three tools — `list_pages`, `get_page`, and `search_docs` — giving your AI agent full access to the Void documentation, version-matched and offline-capable.

```sh
npx void mcp
```

## Automatic Setup

```sh
npx void init --agents
```

Detects your coding agent once and writes MCP config using that same context. If auto-detection fails, it asks you to choose from Claude Code, Cursor, Codex, Gemini CLI, or Generic.

- Agents with project-level config support (Claude, Cursor, etc.): `void init --agents` writes the config file for you.
- Agents without project-level config support (Codex, Gemini CLI, etc.): it prints the CLI command to register `npx void mcp`.
- Generic mode: it prints MCP JSON you can paste into your agent config.

## Manual Setup

### Claude Code

```sh
claude mcp add void -- npx void mcp
```

### Codex CLI

```sh
codex mcp add void -- npx void mcp
```

### Cursor

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "void": {
      "command": "npx",
      "args": ["void", "mcp"]
    }
  }
}
```

### Gemini CLI

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "void": {
      "command": "npx",
      "args": ["void", "mcp"]
    }
  }
}
```
