# Spacepal MCP server

Lets Claude, Cursor and other MCP clients work with your macOS Spaces through
[Spacepal](https://getspacepal.com): "switch to my Mail Space", "what's on Desktop 3?",
"name this desktop Research".

![An agent lists Spaces, switches to Research and names a desktop through the Spacepal MCP server (illustration)](https://getspacepal.com/media/mcp-agent.gif)

It runs locally over stdio. It reads the Space list Spacepal writes to
`~/Library/Application Support/Spacepal/state.json` and sends commands through the
`spacepal://` URL scheme. It makes no network calls.

## Several Claude Code sessions

If you run Claude Code on several Spaces, Spacepal 1.2.12 and later marks the Space whose session is
waiting for you (a permission request or a question) or has finished, and `agent_sessions` lets an agent
see the same thing, for example to check whether the backend session is done. Turn it on in Spacepal:
Settings > General > Claude Code > Add to Claude Code. `list_spaces` also shows each project's git branch,
changed files and local dev servers.

![The Spacepal overview: two Spaces marked Waiting and one Done, with git branches and localhost servers (demo mode)](https://getspacepal.com/media/claude-waiting.gif)

More: [Spacepal for Claude Code](https://getspacepal.com/use-cases/claude-code/)

## Requirements

- macOS 14 or later, with Spacepal running (direct or Mac App Store build).
  [Download Spacepal](https://getspacepal.com/download/?utm_source=mcp-readme&utm_medium=readme): 14-day free trial, no account; names, notes and switching stay free after it.
- Node.js 18 or later

## Tools

| Tool | What it does |
|---|---|
| `list_spaces` | Every Space with its number, name, display, apps, note, and which one is active |
| `current_space` | The Space you are on |
| `switch_space` | Switch by number or name, or step with `next`, `previous`, `back` |
| `move_window_to_space` | Send the frontmost window to a Space by number or name, or to `next` or `previous` |
| `open_url` | Open a link in a new browser window on a chosen Space, or on the project's own Space by default, so it does not land in a browser window on another Space |
| `time_spent` | Hours and minutes spent on each Space today or over the last N days, per day if asked: "how long did I work on the API this week?" |
| `agent_sessions` | The Claude Code sessions by Space: which one is waiting for the user (and why), which finished, and since when |
| `inspect_project` | Read a project folder and suggest its desktop: name, note, icon, brand colour (from the logo or web manifest), dev server, git branch and open tasks |
| `new_project_space` | Make a desktop for a project folder and start Claude Code there; name, icon, colour and note are worked out from the folder unless you give them (direct version of Spacepal) |
| `rename_space` | Name a Space and give it an icon and a colour; an empty name restores "Desktop N" |
| `set_space_note` | Attach a short note to a Space |
| `open_overview` | Open Spacepal's overview grid |
| `list_profiles` | Names of your saved profiles |
| `apply_profile` | Apply a saved profile (names, colours, notes and automations) |
| `apply_template` | Name the Spaces from a starter template: Developer, Designer, Freelancer, Student, Streamer |
| `set_up_space` | Switch to a Space and run its automations: open its apps, URLs and files |
| `save_window_layout` | Save which Space and position every window is in |
| `restore_window_layout` | Put windows back from the last saved layout |
| `save_sessions` | Save terminal sessions and Chrome windows on one Space or all of them |
| `restore_sessions` | Reopen saved sessions on their Spaces |
| `place_window` | Put the front window in a half, a quarter, maximized, centred, or on the next display |
| `set_presentation_mode` | Hide Space names, notes and previews for a screen share, or show them again |
| `add_desktop` | Add a desktop on the current display |
| `remove_desktop` | Remove a desktop; its windows move to another one |
| `tidy_report` | Every Chrome window with its tabs and Space, what each Space is for, and the tabs Spacepal finds on the wrong Space (direct version of Spacepal 1.2.15+) |
| `tidy_up` | Move the tabs and windows Spacepal finds on the wrong Space to their own Space |
| `move_tab` | Move one Chrome tab to a Space, or bring it to the one you are on; it keeps its history |
| `move_browser_window` | Move a whole Chrome window to a Space without switching there |

## Prompt

`new_project` sets up a desktop for a project in one step: in Claude Code, type `/mcp__spacepal__new_project` (optionally with a folder). Claude inspects the folder, picks the name, icon, colour and note, makes the desktop and starts Claude Code there, then tells you what it chose.

Every tool is marked with MCP hints, so clients can tell the read-only tools apart and ask
before `remove_desktop` or `apply_template`, which change your setup.

`move_window_to_space` acts on the frontmost window. In Claude Desktop that is usually
Claude's own window. It moves the window directly on macOS 14.0–14.4 and 26.4+, and by
dragging it on other versions. `restore_window_layout` can only move windows between
Spaces on 14.0–14.4 and 26.4+.

The MCP server is free. The tools follow the app's own limits: after Spacepal's 14-day
trial, names and notes stay free, while the overview, sessions and other Pro features need a
license.

## Install

### Claude Code

```sh
claude mcp add spacepal -- npx -y spacepal-mcp
```

Or install the Spacepal plugin, which adds this server, the `/spacepal:spacepal` skill (sets up the
desktop you are on: name, icon, colour, note, tabs and windows moved where they belong) and the hooks
that mark the desktop whose session is waiting for you, in one step:

```sh
claude plugin marketplace add HalberdLLC/spacepal-mcp
claude plugin install spacepal@spacepal
```

If you already added the server with `claude mcp add`, remove it first (`claude mcp remove spacepal`) so
the tools are not listed twice. The plugin's hooks stay quiet when Spacepal's own hooks are in
`~/.claude/settings.json`.

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
