# Spacepal MCP server

Lets Claude, Cursor and other MCP clients work with your macOS Spaces through
[Spacepal](https://getspacepal.com): "switch to my Mail Space", "what's on Desktop 3?",
"name this desktop Research".

It runs locally over stdio. It reads the Space list Spacepal writes to
`~/Library/Application Support/Spacepal/state.json` and sends commands through the
`spacepal://` URL scheme. It makes no network calls.

## Requirements

- macOS 14 or later, with Spacepal running (direct or Mac App Store build)
- Node.js 18 or later

## Tools

| Tool | What it does |
|---|---|
| `list_spaces` | Every Space with its number, name, display, apps, and which one is active |
| `current_space` | The Space you are on |
| `switch_space` | Switch by number or name, or step with `next`, `previous`, `back` |
| `move_window_to_space` | Send the frontmost window to a Space by number or name, or to `next` or `previous` |
| `rename_space` | Name a Space; an empty name restores "Desktop N" |
| `open_overview` | Open Spacepal's overview grid |
| `set_space_note` | Attach a short note to a Space |
| `apply_profile` | Apply a saved Spacepal profile |

`move_window_to_space` acts on the frontmost window. In Claude Desktop that is usually
Claude's own window. Moving the frontmost window works on every supported macOS version.

## Install

### Claude Code

```sh
claude mcp add spacepal -- npx -y spacepal-mcp
```

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart
Claude:

```json
{
  "mcpServers": {
    "spacepal": { "command": "npx", "args": ["-y", "spacepal-mcp"] }
  }
}
```

### Cursor

Add the same block to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "spacepal": { "command": "npx", "args": ["-y", "spacepal-mcp"] }
  }
}
```

### From source

```sh
cd mcp && npm install
claude mcp add spacepal -- node "$PWD/index.js"
```

## Troubleshooting

- **"Spacepal is not running"**: open Spacepal from Applications.
- **Names are out of date**: Spacepal rewrites `state.json` when Spaces change. Open its
  menu once to refresh it.
- **Switching does nothing**: check Spacepal > Settings > Setup. It needs Accessibility
  permission.

MIT © Halberd LLC
