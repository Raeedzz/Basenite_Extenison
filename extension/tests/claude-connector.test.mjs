/**
 * The Connect Claude download, installed and launched the way Claude does it:
 * unzip, run the manifest's command, talk MCP on stdio.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { buildConnector } from "../lib/claude-connector.js";

const SCRIPT = readFileSync(new URL("../mcp/basanite-mcp.mjs", import.meta.url), "utf8");
const ICON = readFileSync(new URL("../icons/icon-128.png", import.meta.url));
const ID = "abcdefghijklmnopabcdefghijklmnop";

function install(options) {
  const dir = mkdtempSync(join(tmpdir(), "basanite-mcpb-"));
  writeFileSync(join(dir, "basanite.mcpb"), buildConnector({ script: SCRIPT, icon: ICON, extensionId: ID, version: "1.2.3", ...options }));
  execFileSync("unzip", ["-q", "basanite.mcpb", "-d", "installed"], { cwd: dir });
  const root = join(dir, "installed");
  return { root, manifest: JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) };
}

test("the connector unzips to the server, byte for byte, with this extension's id", () => {
  const { root, manifest } = install();
  assert.equal(readFileSync(join(root, manifest.server.entry_point), "utf8"), SCRIPT);
  assert.deepEqual(readFileSync(join(root, "icon.png")), ICON);
  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.server.type, "node");
  assert.deepEqual(manifest.server.mcp_config.env, { BASANITE_EXTENSION_ID: ID });
  assert.equal(install({ port: 18000 }).manifest.server.mcp_config.env.BASANITE_MCP_PORT, "18000");
  assert.equal(install({ secret: "s3cr3t" }).manifest.server.mcp_config.env.BASANITE_SECRET, "s3cr3t", "the connector carries the bridge secret");
  assert.equal(install({ version: "1.1" }).manifest.version, "1.1.0", "Chrome's short versions become semver");
  assert.equal(install({ version: "1.2.3.4" }).manifest.version, "1.2.3");
});

test("Claude can launch it from the manifest and list its tools", async () => {
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
  });
  const { root, manifest } = install({ port });
  const { command, args, env } = manifest.server.mcp_config;
  assert.equal(command, "node");
  const child = spawn(process.execPath, args.map((arg) => arg.replace("${__dirname}", root)),
    { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const rpc = async (id, method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return JSON.parse((await lines.next()).value);
    };
    const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "0" } });
    assert.equal(init.result.serverInfo.name, "basanite");
    const { result } = await rpc(2, "tools/list", {});
    assert.ok(result.tools.some((tool) => tool.name === "enrich_table"));
  } finally {
    child.kill();
  }
});
