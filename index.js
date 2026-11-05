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
const VERSION = "0.1.0";

// Direct build writes to Application Support; the App Store build is sandboxed.
const STATE_FILES = [
  join(homedir(), "Library/Application Support/Spacepal/state.json"),
  join(homedir(), "Library/Containers/com.halberd.spacepal/Data/Library/Application Support/Spacepal/state.json"),
];

const NOT_RUNNING = "Spacepal is not running. Open Spacepal (getspacepal.com) and try again.";

async function isRunning() {
  try {
    await run("/usr/bin/pgrep", ["-x", "Spacepal"]);
    return true;
  } catch {
    return false;
  }
}

async function readState() {
  let newest = null;
  for (const path of STATE_FILES) {
    try {
      const { mtimeMs } = await stat(path);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
    } catch {}
  }
  if (!newest) return null;
  return JSON.parse(await readFile(newest.path, "utf8"));
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
    description: "List every macOS Space (desktop) with its number, name, display, apps and which one is active.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  guarded(async () => {
    if (!(await isRunning())) return fail(NOT_RUNNING);
    const state = await readState();
    if (!state) return fail("Spacepal has not written its Space list yet. Open the Spacepal menu once and try again.");
    const lines = state.spaces.map((s) => {
      const label = s.isFullscreen ? "full screen" : `Desktop ${s.number ?? "?"}`;
      const apps = s.apps?.length ? ` — ${s.apps.join(", ")}` : "";
      return `${s.isActive ? "*" : " "} ${label}: ${s.name}${apps}`;
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
    annotations: { readOnlyHint: true },
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
      "Note: moving windows needs macOS 14.0-14.4 or 26.4+, a macOS limit.",
    inputSchema: { space: spaceArg },
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
  },
  guarded(async () => {
    await send("overview");
    return text("Overview opened.");
  }),
);

server.registerTool(
  "set_space_note",
  {
    title: "Set Space note",
    description: "Attach a short note to a Space (what it is for).",
    inputSchema: { space: spaceArg.optional(), text: z.string().max(500) },
  },
  guarded(async ({ space, text: note }) => {
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
  },
  guarded(async ({ name }) => {
    await send(`profile/${encodeURIComponent(name)}`);
    return text(`Applied profile "${name}".`);
  }),
);

await server.connect(new StdioServerTransport());
