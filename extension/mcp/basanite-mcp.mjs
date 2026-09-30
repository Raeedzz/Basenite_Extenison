#!/usr/bin/env node
/**
 * MCP server (stdio) that drives the Basanite Chrome extension.
 * The extension dials ws://127.0.0.1:PORT once "Claude control" is on in its panel;
 * only that extension's origin is accepted. No dependencies.
 *
 * The panel's "Connect Claude" button downloads it as a Claude desktop connector
 * (lib/claude-connector.js). By hand: node mcp/basanite-mcp.mjs
 *
 * Env: BASANITE_MCP_PORT (17891), BASANITE_EXTENSION_ID (the unpacked extension's id).
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const PORT = Number(process.env.BASANITE_MCP_PORT) || 17891;
const ORIGIN = `chrome-extension://${process.env.BASANITE_EXTENSION_ID || "cfpkjnakokdcflgklcgmkofjfkgehoia"}`;
const CALL_TIMEOUT_MS = 300_000;
const CONNECT_WAIT_MS = 35_000; // the extension redials every 30s
const MAX_FRAME = 16 * 1024 * 1024;
const log = (...args) => console.error("[basanite-mcp]", ...args);

// ─── Tools ───────────────────────────────────────────────────────────────────

const str = (description) => ({ type: "string", description });
const list = (description) => ({ type: "array", items: { type: "string" }, maxItems: 5, description });
const urls = (description, maxItems) => ({ type: "array", items: { type: "string" }, description, ...(maxItems ? { maxItems } : {}) });
const READ = { readOnlyHint: true };

// Every LinkedIn people-search filter, shared by search_linkedin_people and capture_search.
const SEARCH_FILTERS = {
  keywords: str("Free text across the whole profile, e.g. \"pytorch distributed training\""),
  titles: list("Current title, e.g. [\"staff engineer\", \"tech lead\"]"),
  companies: list("Current company names or linkedin.com/company URLs"),
  pastCompanies: list("Past company names or URLs"),
  schools: list("School names or linkedin.com/school URLs"),
  locationIds: list("LinkedIn geo ids, e.g. \"102277331\" (San Francisco), \"103644278\" (United States), \"90000084\" (SF Bay Area)"),
  industryIds: list("LinkedIn industry ids, e.g. \"4\" (Software Development), \"43\" (Financial Services)"),
  profileLanguages: list("Profile language codes, e.g. \"en\""),
  firstName: str("First name"),
  lastName: str("Last name"),
  degrees: { type: "array", items: { type: "string", enum: ["1st", "2nd", "3rd"] }, description: "Only these degrees from the user (3rd = 3rd and beyond). Omit for everyone." },
  connectionOf: str("A LinkedIn profile URL: search that person's connections (only when they're visible to the user)"),
  searchUrl: str("A linkedin.com/search/results/people/?… URL whose filters to start from"),
};

const TOOLS = [
  {
    name: "status",
    description: "What the extension is doing now: network sync, enrich, mutuals and company capture progress, and the bulk enrich job. Poll this after starting a background run.",
    annotations: READ,
    toMessage: () => ({ type: "STATUS" }),
  },
  {
    name: "get_config",
    description: "The connected Airtable base, People table, column mapping, and every table and field in the base (enrich_table needs their ids). Names and ids only: no records — this connector can't read or search what's in the base.",
    annotations: READ,
    toMessage: () => ({ type: "AIRTABLE_GET_CONFIG" }),
    shape: trimConfig,
  },
  {
    name: "check_connection",
    description: "LinkedIn session and Airtable health. probe=true makes a live LinkedIn call.",
    properties: { probe: { type: "boolean" } },
    annotations: READ,
    toMessage: ({ probe }) => ({ type: "GET_CONNECTION_HEALTH", probe: probe === true }),
  },
  {
    name: "reload_columns",
    description: "Re-read the Airtable base's tables and fields (after columns were added or renamed in Airtable).",
    toMessage: () => ({ type: "AIRTABLE_REFRESH_SCHEMA" }),
    shape: trimConfig,
  },
  {
    name: "sync_network",
    description: "Start syncing the user's LinkedIn connections into Airtable (runs in the background; poll status). mode 'full' (default) or 'soft' (quick refresh). sample=true stops after 10 connections.",
    properties: { mode: { type: "string", enum: ["full", "soft"] }, sample: { type: "boolean" } },
    toMessage: ({ mode, sample }) => ({ type: "START_CAPTURE", site: "linkedin", mode: mode === "soft" ? "soft" : "full", sample: sample === true }),
  },
  {
    name: "set_auto_sync",
    description: "Turn the scheduled quick refresh on or off, and optionally how many times a day it runs (1, 2, 4, 6, 12 or 24; omitted keeps the current).",
    properties: { enabled: { type: "boolean" }, timesPerDay: { type: "number" } },
    required: ["enabled"],
    toMessage: ({ enabled, timesPerDay }) => ({ type: "SET_SOFT_SYNC_PREFS", prefs: { enabled: enabled === true, timesPerDay } }),
  },
  {
    name: "search_linkedin_people",
    description: "Full LinkedIn people search, in or out of the user's network, with every filter LinkedIn has. Searches LinkedIn, never the Airtable base. Writes nothing — to save a search's people to Airtable use capture_search. Filters combine (AND); values inside one filter are alternatives (OR). Company and school names resolve to LinkedIn's; the result says what they resolved to. Locations and industries take LinkedIn ids — or pass searchUrl: a people search the user set up on linkedin.com (any filters), and add to it. connectionOf + degrees [\"1st\"] = the user's mutuals with that person (who can introduce them). LinkedIn serves at most 1,000 results per search, so split big ones (by location, company, title). Returns names, headlines, profile URLs and degree. Page with start = nextStart.",
    properties: {
      ...SEARCH_FILTERS,
      start: { type: "number", description: "Offset, from a previous nextStart" },
      limit: { type: "number", description: "1-100, default 25" },
    },
    annotations: READ,
    toMessage: (args) => ({ ...args, type: "FIND_PEOPLE" }),
  },
  {
    name: "capture_search",
    description: "Add everyone a LinkedIn people search finds to Airtable, with full profiles — the same filters as search_linkedin_people. Pages through every result (LinkedIn's limit is 1,000 per search; max lowers it), then runs a bulk enrich in the background: poll status (bulkEnrich) until it completes. People already in Airtable are updated, never duplicated. If nextStart comes back, the search had more than one call could page: call again with start = nextStart.",
    properties: {
      ...SEARCH_FILTERS,
      start: { type: "number", description: "Offset, from a previous nextStart" },
      max: { type: "number", description: "At most this many people, 1-1000 (default: all LinkedIn serves)" },
    },
    toMessage: (args) => ({ ...args, type: "CAPTURE_SEARCH" }),
  },
  {
    name: "get_profiles",
    description: "Read full LinkedIn profiles (experience with descriptions, education, skills, about) to judge who is most qualified. Writes nothing; use capture_profiles to save the chosen ones.",
    properties: { urls: urls("LinkedIn profile URLs", 25) },
    required: ["urls"],
    annotations: READ,
    toMessage: ({ urls }) => ({ type: "GET_PROFILES", urls }),
  },
  {
    name: "capture_profiles",
    description: "Add people to Airtable by LinkedIn profile URL — one person or up to 50 — with their full profile. Waits and returns created/updated counts; someone already in People is updated, never duplicated.",
    properties: { urls: urls("LinkedIn profile URLs (https://www.linkedin.com/in/...)", 50) },
    required: ["urls"],
    toMessage: ({ urls }) => ({ type: "CAPTURE_PROFILES", urls }),
  },
  {
    name: "enrich_urls",
    description: "Bulk enrich any number of LinkedIn profile URLs into Airtable (runs in the background; poll status).",
    properties: { urls: urls("LinkedIn profile URLs") },
    required: ["urls"],
    toMessage: ({ urls }) => ({ type: "BULK_ENRICH", urls: (urls || []).join("\n") }),
  },
  {
    name: "enrich_table",
    description: "Bulk enrich everyone whose LinkedIn URL is in one column of an Airtable table into People (runs in the background; poll status). Table and field ids come from get_config.",
    properties: { tableId: str("tbl..."), fieldId: str("fld... holding the LinkedIn URLs") },
    required: ["tableId", "fieldId"],
    toMessage: ({ tableId, fieldId }) => ({ type: "ENRICH_FROM_TABLE", tableId, fieldId }),
  },
  {
    name: "resume_enrich",
    description: "Resume a bulk enrich that stopped or failed.",
    toMessage: () => ({ type: "BULK_ENRICH_RESUME" }),
  },
  {
    name: "capture_company",
    description: "Capture the people at a company into Airtable (runs in the background; poll status). Keywords (up to 6) narrow it, e.g. titles.",
    properties: { company: str("Company name"), keywords: { type: "array", items: { type: "string" }, maxItems: 6 } },
    required: ["company"],
    toMessage: ({ company, keywords }) => ({ type: "START_COMPANY_CAPTURE", company, keywords: keywords || [] }),
  },
  {
    name: "find_mutuals",
    description: "Find the user's mutual connections with these people and record them in Airtable (runs in the background; poll status).",
    properties: { urls: urls("LinkedIn profile URLs") },
    required: ["urls"],
    toMessage: ({ urls }) => ({ type: "START_MUTUAL_FINDING", contacts: (urls || []).map((linkedinUrl) => ({ linkedinUrl })) }),
  },
  {
    name: "log_interaction",
    description: "Log an interaction with a person in Airtable's Interactions table (adds them to People first if needed). A note also goes to Notes.",
    properties: {
      url: str("Their LinkedIn profile URL"),
      types: { type: "array", items: { type: "string", enum: ["Calls", "DM", "Email", "Lunch", "Dinner", "Coffee", "Event Attendee"] }, minItems: 1 },
      at: str("When it happened, ISO 8601"),
      note: str("Optional note"),
    },
    required: ["url", "types", "at"],
    // retry: a repeat after a failed or timed-out call finds the rows that already landed instead of writing them twice.
    toMessage: ({ url, types, at, note }) => ({ type: "LOG_INTERACTION", url, types, at, note: note || "", retry: true }),
  },
  {
    name: "stop",
    description: "Stop whatever capture or enrich is running.",
    toMessage: () => ({ type: "CANCEL_SYNC" }),
  },
];

/** The config minus what Claude doesn't need: choice lists, formula options. */
function trimConfig(config) {
  if (!config || config.error) return config;
  const fields = (list) => (list || []).map(({ id, name, type }) => ({ id, name, type }));
  return {
    ...config,
    fields: fields(config.fields),
    baseTables: (config.baseTables || []).map(({ id, name, fields: list }) => ({ id, name, fields: fields(list) })),
  };
}

