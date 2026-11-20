#!/usr/bin/env node
// Spacepal MCP server (stdio).
// Reads the live Space list from the state.json Spacepal writes, and sends
// commands through the spacepal:// URL scheme. Nothing leaves the Mac.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspectProject } from "./project.js";

const run = promisify(execFile);
const VERSION = "0.10.0";

// Direct build writes to Application Support; the App Store build is sandboxed.
const SUPPORT_DIRS = [
  join(homedir(), "Library/Application Support/Spacepal"),
  join(homedir(), "Library/Containers/com.halberd.spacepal/Data/Library/Application Support/Spacepal"),
];
const STATE_FILES = SUPPORT_DIRS.map((d) => join(d, "state.json"));
// Per-Space settings, including the folders of the terminals that belong to each Space.
const SPACE_FILES = SUPPORT_DIRS.map((d) => join(d, "spaces.json"));
const PROFILE_FILES = SUPPORT_DIRS.map((d) => join(d, "profiles.json"));
const STATS_FILES = SUPPORT_DIRS.map((d) => join(d, "stats.json"));
// Browser windows, tabs and Tidy Up's suggestions; direct build only.
const TIDY_FILES = SUPPORT_DIRS.map((d) => join(d, "tidy.json"));
const TIDY_ALL_FILES = SUPPORT_DIRS.map((d) => join(d, "tidy-all.json"));
// Built into the app (Profiles.swift, SpaceTemplate.all()).
const TEMPLATES = ["Developer", "Designer", "Freelancer", "Student", "Streamer"];

const NOT_RUNNING = "Spacepal is not running. Open Spacepal (getspacepal.com) and try again.";
const DOWNLOAD_URL = "https://getspacepal.com/download/?utm_source=mcp&utm_medium=tool&utm_campaign=not_installed";
const NOT_INSTALLED =
  "Spacepal is not installed on this Mac. This MCP server needs the Spacepal app, which names, previews and switches macOS Spaces. " +
  `Download it from ${DOWNLOAD_URL} (14-day free trial, no account; names and switching stay free after the trial), open it once, then try again.`;

// Not running and never installed reads differently: the user needs a download link, not "open it".
async function notRunning() {
  const places = [
    "/Applications/Spacepal.app",
    join(homedir(), "Applications/Spacepal.app"),
    ...SUPPORT_DIRS,
  ];
  for (const p of places) {
    try {
      await stat(p);
      return NOT_RUNNING;
    } catch {}
  }
  return NOT_INSTALLED;
}

async function isRunning() {
  try {
    await run("/usr/bin/pgrep", ["-x", "Spacepal"]);
    return true;
  } catch {
    return false;
  }
}

async function newestFile(paths) {
  let newest = null;
  for (const path of paths) {
    try {
      const { mtimeMs } = await stat(path);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
    } catch {}
  }
  return newest?.path ?? null;
}

async function readState() {
  const path = await newestFile(STATE_FILES);
  return path ? JSON.parse(await readFile(path, "utf8")) : null;
}

async function readProfiles() {
  const path = await newestFile(PROFILE_FILES);
  if (!path) return [];
  try {
    return JSON.parse(await readFile(path, "utf8")).map((p) => p.name);
  } catch {
    return [];
  }
}

async function send(path, query = {}) {
  if (!(await isRunning())) throw new Error(await notRunning());
  // Encode with %20, not "+": the app reads query values with URLComponents, which keeps "+".
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const url = `spacepal://${path}${qs ? `?${qs}` : ""}`;
  // -g keeps Spacepal from stealing focus from the client.
  await run("/usr/bin/open", ["-g", url]);
  return url;
}

// A Space can be addressed by desktop number or by name.
function ref(space) {
  if (space === undefined || space === null || space === "") return "current";
  if (typeof space === "number" || /^\d+$/.test(String(space))) return String(space);
  return encodeURIComponent(String(space));
}

async function findSpace(space) {
  const state = await readState();
  if (!state) return null;
  const key = String(space).toLowerCase();
  return state.spaces.find((s) => String(s.number) === key || s.name.toLowerCase() === key) ?? null;
}

const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (t) => ({ content: [{ type: "text", text: t }], isError: true });
const settle = () => new Promise((r) => setTimeout(r, 600));

// state.json is rewritten after the switch animation; poll until "current" changes.
async function waitForSwitch(before, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    const current = (await readState())?.current;
    if (current && current !== before) return current;
  }
  return null;
}

function guarded(fn) {
  return async (args) => {
    try {
      return await fn(args ?? {});
    } catch (e) {
      return fail(e.message ?? String(e));
    }
  };
}

const INSTRUCTIONS = `Spacepal MCP server: work with macOS Spaces (desktops) through the Spacepal app on this Mac.

Start with list_spaces to learn the Spaces, their numbers, names, notes and the apps on each; most tools take a Space by desktop number or by name from that list. Use current_space when you only need the active one.

Tools that only read: list_spaces, current_space, list_profiles, agent_sessions, time_spent, inspect_project, tidy_report, tidy_all_report.

When the user wants a desktop for a project, call new_project_space: it works out the name, icon, colour and note from the folder by itself, so do not ask the user for them. Call inspect_project first if you want to check or improve its choices; rename_space changes them later. Tools that change the user's screen or setup: everything else. Ask the user before remove_desktop, apply_template and apply_profile, which replace or remove things; rename_space and set_space_note are easy to undo by calling them again.

To show the user a web page (docs, a pull request, a local dev server, a sign-in page), call open_url instead of running "open <url>" in a shell. A shell open puts the page in whichever browser window was used last, often on another Space where the user cannot find it. Leave open_url's space out and the page opens on this project's Space.

Browser tabs on the wrong Space: call tidy_report. It lists every Chrome window with its tabs and Space, what each Space is for (folder, repositories, dev server ports) and Spacepal's own suggestions. Spacepal's rule-based suggestions are safe to apply with tidy_up. For the tabs it leaves alone, judge from the addresses and the Space names, notes and folders, then use move_tab or move_browser_window; tell the user what you moved and why. Leave tabs alone when unsure, and never move tabs of sites people keep everywhere (chat assistants, mail, search). These tools are in the direct version of Spacepal only.

To tidy every desktop at once (Spacepal Pro): call tidy_all_report for app windows and tidy_report for Chrome tabs, decide where each belongs, send things that belong to no desktop to the desktop called "Inbox", show the user the plan grouped by destination and ask before moving anything. Then move with move_app_window, move_tab and move_browser_window. Leave terminals and windows the report marks as fitting where they are.

Every action goes through Spacepal, so it must be running (macOS 14 or later). Nothing is sent over the network. If a tool says Spacepal is not running, tell the user to open it. If it says Spacepal is not installed, give the user the download link from the message. The overview, sessions and tidying every desktop need Spacepal Pro (on for the first 14 days); names, notes, switching and window tools are free.`;

const server = new McpServer({ name: "spacepal", version: VERSION }, { instructions: INSTRUCTIONS });

const spaceArg = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe(
    'Which Space: its desktop number (1 = leftmost on the display) or its name as list_spaces shows it, e.g. "Mail". Names match without regard to case.',
  );
const optionalSpaceArg = spaceArg.optional().describe(
  'Which Space: desktop number or name from list_spaces. Leave it out for the Space the user is on now.',
);

