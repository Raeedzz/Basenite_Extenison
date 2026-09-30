/**
 * Lets Claude drive the extension through the local MCP server (mcp/basanite-mcp.mjs).
 * Off until the user turns on "Claude control" in the panel. The worker dials
 * out to 127.0.0.1; the server's pings keep the worker awake while connected,
 * and an alarm redials after the worker was torn down.
 */
import { BULK_JOB_KEY } from "./bulk-enrich.js";

export const BRIDGE_ENABLED_KEY = "claude_bridge_enabled";
export const BRIDGE_STATE_KEY = "claude_bridge_state";
const BRIDGE_PORT_KEY = "claude_bridge_port";
// Made by the panel with the connector, which carries it to the server. A server
// that can't present it gets no answers: any program on the computer could
// otherwise pose as Claude and drive the user's LinkedIn and Airtable.
export const BRIDGE_SECRET_KEY = "claude_bridge_secret";
const PROOF_WAIT_MS = 5_000;
const REFUSAL = "This Basanite connector wasn't made by this browser's Basanite extension (or is out of date). "
  + "In the extension's panel press Re-download, double-click the file to install it, then quit and reopen Claude.";
export const BRIDGE_DEFAULT_PORT = 17891;
// Every Claude session runs its own MCP server, each on the first free port from
// the base up (mcp/basanite-mcp.mjs); one socket per server.
export const BRIDGE_PORT_RANGE = 5;
const BRIDGE_ALARM = "claude-bridge";
const PROGRESS_KEYS = ["capture_progress", "enrich_progress", "mutual_progress", "company_progress"];

// Captures, enriches and reads. Never the token, the table choice, the mapping, or a reset.
export const BRIDGE_TYPES = new Set([
  "GET_CONNECTION_HEALTH",
  "AIRTABLE_GET_CONFIG",
  "AIRTABLE_REFRESH_SCHEMA",
  "START_CAPTURE",
  "SET_SOFT_SYNC_PREFS",
  "FIND_PEOPLE",
  "CAPTURE_SEARCH",
  "GET_PROFILES",
  "CAPTURE_PROFILES",
  "BULK_ENRICH",
  "BULK_ENRICH_RESUME",
  "ENRICH_FROM_TABLE",
  "START_COMPANY_CAPTURE",
  "START_MUTUAL_FINDING",
  "LOG_INTERACTION",
  "CANCEL_SYNC",
]);

let handle = null;
let enabled = false;
const sockets = new Map(); // port → WebSocket
const trusted = new WeakSet(); // sockets whose server presented the secret
const dialing = new Set();
// Toggles apply in order, so on-off-on can't finish with the off.
let applying = Promise.resolve();

/** `handler(message)` answers like the panel's messages do, errors included. */
export function startClaudeBridge(handler) {
  handle = handler;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BRIDGE_ALARM) void connect().catch(() => {});
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && BRIDGE_ENABLED_KEY in changes) void queueApply(changes[BRIDGE_ENABLED_KEY].newValue === true).catch(() => {});
  });
  return chrome.storage.local.get([BRIDGE_ENABLED_KEY, BRIDGE_STATE_KEY]).then(async (stored) => {
    // A fresh worker has no socket, whatever the last one left in storage.
    if (stored[BRIDGE_STATE_KEY]?.connected) await setState(false);
    return queueApply(stored[BRIDGE_ENABLED_KEY] === true);
  });
}

function queueApply(on) {
  applying = applying.then(() => apply(on), () => apply(on));
  return applying;
}

async function apply(on) {
  enabled = on;
  if (on) {
    await chrome.alarms.create(BRIDGE_ALARM, { periodInMinutes: 0.5 });
    return connect();
  }
  await chrome.alarms.clear(BRIDGE_ALARM);
  const open = [...sockets.values()];
  sockets.clear();
  // Closing one still connecting logs an error in Chrome; it closes once open instead.
  for (const ws of open) {
    if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
    else ws.close();
  }
  await setState(false);
}