// ─── Extension link (WebSocket server) ───────────────────────────────────────

let extension = null; // { send, close }
let portTaken = false;
let nextId = 1;
const pending = new Map();
const waiters = new Set();

function frame(opcode, payload) {
  const length = payload.length;
  const head = Buffer.alloc(length < 126 ? 2 : length < 65536 ? 4 : 10);
  head[0] = 0x80 | opcode;
  if (length < 126) head[1] = length;
  else if (length < 65536) { head[1] = 126; head.writeUInt16BE(length, 2); }
  else { head[1] = 127; head.writeBigUInt64BE(BigInt(length), 2); }
  return Buffer.concat([head, payload]);
}

function accept(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (req.headers.origin !== ORIGIN || !key || String(req.headers.upgrade).toLowerCase() !== "websocket") {
    log(`refused a connection from ${req.headers.origin || "no origin"}`);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const digest = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`);
  socket.setNoDelay(true);

  const link = {
    send: (text) => socket.writable && socket.write(frame(1, Buffer.from(text))),
    close: () => socket.destroy(),
  };
  extension?.close(); // the newest worker wins
  extension = link;
  // Any message counts as activity that keeps the extension's worker alive.
  const ping = setInterval(() => link.send('{"ping":1}'), 20_000);

  let buffer = Buffer.alloc(0);
  let parts = [];
  const read = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = buffer[0] & 0x80;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let at = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); at = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); at = 10; }
      if (!(buffer[1] & 0x80) || length > MAX_FRAME) return socket.destroy();
      if (buffer.length < at + 4 + length) return;
      const mask = buffer.subarray(at, at + 4);
      const data = Buffer.from(buffer.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < length; i++) data[i] ^= mask[i & 3];
      buffer = buffer.subarray(at + 4 + length);
      if (opcode === 8) return socket.end(frame(8, data.subarray(0, 2)));
      if (opcode === 9) { socket.write(frame(10, data)); continue; }
      if (opcode === 10) continue;
      parts.push(data);
      if (!fin) continue;
      const text = Buffer.concat(parts).toString("utf8");
      parts = [];
      fromExtension(text);
    }
  };
  socket.on("data", read);
  if (head?.length) read(head);
  socket.on("error", () => {});
  socket.on("close", () => {
    clearInterval(ping);
    for (const [id, call] of pending) {
      if (call.link !== link) continue;
      pending.delete(id);
      call.reject(new Error("The extension disconnected mid-call (its worker restarted?). Check status before retrying."));
    }
    if (extension !== link) return;
    extension = null;
    log("extension disconnected");
  });
  log("extension connected");
  for (const wake of waiters) wake();
}

function fromExtension(text) {
  let message;
  try { message = JSON.parse(text); } catch { return; }
  if (message.hello) return log(`extension ${message.hello.version || "?"} says hello`);
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  call.resolve(message.result);
}

async function waitForExtension() {
  if (extension) return;
  if (portTaken) throw new Error(`Port ${PORT} is taken, probably by another Claude session's Basanite MCP server. Close that session, or set BASANITE_MCP_PORT here and "claude_bridge_port" in the extension.`);
  await new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
    const timer = setTimeout(done, CONNECT_WAIT_MS);
    waiters.add(done);
  });
  if (!extension) throw new Error("The Basanite extension isn't connected. Chrome must be open with the extension loaded, and \"Claude control\" turned on in its panel.");
}