const spaceEntry = z
  .object({
    id: z.string().describe("Stable id of the Space"),
    name: z.string().describe("Name shown in Spacepal, or \"Desktop N\" if unnamed"),
    number: z.number().int().optional().describe("Desktop number on its display; absent for full-screen Spaces"),
    display: z.string().describe("Id of the display the Space is on"),
    isActive: z.boolean().describe("True for the Space currently shown on its display"),
    isFullscreen: z.boolean().describe("True for an app's full-screen Space"),
    apps: z.array(z.string()).describe("Apps with a window on this Space"),
    note: z.string().optional().describe("The user's note about what the Space is for"),
    color: z.string().optional().describe("Colour as #RRGGBB"),
    agent: z.enum(["waiting", "done"]).optional().describe("A coding agent (Claude Code) on this Space is waiting for the user, or has finished"),
    agentMessage: z.string().optional().describe("Why the agent is waiting, e.g. \"Claude needs your permission to use Bash\""),
    agentSince: z.string().optional().describe("When the agent started waiting or finished, ISO 8601"),
    agentFolder: z.string().optional().describe("The agent's working folder"),
    projectFolder: z.string().optional().describe("The project folder of the Space's terminals"),
    branch: z.string().optional().describe("Git branch of the project folder"),
    changes: z.number().int().optional().describe("Files changed in the project's git working tree"),
    ports: z.array(z.number().int()).optional().describe("Local dev servers started from the project folder, e.g. 3000"),
  })
  .passthrough();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

server.registerTool(
  "list_spaces",
  {
    title: "List Spaces",
    description:
      "List every macOS Space (desktop) on every display: desktop number, name, note, the apps with windows on it, and which one is active. " +
      "Read-only. Call this first to get valid Space numbers and names for the other tools. " +
      "Fails if Spacepal is not running or has not written its list yet.",
    inputSchema: {},
    outputSchema: { current: z.string().describe("Name of the active Space"), spaces: z.array(spaceEntry) },
    annotations: { title: "List Spaces", ...RO },
  },
  guarded(async () => {
    if (!(await isRunning())) return fail(await notRunning());
    const state = await readState();
    if (!state) return fail("Spacepal has not written its Space list yet. Open the Spacepal menu once and try again.");
    const lines = state.spaces.map((s) => {
      const label = s.isFullscreen ? "full screen" : `Desktop ${s.number ?? "?"}`;
      const apps = s.apps?.length ? ` — ${s.apps.join(", ")}` : "";
      const note = s.note ? ` (note: ${s.note})` : "";
      const agent = s.agent === "waiting" ? " [Claude waiting for the user]" : s.agent === "done" ? " [Claude finished]" : "";
      const git = s.branch ? ` {${s.branch}${s.changes ? `, ${s.changes} changed` : ""}${s.ports?.length ? `, localhost:${s.ports.join(", localhost:")}` : ""}}` : "";
      return `${s.isActive ? "*" : " "} ${label}: ${s.name}${agent}${git}${apps}${note}`;
    });
    const displays = new Set(state.spaces.map((s) => s.display)).size;
    return {
      content: [
        { type: "text", text: `Current: ${state.current}\n${displays} display(s), ${state.spaces.length} Spaces (* = active)\n${lines.join("\n")}` },
      ],
      structuredContent: { current: state.current ?? "", spaces: state.spaces },
    };
  }),
);

server.registerTool(
  "current_space",
  {
    title: "Current Space",
    description:
      "Return the Space the user is on now: its name and desktop number (one per display). " +
      "Read-only and cheaper than list_spaces when you only need the active Space.",
    inputSchema: {},
    outputSchema: { spaces: z.array(spaceEntry).describe("The active Space on each display") },
    annotations: { title: "Current Space", ...RO },
  },
  guarded(async () => {
    if (!(await isRunning())) return fail(await notRunning());
    const state = await readState();
    if (!state) return fail("Spacepal has not written its Space list yet. Open the Spacepal menu once and try again.");
    const active = state.spaces.filter((s) => s.isActive);
    const t = active.length
      ? active.map((s) => `${s.name} (Desktop ${s.number ?? "full screen"})`).join("\n")
      : `Current: ${state.current || "unknown"}`;
    return { content: [{ type: "text", text: t }], structuredContent: { spaces: active } };
  }),
);

server.registerTool(
  "switch_space",
  {
    title: "Switch Space",
    description:
      "Show another Space on the user's screen, instantly and without the slide animation. " +
      'Give a desktop number or name from list_spaces, or "next", "previous" (neighbouring desktop) or "back" (the Space shown before). ' +
      "Changes only what is visible; no windows move. Undo with space=\"back\". Returns the Space now shown; fails if no Space has that name.",
    inputSchema: {
      space: spaceArg.describe(
        'Desktop number or name from list_spaces, or one of "next", "previous", "back".',
      ),
    },
    annotations: { title: "Switch Space", ...CHANGE, idempotentHint: true },
  },
  guarded(async ({ space }) => {
    const before = (await readState())?.current;
    const s = String(space).toLowerCase();
    if (["next", "right"].includes(s)) await send("next");
    else if (["previous", "prev", "left"].includes(s)) await send("previous");
    else if (["back", "last"].includes(s)) await send("back");
    else {
      const target = await findSpace(space);
      if (!target) return fail(`No Space called "${space}". Call list_spaces to see the names.`);
      // Spacepal treats "switch to the Space you are on" as back-and-forth, so skip it.
      if (target.isActive) return text(`Already on ${target.name}.`);
      await send(`switch/${ref(space)}`);
    }
    const now = await waitForSwitch(before);
    return text(now ? `Switched. Now on: ${now}` : "Switch sent; Spacepal has not confirmed it yet.");
  }),
);

server.registerTool(
  "move_window_to_space",
  {
    title: "Move window to Space",
    description:
      "Move the user's frontmost window to another Space; the window keeps its size and position. " +
      'Target is a desktop number or name from list_spaces, or "next"/"previous". ' +
      "The frontmost window is the one the user last focused: from a terminal client that is usually the window they worked in, " +
      "from Claude Desktop it is Claude's own window. On macOS 14.0-14.4 and 26.4+ the window moves directly; on other versions " +
      "Spacepal drags it, which takes a moment. Depending on the user's settings the screen may follow the window. " +
      "Undo by moving it back. Fails if no Space has that name.",
    inputSchema: {
      space: spaceArg.describe('Target desktop number or name from list_spaces, or "next" / "previous".'),
    },
    annotations: { title: "Move window to Space", ...CHANGE },
  },
  guarded(async ({ space }) => {
    const s = String(space).toLowerCase();
    if (["next", "right"].includes(s)) await send("move-window/next");
    else if (["previous", "prev", "left"].includes(s)) await send("move-window/previous");
    else {
      if (!(await findSpace(space))) return fail(`No Space called "${space}". Call list_spaces to see the names.`);
      await send(`move-window/${ref(space)}`);
    }
    return text(`Asked Spacepal to move the front window to ${space}.`);
  }),
);

