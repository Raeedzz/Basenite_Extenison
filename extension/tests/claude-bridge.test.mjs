/**
 * Claude drives the extension: the real MCP server process, over its
 * WebSocket, into the real worker, against a fake LinkedIn and Airtable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect as dial, createServer } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { bootWorker, EXTENSION_ID } from "./helpers/worker-harness.mjs";
import { BASE_ID, fakeBase } from "./helpers/fake-airtable.mjs";
import { BASANITE_TABLES, PEOPLE } from "./helpers/basanite-base.mjs";

const fieldsLib = await import("../lib/airtable-fields.js");
const linkedLib = await import("../lib/airtable-linked.js");
const sink = await import("../lib/airtable-sink.js");
const bridge = await import("../background/claude-bridge.js");

const SERVER = fileURLToPath(new URL("../mcp/basanite-mcp.mjs", import.meta.url));
const P_LINKEDIN = "fldvyrmtV2q06ip6k";
// The bridge's "is a server up" checks go to the real servers these tests start.
const realFetch = globalThis.fetch;
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const url = (i) => `https://www.linkedin.com/in/person-${i}`;

function profile(i) {
  return {
    entityUrn: `urn:li:fsd_profile:ACoAA${i}`, publicIdentifier: `person-${i}`, firstName: "Person", lastName: String(i), headline: "h",
    profilePositionGroups: { elements: [{ companyName: "Co 1", company: { entityUrn: "urn:li:fsd_company:1", name: "Co 1" },
      profilePositionInPositionGroup: { elements: [{ title: "T", companyName: "Co 1", companyUrn: "urn:li:fsd_company:1", timePeriod: { startDate: { year: 2020 } } }] } }] },
    profileEducations: { elements: [] },
  };
}

const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/** The MCP server as Claude Code runs it: a child speaking JSON-RPC on stdio. */
function startServer(port) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, BASANITE_MCP_PORT: String(port), BASANITE_EXTENSION_ID: EXTENSION_ID },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const { result } = await rpc("tools/call", { name, arguments: args });
    return { ...result, value: result.isError && !result.content[0].text.startsWith("{") ? result.content[0].text : JSON.parse(result.content[0].text) };
  };
  const listening = new Promise((resolve) => child.stderr.on("data", () => /listening/.test(stderr) && resolve()));
  return { child, rpc, call, listening, stderr: () => stderr };
}

// Chrome stamps the extension's origin on its WebSocket; Node doesn't.
const NodeWebSocket = globalThis.WebSocket;
const withOrigin = (origin) => class extends NodeWebSocket {
  constructor(address) { super(address, { headers: { origin } }); }
};

async function bootExtension(port) {
  sink.forgetTableState();
  const base = fakeBase({ baseId: BASE_ID, tables: structuredClone(BASANITE_TABLES).map((table) => ({ ...table, records: table.records || [] })) });
  const fetch = async (input, init = {}) => {
    const u = String(input);
    if (u.startsWith("http://127.0.0.1:")) return realFetch(input, init);
    if (u.startsWith("https://api.airtable.com/") || u.startsWith("https://content.airtable.com/")) return base.handle(input, init);
    const id = new URL(u, "https://www.linkedin.com").searchParams.get("memberIdentity");
    if (id) return json({ elements: [profile(Number(id.split("-")[1]))] });
    return json({});
  };
  const people = BASANITE_TABLES.find((table) => table.id === PEOPLE);
  const config = { token: "patTESTTOKEN.0123456789abcdef", userId: "usrME000000000001", baseId: BASE_ID, baseName: "Basanite",
    tableId: PEOPLE, tableName: "People", fields: people.fields, mapping: fieldsLib.suggestMapping(people.fields),
    linked: linkedLib.suggestLinked(BASANITE_TABLES, PEOPLE), baseTables: sink.summarizeTables(BASANITE_TABLES), schemaAt: Date.now(), stampValue: "Added By Branch" };
  const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };
  const worker = await bootWorker({ fetch, cookies, storage: { airtable_config: config, claude_bridge_enabled: true, claude_bridge_port: port } });
  return { base, worker };
}