async function callExtension(message) {
  await waitForExtension();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("The extension didn't answer in time.")); }, CALL_TIMEOUT_MS);
    pending.set(id, {
      link: extension,
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    extension.send(JSON.stringify({ ...message, id }));
  });
}

// Plain HTTP is the extension checking the server is up before it dials (a
// failed WebSocket dial logs an error in Chrome; a failed fetch doesn't). 204,
// not an error status, so the check itself logs nothing either.
const http = createServer((req, res) => res.writeHead(204).end());
http.on("upgrade", accept);
http.on("error", (error) => {
  if (error.code !== "EADDRINUSE") throw error;
  portTaken = true;
  log(`port ${PORT} in use, retrying in 5s`);
  setTimeout(() => http.listen(PORT, "127.0.0.1"), 5_000).unref();
});
http.on("listening", () => { portTaken = false; log(`listening on 127.0.0.1:${PORT} for ${ORIGIN}`); });
http.listen(PORT, "127.0.0.1");

// ─── MCP over stdio ──────────────────────────────────────────────────────────

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

async function callTool(name, args) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
  try {
    const raw = await callExtension(tool.toMessage(args || {}));
    const result = tool.shape ? tool.shape(raw) : raw;
    const failed = Boolean(result && typeof result === "object" && result.error);
    return { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }], isError: failed };
  } catch (error) {
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
}