// The Space of the project this client works in: the one whose terminals run in this folder
// (Spacepal records them), or whose note names it. A coding agent's MCP server starts in the
// project folder; Claude Desktop starts it in "/", which matches nothing.
async function projectSpace(state) {
  const cwd = process.cwd().replace(/\/+$/, "");
  if (!state || cwd === "" || cwd === homedir()) return null;
  const spaces = state.spaces.filter((s) => !s.isFullscreen);
  let meta = {};
  try {
    const path = await newestFile(SPACE_FILES);
    meta = path ? JSON.parse(await readFile(path, "utf8")) : {};
  } catch {}
  const folders = (s) => (meta[s.id]?.automation?.terminals ?? []).map((t) => String(t.folder ?? "").replace(/\/+$/, ""));
  // 1. A terminal on exactly this folder.
  const exact = spaces.filter((s) => folders(s).includes(cwd));
  if (exact.length === 1) return exact[0];
  // 2. A note that names the folder.
  const short = cwd.replace(homedir(), "~");
  const named = spaces.filter((s) => s.note && (s.note.includes(cwd) || s.note.includes(short)));
  if (named.length === 1) return named[0];
  // 3. The deepest parent folder, if only one Space has it (~/workspace is on many).
  let best = { spaces: [], len: 0 };
  for (const s of spaces) {
    for (const f of folders(s)) {
      if (!f || f === homedir() || !cwd.startsWith(f + "/")) continue;
      if (f.length > best.len) best = { spaces: [s], len: f.length };
      else if (f.length === best.len && !best.spaces.includes(s)) best.spaces.push(s);
    }
  }
  return best.spaces.length === 1 ? best.spaces[0] : null;
}

server.registerTool(
  "inspect_project",
  {
    title: "Inspect project folder",
    description:
      "Read a project folder and suggest how its Spacepal desktop should look, so you do not have to ask the user: a display name (README title or folder), " +
      "a one-line description for the Space note (package.json or README), an SF Symbol that fits the stack and topic, a brand colour (web manifest theme colour, " +
      "theme-color meta tag, the SVG logo's main colour or a CSS brand variable) and where it came from, the logo file, the dev server command and URL, " +
      "the git branch and remote, and open tasks (unchecked boxes in TODO.md or ROADMAP.md). Read-only and local; new_project_space uses it by itself.",
    inputSchema: {
      folder: z.string().min(1).optional().describe('Absolute path, or one starting with "~/". Leave it out to use your working folder.'),
    },
    annotations: { title: "Inspect project folder", ...RO },
  },
  guarded(async ({ folder }) => {
    const info = await inspectProject((folder ?? process.cwd()).replace(/^~(?=\/|$)/, homedir()));
    const lines = [
      `Name: ${info.name}`,
      `Note: ${info.description ?? "(none found)"}`,
      `Icon: ${info.symbol}${info.stack.length ? ` (stack: ${info.stack.join(", ")})` : ""}`,
      `Colour: ${info.color ? `${info.color} from ${info.color_from}` : "(none found; Spacepal picks one)"}`,
      `Logo: ${info.logo ?? "(none found)"}`,
      `Dev server: ${info.dev ? `${info.dev.command}${info.dev.url ? ` → ${info.dev.url}` : ""}` : "(none found)"}`,
      `Git: ${info.git ? `${info.git.branch}${info.git.remote ? ` · ${info.git.remote}` : ""}` : "(not a git repository)"}`,
      `Open tasks: ${info.tasks.length ? info.tasks.map((t) => `\n  - ${t.text} (${t.file})`).join("") : "(none found in TODO/ROADMAP files)"}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: info };
  }),
);

server.registerTool(
  "new_project_space",
  {
    title: "New project Space",
    description:
      "Make a Space for a project folder: Spacepal adds a desktop (or uses an empty unnamed one when macOS has no room for more), " +
      "names it, gives it an icon, a colour and a note, remembers the folder's terminal as that Space's, switches to it and opens a terminal there running a command (claude by default). " +
      "Anything you leave out is filled in from the folder (see inspect_project): the README title, an SF Symbol for the stack, the brand colour from the logo or web manifest, " +
      "and the package or README description as the note. Optionally opens a link (for example the dev server) in a new browser window on it. " +
      "Changes the user's desktops, so ask first unless the user asked for it. Direct version of Spacepal only; fails if the folder does not exist.",
    inputSchema: {
      folder: z.string().min(1).describe('Absolute path of the project folder, or one starting with "~/". Leave it out to use your working folder.').optional(),
      name: z.string().min(1).optional().describe("Name for the Space. Default: the README title, or the folder's name."),
      command: z.string().optional().describe('Run in the new terminal. Default "claude"; "" opens a plain shell.'),
      url: z.string().optional().describe("A link to open on the new Space, e.g. http://localhost:3000. Not opened unless given, since the dev server may not be running."),
      symbol: z.string().max(80).optional().describe('SF Symbol for the icon, e.g. "hammer", "cart", "server.rack". Default: picked from the project; "" for none.'),
      color: z.string().regex(/^(#?[0-9a-fA-F]{6})?$/).optional().describe('Colour as #RRGGBB. Default: the brand colour found in the project; "" for none.'),
      note: z.string().max(500).optional().describe('Note for the Space. Default: the project description; "" for none.'),
    },
    annotations: { title: "New project Space", ...CHANGE },
  },
  guarded(async ({ folder, name, command, url, symbol, color, note }) => {
    const path = (folder ?? process.cwd()).replace(/^~(?=\/|$)/, homedir());
    try {
      if (!(await stat(path)).isDirectory()) return fail(`${path} is not a folder.`);
    } catch {
      return fail(`No folder at ${path}.`);
    }
    const info = await inspectProject(path).catch(() => null);
    name ??= info?.name ?? path.split("/").pop();
    symbol ??= info?.symbol;
    color ??= info?.color ?? undefined;
    note ??= info?.description ?? undefined;
    const query = { folder: path, name };
    if (command !== undefined) query.command = command === "" ? "none" : command;
    if (url) query.url = url;
    const before = (await readState())?.spaces.length ?? 0;
    await send("new-project", query);
    // Adding a desktop goes through Mission Control and takes a few seconds.
    const end = Date.now() + 9000;
    const want = name.toLowerCase();
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 400));
      const state = await readState();
      const made = state?.spaces.find((s) => s.name.toLowerCase() === want);
      if (made) {
        const style = {};
        if (symbol) style.symbol = symbol;
        if (color) style.color = color;
        if (Object.keys(style).length) await send(`style/${ref(made.name)}`, style);
        if (note) await send(`note/${ref(made.name)}`, { text: note });
        const look = [symbol && `icon ${symbol}`, color && `colour ${color}`, note && "a note"].filter(Boolean).join(", ");
        const extra = [
          info?.dev && !url ? `Dev server: ${info.dev.command}${info.dev.url ? ` (${info.dev.url}); pass url to open it there` : ""}.` : "",
          info?.tasks?.length ? `${info.tasks.length} open task(s) in ${[...new Set(info.tasks.map((t) => t.file))].join(", ")}.` : "",
        ].filter(Boolean).join(" ");
        return text(`Made "${made.name}" (Desktop ${made.number ?? "?"}) for ${path}${look ? ` with ${look}` : ""}${command === "" ? "" : `, running ${command ?? "claude"}`}.${extra ? " " + extra : ""}`);
      }
    }
    return text(`Asked Spacepal to set up a Space for ${path}. It may still be adding the desktop${before >= 16 ? "; macOS allows 16 desktops per display, so remove one if it cannot" : ""}.`);
  }),
);

server.registerPrompt(
  "new_project",
  {
    title: "New project desktop",
    description: "Set up a Spacepal desktop for a project: name, icon, colour, note and dev server worked out from the folder, Claude Code started there.",
    argsSchema: { folder: z.string().optional().describe("Project folder. Leave empty for the current one.") },
  },
  ({ folder }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Set up a Spacepal desktop for the project in ${folder ? folder : "this working folder"}.

1. Call inspect_project${folder ? ` with folder "${folder}"` : ""}.
2. Check what it found. If the icon does not fit what the project is about, pick a better SF Symbol. If no colour was found, choose one that suits the logo or the topic. Keep the note to one line.
3. Call new_project_space with those values. I asked for it, so you do not need to ask me first. Do not pass url unless the dev server is already running.
4. Tell me in a few lines what you made: name, icon, colour and where it came from, the note, the dev server command, and the open tasks if there are any.`,
      },
    }],
  }),
);

