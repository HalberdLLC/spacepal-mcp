// Starts the server over stdio and checks the tool list and schemas. Needs no Spacepal,
// so it runs on any OS (the tools themselves only work on a Mac with Spacepal running).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("../index.js", import.meta.url));
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));

const { tools } = await client.listTools();
assert.equal(tools.length, 19, "expected 19 tools");
assert.ok(client.getInstructions()?.length > 100, "server instructions are missing");
for (const tool of tools) {
  assert.ok(tool.description?.length >= 80, `${tool.name}: description too short`);
  const a = tool.annotations ?? {};
  for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    assert.equal(typeof a[hint], "boolean", `${tool.name}: ${hint} missing`);
  }
  for (const [name, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
    assert.ok(prop.description, `${tool.name}.${name}: parameter has no description`);
  }
}
const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name).sort();
assert.deepEqual(readOnly, ["current_space", "list_profiles", "list_spaces"]);

await client.close();
console.log(`ok: ${tools.length} tools`);
