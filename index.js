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
const VERSION = "0.2.0";

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

const server = new McpServer({ name: "spacepal", version: VERSION });
const spaceArg = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe("Desktop number (1, 2, ...) or Space name, e.g. \"Mail\".");

server.registerTool(
  "list_spaces",
  {
    title: "List Spaces",
    description: "List every macOS Space (desktop) with its number, name, display, the apps that have windows there, its note, and which one is active.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
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
      structuredContent: state,
    };
  }),
);

server.registerTool(
  "current_space",
  {
    title: "Current Space",
    description: "Name and number of the Space you are on.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guarded(async () => {
    if (!(await isRunning())) return fail(NOT_RUNNING);
    const state = await readState();
    const active = state?.spaces.filter((s) => s.isActive) ?? [];
    if (!active.length) return text(state?.current ? `Current: ${state.current}` : "Unknown");
    return text(active.map((s) => `${s.name} (Desktop ${s.number ?? "full screen"})`).join("\n"));
  }),
);

server.registerTool(
  "switch_space",
  {
    title: "Switch Space",
    description: "Switch to a Space by desktop number or name. Use \"next\", \"previous\" or \"back\" to step.",
    inputSchema: { space: spaceArg },
    annotations: { openWorldHint: false },
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
      "Send the frontmost window to another Space (by number or name, or \"next\"/\"previous\"). " +
      "On macOS 14.0-14.4 and 26.4+ the window moves directly; on other versions Spacepal drags it, " +
      "which takes a moment longer. The frontmost window is usually the one the user worked in last, " +
      "not the MCP client's own window when it runs in a terminal.",
    inputSchema: { space: spaceArg },
    annotations: { openWorldHint: false },
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
    description: "Give a Space a name. Leave space empty for the current one; an empty name restores the default.",
    inputSchema: {
      space: spaceArg.optional(),
      name: z.string().max(60).describe("New name. Empty text restores \"Desktop N\"."),
    },
    annotations: { openWorldHint: false },
  },
  guarded(async ({ space, name }) => {
    if (space !== undefined && !(await findSpace(space))) return fail(`No Space called "${space}".`);
    await send(`rename/${ref(space)}`, { name });
    await settle();
    return text(name ? `Renamed to "${name}".` : "Name reset to default.");
  }),
);

server.registerTool(
  "open_overview",
  {
    title: "Open overview",
    description: "Open Spacepal's overview grid of all Spaces on screen.",
    inputSchema: {},
    annotations: { openWorldHint: false },
  },
  guarded(async () => {
    await send("overview");
    return text("Asked Spacepal to open the overview. It opens if the trial is running or Spacepal is licensed; otherwise Spacepal shows its license window.");
  }),
);

server.registerTool(
  "set_space_note",
  {
    title: "Set Space note",
    description: "Attach a short note to a Space (what it is for).",
    inputSchema: { space: spaceArg.optional(), text: z.string().max(500) },
    annotations: { openWorldHint: false },
  },
  guarded(async ({ space, text: note }) => {
    if (space !== undefined && !(await findSpace(space))) return fail(`No Space called "${space}".`);
    await send(`note/${ref(space)}`, { text: note });
    return text("Note saved.");
  }),
);

server.registerTool(
  "apply_profile",
  {
    title: "Apply profile",
    description: "Apply a saved Spacepal profile by name (names, layouts and rules).",
    inputSchema: { name: z.string().min(1) },
    annotations: { openWorldHint: false },
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
  "list_profiles",
  {
    title: "List profiles",
    description: "Names of the saved Spacepal profiles (sets of Space names, colours, notes and automations).",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guarded(async () => {
    const names = await readProfiles();
    return text(names.length ? names.join("\n") : "No saved profiles yet.");
  }),
);

server.registerTool(
  "apply_template",
  {
    title: "Apply template",
    description:
      `Name and colour the Spaces from a built-in starter template: ${TEMPLATES.join(", ")}. ` +
      "This replaces the current Space names; the user can save them first as a profile.",
    inputSchema: { name: z.enum(TEMPLATES) },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
    description: "Switch to a Space and run its automations now: open its apps, URLs and files, run its Shortcut or script.",
    inputSchema: { space: spaceArg.optional() },
    annotations: { openWorldHint: false },
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
    description: "Save which Space and position every window is in, for this display setup. Replaces the previous manual save.",
    inputSchema: {},
    annotations: { idempotentHint: true, openWorldHint: false },
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
      "Put windows back on the Spaces and positions from the last saved layout for this display setup. " +
      "Moving windows between Spaces needs macOS 14.0-14.4 or 26.4+.",
    inputSchema: {},
    annotations: { openWorldHint: false },
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
      "Save the terminal sessions and Chrome windows on a Space (or on every Space with all=true), " +
      "so Spacepal can reopen them after a restart. Needs the Spacepal trial or a license.",
    inputSchema: {
      space: spaceArg.optional(),
      all: z.boolean().optional().describe("Save every Space instead of one."),
    },
    annotations: { idempotentHint: true, openWorldHint: false },
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
    description: "Reopen the saved terminal sessions and Chrome windows on their Spaces. Needs the Spacepal trial or a license.",
    inputSchema: {},
    annotations: { openWorldHint: false },
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
    description: "Add a new desktop (Space) on the current display.",
    inputSchema: {},
    annotations: { openWorldHint: false },
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
      "Remove a desktop by number or name. Its windows move to another desktop, as when you close it in Mission Control. " +
      "Full-screen Spaces cannot be removed this way. Ask the user before calling this.",
    inputSchema: { space: spaceArg },
    annotations: { destructiveHint: true, openWorldHint: false },
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