server.registerTool(
  "agent_sessions",
  {
    title: "Coding agent sessions",
    description:
      "List the Claude Code sessions Spacepal knows on this Mac, one per Space: the project folder, whether the session is waiting for the user " +
      "(and why, e.g. a permission request) or has finished its turn, and since when. Read-only. Use it to tell the user which other sessions need them, " +
      "or to check whether another agent has finished before you continue. Waiting and finished states need Spacepal's Claude Code hooks " +
      "(Spacepal Settings > General > Claude Code > Add to Claude Code); without them only the folders are listed.",
    inputSchema: {},
    annotations: { title: "Coding agent sessions", ...RO },
  },
  guarded(async () => {
    if (!(await isRunning())) return fail(await notRunning());
    const state = await readState();
    if (!state) return fail("Spacepal has not written its Space list yet.");
    let meta = {};
    try {
      const path = await newestFile(SPACE_FILES);
      meta = path ? JSON.parse(await readFile(path, "utf8")) : {};
    } catch {}
    const ago = (iso) => {
      const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
      return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
    };
    const rows = [];
    for (const s of state.spaces) {
      const claudeFolders = (meta[s.id]?.automation?.terminals ?? [])
        .filter((t) => /\bclaude\b/.test(t.command ?? ""))
        .map((t) => t.folder)
        .sort((a, b) => b.length - a.length);
      if (!s.agent && !claudeFolders.length) continue;
      const folder = s.agentFolder ?? claudeFolders[0];
      const status = s.agent === "waiting" ? `WAITING for the user${s.agentMessage ? `: ${s.agentMessage}` : ""} (${ago(s.agentSince)})`
        : s.agent === "done" ? `finished (${ago(s.agentSince)})` : "no news (working, idle, or hooks not set up)";
      rows.push(`${s.isActive ? "*" : " "} Desktop ${s.number ?? "?"} ${s.name} — ${folder?.replace(homedir(), "~") ?? "?"} — ${status}`);
    }
    const waiting = state.spaces.filter((s) => s.agent === "waiting").length;
    return text(rows.length
      ? `${waiting} waiting for the user (* = Space on screen)\n${rows.join("\n")}`
      : "Spacepal knows no Claude Code sessions. Sessions show up after Spacepal saves the Space's terminals, or once its Claude Code hooks are added.");
  }),
);

