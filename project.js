// Reads a project folder and works out what a Spacepal desktop for it should look like: a name, a one-line
// description for the note, an SF Symbol, a brand colour (from the logo or the web manifest), the logo file,
// the dev server, the git remote and branch, and open tasks from TODO/ROADMAP files. Read-only, local only.
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SKIP = new Set(["node_modules", ".git", "build", "dist", ".build", "DerivedData", ".next", ".venv", "venv", "vendor", "Pods", "target", ".wrangler", "coverage", ".cache", "out"]);

async function read(path, max = 200_000) {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > max) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
const json = async (path) => {
  const t = await read(path);
  try { return t ? JSON.parse(t) : null; } catch { return null; }
};

// Files up to `depth` folders down, skipping build output and dependencies.
async function walk(dir, depth, out = [], root = dir) {
  if (out.length > 4000) return out;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !SKIP.has(e.name)) await walk(p, depth - 1, out, root); }
    else out.push(relative(root, p));
  }
  return out;
}

// ---- colour ----
const hex6 = (h) => {
  h = h.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/i.test(h) ? "#" + h.toUpperCase() : null;
};
function rgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
// A brand colour has some saturation and is neither near-white nor near-black.
function brandish(h) {
  const [r, g, b] = rgb(h), max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2 / 255, s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
  return l > 0.12 && l < 0.88 && s > 0.25;
}
function topColour(text) {
  const counts = new Map();
  for (const m of text.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const h = hex6(m[0]);
    if (h && brandish(h)) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  for (const m of text.matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/g)) {
    const h = "#" + [m[1], m[2], m[3]].map((v) => Math.min(255, +v).toString(16).padStart(2, "0")).join("").toUpperCase();
    if (brandish(h)) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ---- logo ----
function logoRank(f) {
  const n = basename(f).toLowerCase(), ext = extname(n);
  if (![".svg", ".png", ".icns", ".jpg", ".webp", ".ico"].includes(ext)) return -1;
  if (/test|fixture|example|screenshot|node_modules/i.test(f)) return -1;
  let r = 0;
  if (/^logo|[-_.]logo\b|brand/.test(n)) r += 6;
  else if (/^app-?icon|^icon[-_.]?(512|1024|256)?\.|apple-touch-icon|^icon\./.test(n)) r += 4;
  else if (/^favicon/.test(n)) r += 2;
  else if (/appicon\.appiconset/i.test(f)) r += 3;
  else return -1;
  if (ext === ".svg") r += 2;
  r -= f.split("/").length * 0.3;
  return r;
}

// ---- symbol ----
const SYMBOLS = [
  [/\b(godot|unity|phaser|pixi|three\.js|threejs|game|bevy)\b/i, "gamecontroller"],
  [/\b(react-native|expo|ios app|iphone|android)\b/i, "iphone"],
  [/\b(mcp|llm|openai|anthropic|claude|ai agent|agents?)\b/i, "sparkles"],
  [/\b(stripe|shop|store|checkout|commerce|cart)\b/i, "cart"],
  [/\b(email|mail|newsletter|smtp)\b/i, "envelope"],
  [/\b(time ?track\w*|timesheets?|hours|focus|pomodoro|planning|planner|calendar)\b/i, "clock"],
  [/\b(todo|tasks?|kanban|issues)\b/i, "checklist"],
  [/\b(invoice|billing|accounting|finance)\b/i, "doc.text"],
  [/\b(docs?|documentation|blog|book|guide)\b/i, "book"],
  [/\b(design|figma|ui kit|brand)\b/i, "paintbrush"],
  [/\b(video|stream|youtube|obs|film)\b/i, "play.rectangle"],
  [/\b(music|audio|sound|podcast)\b/i, "music.note"],
  [/\b(analytics|dashboard|metrics|chart)\b/i, "chart.bar"],
  [/\b(database|postgres|sqlite|d1|sql)\b/i, "cylinder"],
  [/\b(cli|command[- ]line|terminal)\b/i, "terminal"],
  [/\b(api|server|backend|worker|hono|express|fastapi|django|rails)\b/i, "server.rack"],
  [/\b(next|vite|astro|svelte|website|landing|site|web)\b/i, "globe"],
];

// ---- dev server ----
const DEFAULT_PORT = { next: 3000, "react-scripts": 3000, vite: 5173, astro: 4321, "svelte-kit": 5173, nuxt: 3000, remix: 3000, gatsby: 8000, wrangler: 8787, "webpack-dev-server": 8080, expo: 8081 };
function devServer(pkg) {
  const scripts = pkg?.scripts ?? {};
  const name = ["dev", "start", "serve", "develop"].find((k) => scripts[k]);
  if (!name) return null;
  const cmd = scripts[name];
  const port = +(cmd.match(/(?:--port[ =]|-p\s+|PORT=)(\d{2,5})/)?.[1] ?? 0) || Object.entries(DEFAULT_PORT).find(([k]) => cmd.includes(k))?.[1];
  return { command: `npm run ${name}`, url: port ? `http://localhost:${port}` : null };
}

export async function inspectProject(folder) {
  const s = await stat(folder).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`No folder at ${folder}.`);
  const files = await walk(folder, 3);
  const has = (f) => files.includes(f);
  const pkg = await json(join(folder, "package.json"));
  const readmeFile = files.find((f) => /^readme(\.md|\.txt)?$/i.test(f));
  const readme = readmeFile ? (await read(join(folder, readmeFile))) ?? "" : "";

  // Name and description.
  let name = basename(folder), description = null;
  const readmeTitle = readme.match(/^#\s+(.+)$/m)?.[1]?.replace(/[*_`]/g, "").trim();
  if (pkg?.description) description = pkg.description;
  if (!description && readme) {
    const para = readme.replace(/^#.*$/gm, "").replace(/<[^>]+>/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 30 && !/^[|>`\-*[]/.test(p));
    if (para) description = para.replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").slice(0, 200);
  }
  const displayName = readmeTitle && readmeTitle.length <= 40 ? readmeTitle : name;

  // Stack, for the symbol.
  const stack = [];
  if (has("Package.swift") || files.some((f) => f.endsWith(".xcodeproj/project.pbxproj"))) stack.push("swift");
  if (pkg) stack.push("node", ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /^(next|react|vite|astro|svelte|hono|express|wrangler|expo|react-native|three|phaser|stripe|@modelcontextprotocol\/sdk|electron)$/.test(d)));
  if (has("pyproject.toml") || has("requirements.txt")) stack.push("python");
  if (has("Cargo.toml")) stack.push("rust");
  if (has("go.mod")) stack.push("go");
  if (files.some((f) => f.endsWith("project.godot"))) stack.push("godot");
  if (has("wrangler.toml") || has("wrangler.jsonc") || has("wrangler.json")) stack.push("cloudflare-worker");
  const words = [name, displayName, description ?? "", (pkg?.keywords ?? []).join(" "), stack.join(" ")].join(" ").replace(/[-_]/g, " ");
  let symbol = SYMBOLS.find(([re]) => re.test(words))?.[1] ?? null;
  if (!symbol && stack.includes("swift")) symbol = "swift";
  if (!symbol && stack.includes("electron")) symbol = "macwindow";
  symbol ??= "folder";

  // Logo.
  const logo = files.map((f) => [f, logoRank(f)]).filter(([, r]) => r >= 0).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Colour: the web manifest's theme colour, a theme-color meta tag, then the logo's main colour, then CSS brand variables.
  let color = null, colorFrom = null;
  for (const f of files.filter((f) => /(^|\/)(site\.webmanifest|manifest\.json|manifest\.webmanifest)$/.test(f))) {
    const m = await json(join(folder, f));
    const h = m && hex6(String(m.theme_color ?? "")); if (h && brandish(h)) { color = h; colorFrom = f; break; }
  }
  if (!color) for (const f of files.filter((f) => /(^|\/)index\.html$/.test(f)).slice(0, 5)) {
    const t = await read(join(folder, f));
    const h = t?.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,6})/)?.[1];
    if (h && brandish(hex6(h))) { color = hex6(h); colorFrom = f; break; }
  }
  if (!color && logo?.endsWith(".svg")) {
    const h = topColour((await read(join(folder, logo))) ?? "");
    if (h) { color = h; colorFrom = logo; }
  }
  if (!color) for (const f of files.filter((f) => /tailwind\.config\.(js|ts|cjs|mjs)$|(^|\/)(globals?|main|app|styles?|theme|page)\.css$/.test(f)).slice(0, 8)) {
    const t = (await read(join(folder, f))) ?? "";
    const line = t.split("\n").filter((l) => /(--(accent|primary|brand)\b|\b(primary|brand|accent)\s*:)/i.test(l)).join("\n");
    const h = topColour(line);
    if (h) { color = h; colorFrom = f; break; }
  }

  // Git.
  let git = null;
  try {
    const opt = { cwd: folder, timeout: 3000 };
    const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], opt)).stdout.trim();
    const remote = (await run("git", ["remote", "get-url", "origin"], opt).catch(() => ({ stdout: "" }))).stdout.trim();
    git = { branch, remote: remote ? remote.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "") : null };
  } catch {}

  // Open tasks: unchecked boxes in TODO/ROADMAP files at the top level.
  const taskFiles = files.filter((f) => !f.includes("/") && /^(todo|roadmap|tasks|plan)(\.md|\.txt)?$/i.test(f));
  const tasks = [];
  for (const f of taskFiles) {
    for (const m of ((await read(join(folder, f))) ?? "").matchAll(/^\s*[-*]\s+\[ \]\s+(.+)$/gm)) {
      if (tasks.length < 10) tasks.push({ text: m[1].trim().slice(0, 140), file: f });
    }
  }

  return {
    folder,
    name: displayName,
    description,
    stack: [...new Set(stack)],
    symbol,
    color,
    color_from: colorFrom,
    logo: logo ? join(folder, logo) : null,
    dev: devServer(pkg),
    git,
    readme: readmeFile ? join(folder, readmeFile) : null,
    task_files: taskFiles.map((f) => join(folder, f)),
    tasks,
  };
}
