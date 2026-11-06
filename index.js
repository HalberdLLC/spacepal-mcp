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

const run = promisify(execFile);
const VERSION = "0.3.0";

// Direct build writes to Application Support; the App Store build is sandboxed.
const SUPPORT_DIRS = [
  join(homedir(), "Library/Application Support/Spacepal"),
  join(homedir(), "Library/Containers/com.halberd.spacepal/Data/Library/Application Support/Spacepal"),
];
const STATE_FILES = SUPPORT_DIRS.map((d) => join(d, "state.json"));
const PROFILE_FILES = SUPPORT_DIRS.map((d) => join(d, "profiles.json"));
// Built into the app (Profiles.swift, SpaceTemplate.all()).
const TEMPLATES = ["Developer", "Designer", "Freelancer", "Student", "Streamer"];

const NOT_RUNNING = "Spacepal is not running. Open Spacepal (getspacepal.com) and try again.";

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
  if (!(await isRunning())) throw new Error(NOT_RUNNING);
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

Tools that only read: list_spaces, current_space, list_profiles. Tools that change the user's screen or setup: everything else. Ask the user before remove_desktop, apply_template and apply_profile, which replace or remove things; rename_space and set_space_note are easy to undo by calling them again.

Every action goes through Spacepal, so it must be running (macOS 14 or later). Nothing is sent over the network. If a tool says Spacepal is not running, tell the user to open it. The overview and sessions need Spacepal's trial or a license; names, notes and switching work in the free version.`;

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
    if (!(await isRunning())) return fail(NOT_RUNNING);
    const state = await readState();
    if (!state) return fail("Spacepal has not written its Space list yet. Open the Spacepal menu once and try again.");
    const lines = state.spaces.map((s) => {
      const label = s.isFullscreen ? "full screen" : `Desktop ${s.number ?? "?"}`;
      const apps = s.apps?.length ? ` — ${s.apps.join(", ")}` : "";
      const note = s.note ? ` (note: ${s.note})` : "";
      return `${s.isActive ? "*" : " "} ${label}: ${s.name}${apps}${note}`;
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
    if (!(await isRunning())) return fail(NOT_RUNNING);
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

server.registerTool(
  "rename_space",
  {
    title: "Rename Space",
    description:
      "Set the name Spacepal shows for a Space in its menu bar, overview and Mission Control. " +
      "Replaces the old name; an empty name goes back to \"Desktop N\". The name stays with the Space even if desktops are reordered. " +
      "Reversible: call again with the old name (get it from list_spaces first). Fails if the Space does not exist.",
    inputSchema: {
      space: optionalSpaceArg,
      name: z.string().max(60).describe('New name, up to 60 characters. Empty text ("") restores the default "Desktop N".'),
    },
    annotations: { title: "Rename Space", ...CHANGE, idempotentHint: true },
  },
  guarded(async ({ space, name }) => {
    if (space !== undefined && !(await findSpace(space))) return fail(`No Space called "${space}".`);
    await send(`rename/${ref(space)}`, { name });
    await settle();
    return text(name ? `Renamed to "${name}".` : "Name reset to default.");
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

await server.connect(new StdioServerTransport());