// Default browser's app path, via AppKit from JXA (no extra permission needed).
async function defaultBrowser() {
  try {
    const { stdout } = await run("/usr/bin/osascript", [
      "-l", "JavaScript", "-e",
      "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('https://example.com')).path.js",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Opens the link in a NEW window of the default browser, so it lands on the Space shown now
// instead of in the browser window the user used last (which may be on another Space).
async function openInNewWindow(url) {
  const app = await defaultBrowser();
  const name = app ? app.split("/").pop().replace(/\.app$/, "") : "";
  if (/safari/i.test(name)) {
    await run("/usr/bin/osascript", [
      "-e", "on run argv",
      "-e", `tell application "${name}" to make new document with properties {URL:item 1 of argv}`,
      "-e", `tell application "${name}" to activate`,
      "-e", "end run", url,
    ]);
  } else if (/firefox|zen|librewolf|floorp/i.test(name)) {
    await run("/usr/bin/open", ["-na", app, "--args", "-new-window", url]);
  } else if (app && /chrome|chromium|brave|edge|vivaldi|opera|arc|dia|comet|thorium/i.test(name)) {
    await run("/usr/bin/open", ["-na", app, "--args", "--new-window", url]);
  } else {
    await run("/usr/bin/open", [url]);
  }
  return name || "the default browser";
}

server.registerTool(
  "open_url",
  {
    title: "Open link on a Space",
    description:
      "Open a web link in a new window of the user's default browser, on the Space you choose. " +
      "Leave space out to open it on the Space of the project you are working in (the Space whose terminals run in your working folder), or on the user's current Space if none matches. " +
      "Use it instead of the shell's open command: that adds a tab to the browser window used last, which may be on another Space, so the user cannot find it. " +
      "With a space, Spacepal briefly shows that Space, opens the window there, then returns to the Space the user was on (stay=true keeps that Space on screen). " +
      "Only http and https links. Fails if no Space has that name.",
    inputSchema: {
      url: z.string().min(1).describe('The link, e.g. "https://example.com". "example.com" is read as https.'),
      space: spaceArg.optional().describe(
        "Desktop number or name from list_spaces. Leave it out for this project's Space, or the current Space if Spacepal does not know the project.",
      ),
      stay: z.boolean().optional().describe("Stay on that Space afterwards instead of returning. Default false."),
    },
    annotations: { title: "Open link on a Space", ...CHANGE, openWorldHint: true },
  },
  guarded(async ({ url, space, stay }) => {
    let link = String(url).trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(link)) link = `https://${link}`;
    let parsed;
    try {
      parsed = new URL(link);
    } catch {
      return fail(`"${url}" is not a valid link.`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return fail("Only http and https links can be opened.");
    if (!(await isRunning())) return fail(await notRunning());

    const state = await readState();
    const origin = state?.spaces.find((s) => s.isActive);
    const target = space === undefined ? await projectSpace(state) : await findSpace(space);
    if (space !== undefined && !target) return fail(`No Space called "${space}". Call list_spaces to see the names.`);
    if (target?.isFullscreen) return fail(`${target.name} is a full-screen app; pick a desktop.`);

    const elsewhere = target && !target.isActive;
    // Spacepal's "Keep with me" would otherwise bring the new window back to the Space the user returns to.
    // Older Spacepal versions ignore this command.
    if (elsewhere) await send("hold-windows/8");
    if (elsewhere) {
      await send(`switch/${ref(target.number ?? target.name)}`);
      if (!(await waitForSwitch(state?.current))) return fail(`Could not switch to ${target.name}; the link was not opened.`);
      await new Promise((r) => setTimeout(r, 300));
    }
    const browser = await openInNewWindow(parsed.href);
    const where = target?.name ?? origin?.name ?? "the current Space";
    if (elsewhere && !stay && origin) {
      // Give the browser time to put its window on this Space before leaving it.
      await new Promise((r) => setTimeout(r, 1800));
      await send(`switch/${ref(origin.number ?? origin.name)}`);
      await waitForSwitch(target.name);
      return text(`Opened ${parsed.href} in a new ${browser} window on ${where}, then returned to ${origin.name}.`);
    }
    return text(`Opened ${parsed.href} in a new ${browser} window on ${where}.`);
  }),
);

server.registerTool(
  "time_spent",
  {
    title: "Time spent per Space",
    description:
      "How long the user spent on each Space (desktop), from Spacepal's time tracking, for today or the last N days. " +
      "Use it to answer \"how many hours did I work on this project this week\" or to copy hours into a time tracker or invoice. " +
      "A Space stands for whatever the user keeps on it (a project, a client), so check its name and note with list_spaces. " +
      "Time counts while the Space is on screen and the Mac is awake; it is stored only on this Mac. Read-only.",
    inputSchema: {
      days: z.number().int().min(1).max(366).optional().describe("1 = today only (default 7: today and the 6 days before)."),
      space: spaceArg.optional().describe("Only this Space (desktop number or name). Leave out for every Space."),
      by_day: z.boolean().optional().describe("Also list the minutes per day."),
    },
    outputSchema: {
      days: z.number().int(),
      from: z.string().describe("First day counted, yyyy-MM-dd"),
      to: z.string().describe("Last day counted (today), yyyy-MM-dd"),
      total_minutes: z.number().int(),
      spaces: z.array(z.object({
        id: z.string(),
        name: z.string(),
        minutes: z.number().int(),
        hours: z.number().describe("Minutes / 60, rounded to two decimals"),
        per_day: z.record(z.string(), z.number().int()).optional().describe("yyyy-MM-dd -> minutes"),
      })),
    },
    annotations: { title: "Time spent per Space", ...RO },
  },
  guarded(async ({ days = 7, space, by_day = false }) => {
    const path = await newestFile(STATS_FILES);
    if (!path) return fail("No time recorded yet. Time tracking is in Spacepal Settings > Time; it is on by default.");
    const stats = JSON.parse(await readFile(path, "utf8"));
    const state = await readState();
    let meta = {};
    try {
      const mp = await newestFile(SPACE_FILES);
      meta = mp ? JSON.parse(await readFile(mp, "utf8")) : {};
    } catch {}
    const nameOf = (id) => {
      const live = state?.spaces.find((s) => s.id === id);
      return live?.name ?? meta[id]?.name ?? "Removed Space";
    };
    let only = null;
    if (space !== undefined) {
      only = await findSpace(space);
      if (!only) return fail(`No Space called "${space}".`);
    }
    // stats.json days are local calendar days, as Spacepal writes them.
    const day = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const totals = {};
    for (let i = days - 1; i >= 0; i--) {
      const key = day(i);
      for (const [id, seconds] of Object.entries(stats[key] ?? {})) {
        if (only && id !== only.id) continue;
        const t = (totals[id] ??= { seconds: 0, perDay: {} });
        t.seconds += seconds;
        t.perDay[key] = Math.round(seconds / 60);
      }
    }
    const spaces = Object.entries(totals)
      .map(([id, t]) => ({
        id,
        name: nameOf(id),
        minutes: Math.round(t.seconds / 60),
        hours: Math.round((t.seconds / 3600) * 100) / 100,
        ...(by_day ? { per_day: t.perDay } : {}),
      }))
      .filter((s) => s.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes);
    const total = spaces.reduce((n, s) => n + s.minutes, 0);
    const hm = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
    const period = days === 1 ? "today" : `the last ${days} days (${day(days - 1)} to ${day(0)})`;
    const lines = spaces.map((s) => `${s.name}: ${hm(s.minutes)}${by_day ? Object.entries(s.per_day).filter(([, m]) => m > 0).map(([d, m]) => `\n  ${d}  ${hm(m)}`).join("") : ""}`);
    const body = spaces.length ? `${lines.join("\n")}\nTotal: ${hm(total)}` : "No time recorded in that period.";
    return {
      content: [{ type: "text", text: `Time per Space, ${period}:\n${body}` }],
      structuredContent: { days, from: day(days - 1), to: day(0), total_minutes: total, spaces },
    };
  }),
);

server.registerTool(
  "rename_space",
  {
    title: "Rename Space",
    description:
      "Set the name Spacepal shows for a Space in its menu bar, overview and Mission Control, and optionally its icon and colour. " +
      "Replaces the old name; an empty name goes back to \"Desktop N\". Leave name out to change only the icon or colour. The name stays with the Space even if desktops are reordered. " +
      "Reversible: call again with the old values (list_spaces shows name, symbol and color). Fails if the Space does not exist.",
    inputSchema: {
      space: optionalSpaceArg,
      name: z.string().max(60).optional().describe('New name, up to 60 characters. Empty text ("") restores the default "Desktop N". Leave out to keep the name.'),
      symbol: z.string().max(80).optional().describe('SF Symbol name for the icon, e.g. "hammer", "briefcase", "film", "cart". Empty text removes the icon.'),
      color: z.string().regex(/^(#?[0-9a-fA-F]{6})?$/).optional().describe('Colour as #RRGGBB, e.g. "#F59E0B". Empty text removes the colour.'),
    },
    annotations: { title: "Rename Space", ...CHANGE, idempotentHint: true },
  },
  guarded(async ({ space, name, symbol, color }) => {
    if (space !== undefined && !(await findSpace(space))) return fail(`No Space called "${space}".`);
    if (name === undefined && symbol === undefined && color === undefined) return fail("Give a name, a symbol or a color.");
    if (name !== undefined) await send(`rename/${ref(space)}`, { name });
    if (symbol !== undefined || color !== undefined) {
      const query = {};
      if (symbol !== undefined) query.symbol = symbol;
      if (color !== undefined) query.color = color;
      await send(`style/${ref(space)}`, query);
    }
    await settle();
    const parts = [];
    if (name !== undefined) parts.push(name ? `name "${name}"` : "default name");
    if (symbol !== undefined) parts.push(symbol ? `icon ${symbol}` : "no icon");
    if (color !== undefined) parts.push(color ? `colour ${color}` : "no colour");
    return text(`Set ${parts.join(", ")}.`);
  }),
);

server.registerTool(
  "set_space_note",
  {
    title: "Set Space note",
    description:
      "Set the short note that says what a Space is for, e.g. \"Client B invoices\"; list_spaces returns it and Spacepal shows it in its overview. " +
      "Replaces any existing note; empty text removes the note. Reversible by setting the old note again (read it from list_spaces first). " +
      "Fails if the Space does not exist.",
    inputSchema: {
      space: optionalSpaceArg,
      text: z.string().max(500).describe('The note, up to 500 characters. Empty text ("") removes the note.'),
    },
    annotations: { title: "Set Space note", ...CHANGE, idempotentHint: true },
  },
  guarded(async ({ space, text: note }) => {
    if (space !== undefined && !(await findSpace(space))) return fail(`No Space called "${space}".`);
    await send(`note/${ref(space)}`, { text: note });
    return text(note ? "Note saved." : "Note removed.");
  }),
);

server.registerTool(
  "open_overview",
  {
    title: "Open overview",
    description:
      "Show Spacepal's full-screen overview of every Space with live previews, for the user to look at and pick from. " +
      "It is a toggle: calling it while the overview is open closes it. Changes nothing else. " +
      "Needs Spacepal's trial or a license; without one Spacepal shows its license window instead. To get the Space list as data, use list_spaces.",
    inputSchema: {},
    annotations: { title: "Open overview", ...CHANGE },
  },
  guarded(async () => {
    await send("overview");
    return text("Asked Spacepal to open the overview. It opens if the trial is running or Spacepal is licensed; otherwise Spacepal shows its license window.");
  }),
);

server.registerTool(
  "list_profiles",
  {
    title: "List profiles",
    description:
      "List the names of the user's saved Spacepal profiles. A profile is a saved set of Space names, colours, notes and automations, such as \"Work\" and \"Home\". " +
      "Read-only. Use it to get a valid name for apply_profile.",
    inputSchema: {},
    outputSchema: { profiles: z.array(z.string()).describe("Saved profile names") },
    annotations: { title: "List profiles", ...RO },
  },
  guarded(async () => {
    const names = await readProfiles();
    return {
      content: [{ type: "text", text: names.length ? names.join("\n") : "No saved profiles yet." }],
      structuredContent: { profiles: names },
    };
  }),
);

server.registerTool(
  "apply_profile",
  {
    title: "Apply profile",
    description:
      "Switch to one of the user's saved profiles, replacing the names, colours, notes and automations of every Space with the profile's. " +
      "If a profile was active, Spacepal first saves the current set under it, so the user can switch back. If none was active, the current names are not saved anywhere and are lost, so ask the user to save them as a profile first. " +
      "Windows and desktops are not changed. Unlike apply_template, which uses built-in starter names, this uses the user's own saved sets. " +
      "Get valid names from list_profiles; fails with the list of names if the profile does not exist. Ask the user first.",
    inputSchema: {
      name: z.string().min(1).describe("Profile name from list_profiles. Matching ignores case."),
    },
    annotations: { title: "Apply profile", ...CHANGE, destructiveHint: true, idempotentHint: true },
  },
  guarded(async ({ name }) => {
    const names = await readProfiles();
    const match = names.find((n) => n.toLowerCase() === name.toLowerCase());
    if (!match) {
      return fail(names.length ? `No profile called "${name}". Profiles: ${names.join(", ")}.` : "No saved profiles yet. Save one in Spacepal Settings, Profiles.");
    }
    await send(`profile/${encodeURIComponent(match)}`);
    return text(`Applied profile "${match}".`);
  }),
);

server.registerTool(
  "apply_template",
  {
    title: "Apply template",
    description:
      `Name and colour the user's desktops from one of Spacepal's built-in starter templates: ${TEMPLATES.join(", ")}. ` +
      "Overwrites the names, colours and notes of the desktops it covers, so ask the user first; to keep the current names they can save them as a profile in Spacepal. " +
      "If the template needs more desktops than exist, Spacepal shows a dialog on screen asking the user whether to add them. " +
      "For the user's own saved sets use apply_profile instead.",
    inputSchema: { name: z.enum(TEMPLATES).describe("Template name, exactly as listed") },
    annotations: { title: "Apply template", ...CHANGE, destructiveHint: true, idempotentHint: true },
  },
  guarded(async ({ name }) => {
    await send(`template/${encodeURIComponent(name)}`);
    await settle();
    return text(`Applied the ${name} template.`);
  }),
);

server.registerTool(
  "set_up_space",
  {
    title: "Set up Space",
    description:
      "Switch to a Space and open the apps, URLs and files its Spacepal automation lists, even if they were opened before. " +
      "Entering the Space also runs its usual on-enter actions, such as a Shortcut. Use it to prepare a workspace; to only change the visible Space use switch_space. " +
      "Opens apps on the user's Mac, so it cannot be undone automatically. Does nothing beyond switching if the Space has no automation. Fails if the Space does not exist.",
    inputSchema: { space: optionalSpaceArg },
    annotations: { title: "Set up Space", ...CHANGE },
  },
  guarded(async ({ space }) => {
    const target = space === undefined ? null : await findSpace(space);
    if (space !== undefined && !target) return fail(`No Space called "${space}".`);
    await send(`setup/${ref(space)}`);
    return text(`Setting up ${target?.name ?? "the current Space"}.`);
  }),
);

server.registerTool(
  "save_window_layout",
  {
    title: "Save window layout",
    description:
      "Record which Space and screen position every open window has, for the current display setup, so restore_window_layout can put them back. " +
      "Overwrites the previous manual save for these displays (Spacepal also saves automatically in the background). Moves nothing.",
    inputSchema: {},
    annotations: { title: "Save window layout", ...CHANGE, idempotentHint: true },
  },
  guarded(async () => {
    await send("save-layout");
    return text("Saved the window layout.");
  }),
);

server.registerTool(
  "restore_window_layout",
  {
    title: "Restore window layout",
    description:
      "Move open windows back to the Spaces and positions recorded by save_window_layout (or Spacepal's automatic save) for the current display setup. " +
      "Moving windows between Spaces only works on macOS 14.0-14.4 and 26.4+; on other versions positions are restored but windows stay on their Space. " +
      "Windows of apps that are not open are skipped; to reopen terminals and Chrome windows use restore_sessions. Spacepal shows how many windows it moved.",
    inputSchema: {},
    annotations: { title: "Restore window layout", ...CHANGE, idempotentHint: true },
  },
  guarded(async () => {
    await send("restore-layout");
    return text("Asked Spacepal to restore the saved layout. It shows how many windows it moved.");
  }),
);

server.registerTool(
  "save_sessions",
  {
    title: "Save sessions",
    description:
      "Save the terminal windows (with their folders) and Chrome windows (with their tabs) on one Space, or on every Space with all=true, " +
      "so restore_sessions can reopen them on the right Space after a restart. Replaces the earlier save for those Spaces and drops windows that were closed. " +
      "Needs Spacepal's trial or a license; without one nothing is saved.",
    inputSchema: {
      space: optionalSpaceArg,
      all: z.boolean().optional().describe("true to save every Space; then space is ignored. Default false."),
    },
    annotations: { title: "Save sessions", ...CHANGE, idempotentHint: true },
  },
  guarded(async ({ space, all }) => {
    if (all) {
      await send("session-save/all");
      return text("Asked Spacepal to save sessions on every Space. It shows how many windows it saved.");
    }
    if (space !== undefined && !(await findSpace(space))) return fail(`No Space called "${space}".`);
    await send(`session-save/${ref(space)}`);
    return text("Asked Spacepal to save the sessions. It shows how many windows it saved.");
  }),
);

server.registerTool(
  "restore_sessions",
  {
    title: "Restore sessions",
    description:
      "Reopen the terminal and Chrome windows saved by save_sessions, each on the Space it was saved from. " +
      "Opens new windows, so calling it twice can open duplicates. Needs Spacepal's trial or a license. " +
      "To move windows that are already open, use restore_window_layout instead.",
    inputSchema: {},
    annotations: { title: "Restore sessions", ...CHANGE },
  },
  guarded(async () => {
    await send("session-restore");
    return text("Asked Spacepal to reopen the saved sessions.");
  }),
);

server.registerTool(
  "place_window",
  {
    title: "Place window",
    description:
      "Resize and move the user's frontmost window on its current display: a half, a quarter, maximized or centred; " +
      'or, with "next-display", move it to the next display. It stays on the same Space. ' +
      "The frontmost window is the one the user last focused (from Claude Desktop that is Claude's own window). " +
      "Needs the Accessibility permission Spacepal already asks for. Not undoable as one step; place it again to change it. " +
      "Use move_window_to_space to send a window to another Space instead. Needs Spacepal 1.2.8 or later.",
    inputSchema: {
      position: z
        .enum(["left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right", "maximize", "center", "next-display"])
        .describe('Where the window goes: a half ("left", "right", "top", "bottom"), a quarter ("top-left" etc.), "maximize", "center", or "next-display".'),
    },
    annotations: { title: "Place window", ...CHANGE, idempotentHint: true },
  },
  guarded(async ({ position }) => {
    if (position === "next-display") await send("next-display");
    else await send(`snap/${position}`);
    return text(`Asked Spacepal to place the front window: ${position}.`);
  }),
);

server.registerTool(
  "set_presentation_mode",
  {
    title: "Set presentation mode",
    description:
      "Turn Spacepal's presentation mode on or off. While it is on, Spacepal shows \"Desktop N\" instead of Space names and hides notes, " +
      "badges and window previews in its overview, menu bar and Mission Control, so a screen share shows nothing private. " +
      "Names and notes are kept and come back when it is turned off; list_spaces still returns the real names. Reversible by calling it again. Needs Spacepal 1.2.8 or later.",
    inputSchema: {
      on: z.boolean().describe("true hides names, notes and previews; false shows them again."),
    },
    annotations: { title: "Set presentation mode", ...CHANGE, idempotentHint: true },
  },
  guarded(async ({ on }) => {
    await send(`presentation/${on ? "on" : "off"}`);
    return text(on ? "Presentation mode on: names, notes and previews hidden." : "Presentation mode off.");
  }),
);

server.registerTool(
  "add_desktop",
  {
    title: "Add desktop",
    description:
      "Create a new empty desktop at the end of the display the pointer is on. Mission Control opens for a moment while Spacepal adds it. " +
      "Undo with remove_desktop. Returns the new number of Spaces once Spacepal confirms it.",
    inputSchema: {},
    annotations: { title: "Add desktop", ...CHANGE },
  },
  guarded(async () => {
    const before = (await readState())?.spaces.length ?? 0;
    await send("add-desktop");
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 250));
      const after = (await readState())?.spaces.length ?? 0;
      if (after > before) return text(`Added a desktop. ${after} Spaces now.`);
    }
    return text("Asked Spacepal to add a desktop; it has not confirmed it yet.");
  }),
);

server.registerTool(
  "remove_desktop",
  {
    title: "Remove desktop",
    description:
      "Close a desktop, as with its close button in Mission Control. Its windows move to another desktop and are not closed, " +
      "but its Spacepal name, note and automation are lost and cannot be restored automatically. Full-screen Spaces cannot be removed this way. " +
      "Always ask the user before calling this. Fails if the Space does not exist.",
    inputSchema: { space: spaceArg.describe("Desktop number or name from list_spaces") },
    annotations: { title: "Remove desktop", ...CHANGE, destructiveHint: true },
  },
  guarded(async ({ space }) => {
    const target = await findSpace(space);
    if (!target) return fail(`No Space called "${space}". Call list_spaces to see the names.`);
    if (target.isFullscreen) return fail(`${target.name} is a full-screen Space. Leave full screen in that app instead.`);
    const before = (await readState())?.spaces.length ?? 0;
    await send(`remove-desktop/${ref(space)}`);
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 250));
      const after = (await readState())?.spaces.length ?? 0;
      if (after < before) return text(`Removed ${target.name}. ${after} Spaces now.`);
    }
    return text(`Asked Spacepal to remove ${target.name}; it has not confirmed it yet.`);
  }),
);

async function readTidy() {
  const path = await newestFile(TIDY_FILES);
  return path ? JSON.parse(await readFile(path, "utf8")) : null;
}

// Asks Spacepal for a fresh scan and waits until tidy.json is rewritten.
async function freshTidy(timeoutMs = 6000) {
  const before = (await readTidy())?.updatedAt;
  await send("tidy/scan");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    const t = await readTidy();
    if (t && t.updatedAt !== before) return t;
  }
  return await readTidy();
}

