---
name: spacepal
description: Set up and tidy the macOS desktop (Space) the user is on with the Spacepal MCP server. Looks at what the desktop is for, names it and gives it an icon, colour and note, moves browser tabs and windows to the desktops they belong on, pulls this desktop's own tabs here, and opens what the project needs. Use when the user types /spacepal, or asks to "tidy this desktop", "set up this Space", "bring my tabs here", "masaüstünü toparla".
---

# /spacepal: put this desktop in order

Work on the desktop (Space) the user is on now, through the Spacepal MCP tools (`mcp__spacepal__*`, or `mcp__plugin_spacepal_spacepal__*` when Spacepal is installed as a Claude Code plugin). Arguments narrow the job: `/spacepal tidy` only tidies tabs and windows, `/spacepal name` only names and styles, `/spacepal here <project>` pulls a project's tabs here. With no argument do all steps.

If the Spacepal tools are missing, tell the user to add the Spacepal MCP server with `claude mcp add -s user spacepal -- npx -y spacepal-mcp` and start a new session, then stop. If they say Spacepal is not running, say so in one line and stop. Tab and window tools are only in the direct version of Spacepal; if they fail, skip that step and say why.

## 1. Understand this desktop

- `current_space` and `list_spaces`: this desktop's number, name, note, icon, apps; the other desktops' names and notes.
- If the working folder or this desktop's project folder is a code project, `inspect_project` on it. `agent_sessions` shows Claude Code sessions here.
- `tidy_report`: every Chrome window with its tabs and desktop, plus what each desktop is for (folder, repositories, dev server ports).

Decide in one sentence what this desktop is for (a project, a client, mail and chat, music...). Base it on the folder, the apps and the tabs actually here, not on guesses.

## 2. Name, icon, colour, note

Only when they are missing or clearly wrong ("Desktop 4", or a name that does not match what is on it):
- `rename_space` with a short name (the project or client name, as the user writes it elsewhere), an SF Symbol and a #RRGGBB colour that differs from the neighbouring desktops.
- `set_space_note` with one line: what it is for, and the folder or URL when there is one. Keep an existing note unless it is empty or wrong.
Do not rename a desktop the user clearly named themselves. Every change here is easy to undo; report the old values so the user can ask for them back.

## 3. Tidy tabs and windows

1. Spacepal's own suggestions (dev server ports, repositories, desktop names in addresses) are safe: if `tidy_report` lists any, call `tidy_up`.
2. Then judge the rest yourself, but only what touches this desktop:
   - tabs in this desktop's windows that clearly belong to another desktop's project or client: `move_tab` with that desktop;
   - tabs on other desktops that clearly belong here: `move_tab` without `space` brings them here;
   - a whole window that belongs here or elsewhere: `move_browser_window`.
   "Clearly" means the address names the project, its domain, its repository, its admin or dashboard, or its client. Sites people keep everywhere (ChatGPT, Claude, Gmail, Google search, calendars, docs home pages) stay where they are. When unsure, leave it and list it.
3. Tabs that sit on two other desktops (neither is this one): do not move them; list them at the end as suggestions.

## 4. Bring what the project needs

- A dev server of this desktop's project is running (`list_spaces`/`tidy_report` ports) but no tab shows it: `open_url` with `http://localhost:<port>`.
- The project has a repository and no tab of it is open, and the user asked for a full setup: offer, do not open unasked.
Never start servers, terminals or apps the user did not ask for.

## 5. Report

Answer in the user's language, short:
- what this desktop is for, and the name/icon/colour/note set (with the old values if changed);
- what moved where, one line each, with the reason;
- what you left alone and why, as suggestions the user can approve.
Optionally one line from `time_spent` for this desktop today.

## Rules

- No deleting: never close tabs or windows, remove desktops, or apply profiles or templates from this skill.
- Ask before moving more than 15 tabs at once.
- Addresses are private: do not repeat full URLs with tokens; the report already drops query strings.