async function connect() {
  if (!enabled) return;
  const base = Number((await chrome.storage.local.get(BRIDGE_PORT_KEY))[BRIDGE_PORT_KEY]) || BRIDGE_DEFAULT_PORT;
  await Promise.all(Array.from({ length: BRIDGE_PORT_RANGE }, (_, i) => dial(base + i)));
}

async function dial(port) {
  if (!enabled || sockets.has(port) || dialing.has(port)) return;
  dialing.add(port);
  try {
    // A WebSocket that can't connect logs an error on chrome://extensions, every
    // redial, while Claude isn't running; a fetch that can't connect logs nothing.
    // So dial only once the server answers one.
    if (!(await listening(port)) || !enabled || sockets.has(port)) return;
    const secret = (await chrome.storage.local.get(BRIDGE_SECRET_KEY))[BRIDGE_SECRET_KEY];
    if (!enabled || sockets.has(port)) return;
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      return;
    }
    sockets.set(port, ws);
    let outdated = false;
    // A connector from before the secret (or another install's) never proves itself.
    const refuse = () => {
      if (trusted.has(ws)) return;
      outdated = true;
      // Said before closing, so Claude can tell the user what to do.
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ refused: REFUSAL }));
      ws.close();
    };
    let proofTimer = null;
    ws.onopen = () => {
      ws.send(JSON.stringify({ hello: { version: chrome.runtime.getManifest().version } }));
      if (!trusted.has(ws)) proofTimer = setTimeout(refuse, PROOF_WAIT_MS);
    };
    ws.onmessage = (event) => {
      if (trusted.has(ws)) return void answer(ws, event.data).catch(() => {});
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message?.welcome) return; // nothing is answered before the proof
      if (secret && message.welcome.secret === secret) {
        trusted.add(ws);
        clearTimeout(proofTimer);
        void setState(true);
      } else {
        clearTimeout(proofTimer);
        refuse();
      }
    };
    // A failed dial closes too; the alarm tries again.
    ws.onclose = () => {
      clearTimeout(proofTimer);
      if (sockets.get(port) !== ws) return;
      sockets.delete(port);
      const connected = [...sockets.values()].some((open) => trusted.has(open) && open.readyState === WebSocket.OPEN);
      void setState(connected, outdated ? { outdated: true } : {});
    };
  } finally {
    dialing.delete(port);
  }
}

async function listening(port) {
  try {
    // A server for another extension (or anything else on the port) must not
    // answer: its WebSocket would refuse this origin, and that refusal logs an error.
    await fetch(`http://127.0.0.1:${port}/?ext=${chrome.runtime.id}`, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

async function answer(ws, data) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (message?.id == null) return; // keep-alive ping
  const { id, ...request } = message;
  const result = await dispatch(request).catch((error) => ({ error: error?.message || String(error) }));
  let reply;
  try {
    reply = JSON.stringify({ id, result });
  } catch (error) {
    reply = JSON.stringify({ id, result: { error: `Couldn't send the answer: ${error.message}` } });
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(reply);
}

export async function dispatch(message) {
  if (message?.type === "STATUS") return status();
  if (!BRIDGE_TYPES.has(message?.type)) return { error: `Claude isn't allowed to send ${message?.type}.` };
  return handle(message);
}

async function status() {
  const stored = await chrome.storage.local.get([...PROGRESS_KEYS, BULK_JOB_KEY]);
  const job = stored[BULK_JOB_KEY];
  return {
    network: stored.capture_progress || { status: "idle" },
    enrich: stored.enrich_progress || null,
    mutuals: stored.mutual_progress || null,
    company: stored.company_progress || null,
    bulkEnrich: job ? {
      ...job, urls: undefined, total: job.total ?? job.urls?.length, failedUrls: job.failedUrls?.slice(-20),
    } : null,
  };
}

function setState(connected, extra = {}) {
  return chrome.storage.local.set({ [BRIDGE_STATE_KEY]: { connected, at: Date.now(), ...extra } }).catch(() => {});
}