const NO_TIDY =
  "Spacepal has not written a tidy report. Tidy Up is in the direct version of Spacepal (getspacepal.com), needs permission to control Google Chrome (System Settings > Privacy & Security > Automation), and Chrome must be running.";

server.registerTool(
  "tidy_report",
  {
    title: "Tidy report: browser tabs per Space",
    description:
      "Scan now and list every Google Chrome window: the Space it is on, its tabs (addresses without query strings), and what each Space is for (name, project folder, repositories, dev server ports). " +
      "Also returns Spacepal's own suggestions: windows and tabs that clearly belong on another Space, with the reason. " +
      "Use it to decide what to move with tidy_up, move_tab or move_browser_window, or to bring a project's tabs to the Space the user is on. Changes nothing.",
    inputSchema: {},
    annotations: { title: "Tidy report", ...RO, idempotentHint: false },
  },
  guarded(async () => {
    const t = await freshTidy();
    if (!t) return fail(NO_TIDY);
    const lines = [`Scanned ${t.updatedAt}. Browser: ${t.browser}.`, "", "Spaces:"];
    for (const s of t.spaces ?? []) {
      const bits = [s.folder && `folder ${s.folder}`, s.repos?.length && `repos ${s.repos.join(", ")}`, s.ports?.length && `ports ${s.ports.join(", ")}`].filter(Boolean);
      lines.push(`- ${s.number ?? "?"} ${s.name}${s.isActive ? " (current)" : ""}${bits.length ? ": " + bits.join("; ") : ""}`);
    }
    lines.push("", "Windows:");
    for (const w of t.windows ?? []) {
      lines.push(`- window ${w.id} on ${w.spaceNumber ?? "?"} ${w.space ?? "?"}: "${w.title}"`);
      for (const u of w.tabs) lines.push(`    ${u}`);
    }
    const sw = t.suggestions?.windows ?? [], st = t.suggestions?.tabs ?? [];
    lines.push("", `Spacepal suggests: ${sw.length} windows, ${st.length} tabs.`);
    for (const w of sw) lines.push(`- window ${w.id} "${w.title}" on ${w.space} -> ${w.to} (${w.reason})`);
    for (const x of st) lines.push(`- tab ${x.url} on ${x.space} -> ${x.to} (${x.reason})`);
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: t };
  }),
);