test("Claude lists the tools, reads status and config, and bulk-enriches through the extension", async () => {
  const port = await freePort();
  const server = startServer(port);
  globalThis.WebSocket = withOrigin(`chrome-extension://${EXTENSION_ID}`);
  let worker;
  let base;
  try {
    const init = await server.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    const { result: { tools } } = await server.rpc("tools/list");
    assert.ok(["status", "get_config", "enrich_urls", "enrich_table", "stop"].every((name) => tools.some((tool) => tool.name === name)));
    assert.ok(!tools.some((tool) => /^connect|disconnect|token|mapping|resync/i.test(tool.name)), "nothing that touches the token or setup");

    await server.listening;
    ({ worker, base } = await bootExtension(port));

    const status = await server.call("status");
    assert.equal(status.isError, false, server.stderr());
    assert.equal(status.value.network.status, "idle");
    assert.equal(worker.store.get("claude_bridge_state")?.connected, true);

    const config = await server.call("get_config");
    assert.equal(config.value.connected, true);
    assert.equal(config.value.tableId, PEOPLE);
    assert.equal(config.value.token, undefined);
    assert.ok(!JSON.stringify(config.value).includes("0123456789abcdef"), "the token never leaves the extension");
    assert.ok(config.value.baseTables.every((table) => table.fields.every((field) => Object.keys(field).join() === "id,name,type")));

    const started = await server.call("enrich_urls", { urls: [url(1), url(2), url(3), url(2)] });
    assert.equal(started.isError, false, JSON.stringify(started.value));
    let job;
    for (let waited = 0; waited < 30_000 && !["complete", "error"].includes(job?.status); waited += 100) {
      await sleep(100);
      job = (await server.call("status")).value.bulkEnrich;
    }
    assert.equal(job.status, "complete", job.error);
    assert.equal(job.created, 3);
    assert.equal(job.urls, undefined, "status leaves the URL list out");
    const people = base.rows(PEOPLE).map((row) => fieldsLib.linkedinKey(row.fields[P_LINKEDIN])).sort();
    assert.deepEqual(people, ["person-1", "person-2", "person-3"]);

    // Turning auto-sync off and on keeps the frequency Claude didn't mention.
    assert.equal((await server.call("set_auto_sync", { enabled: true, timesPerDay: 4 })).value.prefs.timesPerDay, 4);
    const off = await server.call("set_auto_sync", { enabled: false });
    assert.deepEqual([off.value.prefs.enabled, off.value.prefs.timesPerDay], [false, 4]);

    // The switch flicked on-off-on-off-on in a blink ends on and connected.
    const flick = (on) => { for (const [name, [listener]] of worker.calls) if (name === "storageChanged") listener({ claude_bridge_enabled: { newValue: on } }, "local"); };
    // Chrome's alarm calls take a moment; an unordered off can land after the last on.
    worker.chrome.alarms.clear = () => sleep(30).then(() => true);
    const flicked = Date.now();
    for (const on of [false, true, false, true]) flick(on);
    const fresh = () => { const state = worker.store.get("claude_bridge_state"); return state?.connected && state.at >= flicked; };
    for (let i = 0; i < 200 && !fresh(); i++) await sleep(10);
    assert.ok(fresh(), JSON.stringify(worker.store.get("claude_bridge_state")));
    const after = await server.call("status");
    assert.equal(after.isError, false, JSON.stringify(after.value));
  } finally {
    server.child.kill();
    await worker?.send({ type: "CANCEL_SYNC" }).catch(() => {});
    if (worker) {
      // The user turns Claude control off; the socket closes while the shim is still in place.
      const changed = { claude_bridge_enabled: { newValue: false } };
      for (const [name, [listener]] of worker.calls) if (name === "storageChanged") listener(changed, "local");
      for (let i = 0; i < 100 && worker.store.get("claude_bridge_state")?.connected !== false; i++) await sleep(10);
      assert.equal(worker.store.get("claude_bridge_state")?.connected, false);
      await sleep(100); // the queued off finishes its alarm call under the shim
    }
    globalThis.WebSocket = NodeWebSocket;
    worker?.restore();
  }
});