async function handle(request) {
  const { id, method, params } = request;
  switch (method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "basanite", version: "1.0.0" },
        instructions: "Drives the Basanite Chrome extension (LinkedIn → Airtable). It searches LinkedIn only and writes to Airtable; it cannot read or search the records in Airtable, so no tool here tells you who is already in the base (search results are LinkedIn's, not the base's). Adding someone who is already there is safe: they are updated, never duplicated. Long runs start in the background: poll `status` until they finish. Only one LinkedIn run at a time; `stop` ends it. To find the best people for something: search_linkedin_people with the filters that define the role (titles, companies, pastCompanies, schools, locations, degrees), several narrow searches rather than one broad one; get_profiles on the promising ones to rank them on their full experience; search_linkedin_people with connectionOf + degrees [\"1st\"] for who can introduce the user; capture_profiles to add the chosen people to Airtable (one URL is fine), or capture_search to add everyone a search finds. Every LinkedIn call counts toward LinkedIn's limits: on a free account, heavy searching hits LinkedIn's monthly commercial-use limit and searches then return only a few people.",
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map(({ name, description, properties, required, annotations }) => ({
          name, description, annotations,
          inputSchema: { type: "object", properties: properties || {}, ...(required ? { required } : {}), additionalProperties: false },
        })),
      };
    case "tools/call":
      return callTool(params?.name, params?.arguments);
    default:
      if (id === undefined) return undefined; // notifications
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { return write({ id: null, error: { code: -32700, message: "Parse error" } }); }
  try {
    const result = await handle(request);
    if (request.id !== undefined) write({ id: request.id, result });
  } catch (error) {
    if (request.id !== undefined) write({ id: request.id, error: { code: error.code || -32603, message: error.message } });
  }
}).on("close", () => process.exit(0));