server.registerTool(
  "tidy_up",
  {
    title: "Apply Tidy Up's suggestions",
    description:
      "Move every window and tab that Spacepal's tidy_report suggests to the Space it belongs on. Tabs go into a Chrome window on that Space (a new one if it has none) and keep their history. " +
      "Only Spacepal's own rule-based suggestions; to move other tabs use move_tab.",
    inputSchema: {},
    annotations: { title: "Tidy up", ...CHANGE },
  },
  guarded(async () => {
    const before = await freshTidy();
    if (!before) return fail(NO_TIDY);
    const n = (before.suggestions?.windows?.length ?? 0) + (before.suggestions?.tabs?.length ?? 0);
    if (!n) return text("Nothing to tidy: every window and tab Spacepal can place is on its Space.");
    await send("tidy");
    await new Promise((r) => setTimeout(r, 2500));
    const after = await freshTidy();
    const left = (after?.suggestions?.windows?.length ?? 0) + (after?.suggestions?.tabs?.length ?? 0);
    return text(`Moved ${n - left} of ${n}.${left ? ` ${left} could not be moved; see tidy_report.` : ""}`);
  }),
);

server.registerTool(
  "move_tab",
  {
    title: "Move a browser tab to a Space",
    description:
      "Move one Chrome tab, found by its address from tidy_report, into a Chrome window on another Space (a new window there if it has none). The tab keeps its history. " +
      "Leave space out to bring the tab to the Space the user is on now. The address may be the start of the tab's address.",
    inputSchema: {
      url: z.string().url().describe("The tab's address as tidy_report lists it"),
      space: optionalSpaceArg,
    },
    annotations: { title: "Move tab", ...CHANGE },
  },
  guarded(async ({ url, space }) => {
    const q = { url };
    if (space !== undefined && space !== null && space !== "") q.space = String(space);
    // The same address is often open on more than one desktop: count where its copies are, before and after.
    const where = (t) => (t?.windows ?? []).filter((w) => w.tabs.some((u) => u.startsWith(url)))
      .map((w) => ({ id: w.id, label: `${w.spaceNumber ?? "?"} ${w.space}`, n: w.tabs.filter((u) => u.startsWith(url)).length }));
    const before = where(await freshTidy());
    await send("move-tab", q);
    await new Promise((r) => setTimeout(r, 1500));
    const after = where(await freshTidy());
    const moved = after.find((a) => a.n > (before.find((b) => b.id === a.id)?.n ?? 0));
    const list = after.map((a) => `window ${a.id} on ${a.label}${a.n > 1 ? ` (${a.n} tabs)` : ""}`).join("; ");
    if (moved) return text(`Moved: the tab is now in window ${moved.id} on ${moved.label}.${after.length > 1 ? ` Copies of that address: ${list}.` : ""}`);
    if (!before.length) return text("No open tab shows that address; check it with tidy_report.");
    const target = space === undefined || space === null || space === "" ? null : String(space).toLowerCase();
    const allThere = target && after.every((a) => a.label.toLowerCase().split(" ").includes(target) || a.label.toLowerCase().endsWith(target));
    return text(allThere ? `Already there: ${list}.` : `Not moved: Spacepal could not move it. Tabs with that address: ${list}.`);
  }),
);