test("two Claude sessions at once: the second server takes the next port and both reach the extension", async () => {
  const port = await freePort();
  const first = startServer(port);
  const second = startServer(port);
  globalThis.WebSocket = withOrigin(`chrome-extension://${EXTENSION_ID}`);
  let worker;
  try {
    await Promise.all([first.listening, second.listening]);
    assert.match(first.stderr() + second.stderr(), new RegExp(`listening on 127\\.0\\.0\\.1:${port + 1}`), "the second session moved up a port");
    ({ worker } = await bootExtension(port));
    const [a, b] = await Promise.all([first.call("status"), second.call("status")]);
    assert.equal(a.isError, false, `first session: ${JSON.stringify(a.value)}`);
    assert.equal(b.isError, false, `second session: ${JSON.stringify(b.value)}`);
    // One session leaving doesn't cut the other off.
    first.child.kill();
    await sleep(200);
    const still = await second.call("status");
    assert.equal(still.isError, false, JSON.stringify(still.value));
    assert.equal(worker.store.get("claude_bridge_state")?.connected, true);
  } finally {
    first.child.kill();
    second.child.kill();
    if (worker) {
      const changed = { claude_bridge_enabled: { newValue: false } };
      for (const [name, [listener]] of worker.calls) if (name === "storageChanged") listener(changed, "local");
      for (let i = 0; i < 100 && worker.store.get("claude_bridge_state")?.connected !== false; i++) await sleep(10);
      await sleep(100);
    }
    globalThis.WebSocket = NodeWebSocket;
    worker?.restore();
  }
});

test("the server refuses any origin but the extension's", async () => {
  const port = await freePort();
  const server = startServer(port);
  try {
    await server.listening;
    const Evil = withOrigin("https://evil.example");
    const outcome = await new Promise((resolve) => {
      const ws = new Evil(`ws://127.0.0.1:${port}`);
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("refused");
    });
    assert.equal(outcome, "refused");
    assert.match(server.stderr(), /refused a connection from https:\/\/evil\.example/);
  } finally {
    server.child.kill();
  }
});

test("the extension answers only its allowed list", async () => {
  const worker = await bootWorker();
  try {
    for (const type of ["AIRTABLE_CONNECT", "AIRTABLE_DISCONNECT", "AIRTABLE_RESYNC_ALL", "AIRTABLE_SAVE_MAPPING", "AIRTABLE_SELECT_TABLE", undefined]) {
      const answer = await bridge.dispatch({ type, token: "patEVIL" });
      assert.match(answer.error, /isn't allowed/, String(type));
    }
    assert.equal(worker.store.get("airtable_config"), undefined, "nothing was connected");
  } finally {
    worker.restore();
  }
});

test("a call in flight on a replaced connection fails at once instead of hanging", async () => {
  const port = await freePort();
  const server = startServer(port);
  const Ext = withOrigin(`chrome-extension://${EXTENSION_ID}`);
  const open = (ws) => new Promise((resolve) => { ws.onopen = resolve; });
  let first;
  let second;
  try {
    await server.listening;
    first = new Ext(`ws://127.0.0.1:${port}`);
    await open(first);
    let asked;
    const got = new Promise((resolve) => { asked = resolve; });
    first.onmessage = (event) => asked(JSON.parse(event.data)); // and never answers
    const call = server.call("status");
    await got;
    const started = Date.now();
    second = new Ext(`ws://127.0.0.1:${port}`);
    const result = await call;
    assert.equal(result.isError, true);
    assert.match(result.value, /disconnected mid-call/);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    first?.close();
    second?.close();
    server.child.kill();
  }
});

test("a frame sent in the same packet as the handshake is read", async () => {
  const port = await freePort();
  const server = startServer(port);
  try {
    await server.listening;
    const payload = Buffer.from(JSON.stringify({ hello: { version: "same-packet" } }));
    const mask = Buffer.from([1, 2, 3, 4]);
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload.map((byte, i) => byte ^ mask[i & 3])]);
    const socket = dial(port, "127.0.0.1");
    await new Promise((resolve) => socket.on("connect", resolve));
    socket.write(Buffer.concat([Buffer.from(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: chrome-extension://${EXTENSION_ID}\r\n\r\n`), frame]));
    for (let i = 0; i < 100 && !/same-packet says hello/.test(server.stderr()); i++) await sleep(10);
    socket.destroy();
    assert.match(server.stderr(), /extension same-packet says hello/);
  } finally {
    server.child.kill();
  }
});