server.registerTool(
  "move_browser_window",
  {
    title: "Move a browser window to a Space",
    description:
      "Move a whole Chrome window, by its id from tidy_report, to another Space without switching there. Leave space out to bring it to the Space the user is on now.",
    inputSchema: {
      id: z.string().min(1).describe("The window id from tidy_report"),
      space: optionalSpaceArg,
    },
    annotations: { title: "Move browser window", ...CHANGE },
  },
  guarded(async ({ id, space }) => {
    const q = { id };
    if (space !== undefined && space !== null && space !== "") q.space = String(space);
    await send("move-browser-window", q);
    await new Promise((r) => setTimeout(r, 1500));
    const w = (await freshTidy())?.windows?.find((w) => w.id === id);
    return text(w ? `Window ${id} is on ${w.spaceNumber ?? "?"} ${w.space}.` : "Asked Spacepal to move the window.");
  }),
);

async function freshTidyAll(timeoutMs = 6000) {
  const read = async () => { const p = await newestFile(TIDY_ALL_FILES); return p ? JSON.parse(await readFile(p, "utf8")) : null; };
  const before = (await read())?.updatedAt;
  await send("tidy/all-report");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    const t = await read();
    if (t && t.updatedAt !== before) return t;
  }
  return null;
}

const NOT_PRO = "Tidying every desktop is part of Spacepal Pro. Spacepal opened its Pro offer; Pro is on free for the first 14 days.";

server.registerTool(
  "tidy_all_report",
  {
    title: "Every app window on every desktop",
    description:
      "Global Tidy (Spacepal Pro, direct version): list every app window on every desktop with its id, app, title and desktop, what each desktop is for (name, note, project folder), and Spacepal's rule-based hints (suggest: a desktop the title names; fits: leave it). " +
      "Chrome tabs are not in this list; use tidy_report for them. To tidy everything: call this and tidy_report, decide which desktop each window and tab belongs on, put anything that belongs to no desktop on the desktop called \"Inbox\" (move_app_window makes it when missing), show the user the plan, and only then move with move_app_window, move_tab and move_browser_window. Leave terminals and windows marked fits where they are. Changes nothing.",
    inputSchema: {},
    annotations: { title: "Tidy all report", ...RO, idempotentHint: false },
  },
  guarded(async () => {
    if (!(await isRunning())) return fail(await notRunning());
    const t = await freshTidyAll();
    if (!t) return fail("Spacepal did not answer. Global Tidy is in the direct version of Spacepal 1.2.18 and later (getspacepal.com).");
    if (!t.pro) return fail(NOT_PRO);
    const lines = [`Scanned ${t.updatedAt}.${t.movesBackgroundWindows ? "" : " On this macOS only the front window can be moved; other app windows stay where they are."}`, "", "Desktops:"];
    for (const s of t.spaces ?? []) lines.push(`- ${s.number ?? "?"} ${s.name}${s.isActive ? " (current)" : ""}${s.folder ? `: folder ${s.folder}` : ""}${s.note ? ` (note: ${s.note})` : ""}`);
    lines.push("", "App windows:");
    for (const w of t.windows ?? []) lines.push(`- ${w.id} ${w.app}: "${w.title}" on ${w.space}${w.suggest ? ` -> suggest ${w.suggest} (${w.reason})` : w.fits ? " (fits, leave it)" : ""}`);
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: t };
  }),
);

server.registerTool(
  "move_app_window",
  {
    title: "Move an app window to a desktop",
    description:
      "Global Tidy (Spacepal Pro): move one app window, by its id from tidy_all_report, to a desktop by name without switching there. Use \"Inbox\" for things that belong to no desktop; Spacepal adds and names that desktop when it is missing. The user can undo it from the menu for five minutes.",
    inputSchema: {
      id: z.number().int().positive().describe("The window id from tidy_all_report"),
      space: z.string().min(1).describe('The desktop name, e.g. "API" or "Inbox"'),
    },
    annotations: { title: "Move app window", ...CHANGE },
  },
  guarded(async ({ id, space }) => {
    if (!(await isRunning())) return fail(await notRunning());
    await send("move-app-window", { id: String(id), space: String(space) });
    await new Promise((r) => setTimeout(r, 1500));
    const t = await freshTidyAll();
    if (t && !t.pro) return fail(NOT_PRO);
    const w = t?.windows?.find((w) => w.id === id);
    return text(w ? `Window ${id} (${w.app}) is on ${w.space}.` : "Asked Spacepal to move the window.");
  }),
);

await server.connect(new StdioServerTransport());
