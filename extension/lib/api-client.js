/**
 * The capture engines' backend, served by Airtable.
 *
 * linkedin-capture.js and linkedin-graph.js were written against EarthOS's
 * resumable people-import API. This module keeps that exact interface — the
 * create / chunk / status / complete protocol, the soft-sync existence check,
 * and the company and mutual uploads — and fulfils it locally: the import
 * ledger lives in chrome.storage, and every chunk is upserted into the
 * configured Airtable table by lib/airtable-sink.js. The engines' checkpoint,
 * resume, and retry logic runs unchanged on top of it.
 */

import { AirtableError, whoami } from "./airtable-client.js";
import {
  clearConfig,
  configProblem,
  knownPeople,
  prepareTable,
  readConfig,
  writePeople,
} from "./airtable-sink.js";

const LOG = (...args) => console.log("[Airtable:Import]", ...args);

export const ApiError = AirtableError;

const CONNECTION_SOURCE = "LinkedIn connection";

// ─── Auth ────────────────────────────────────────────────────────────────────

/** Truthy when captures have somewhere to go. Engines gate every run on it. */
async function getToken() {
  const config = await readConfig();
  return configProblem(config) ? null : config.token;
}

async function checkAuth() {
  const config = await readConfig();
  if (!config.token) return null;
  try {
    return await whoami(config.token);
  } catch {
    return null;
  }
}

async function logout() {
  await clearConfig();
}

// ─── Import ledger ───────────────────────────────────────────────────────────

const IMPORTS_KEY = "airtable_imports";
const KEEP_COMPLETE_MS = 24 * 60 * 60 * 1000;

let ledger = null;
let ledgerQueue = Promise.resolve();

function withLedger(operation) {
  const task = ledgerQueue.then(async () => {
    if (!ledger) {
      const stored = await chrome.storage.local.get(IMPORTS_KEY);
      ledger = new Map(Object.entries(stored[IMPORTS_KEY] || {}));
    }
    return operation(ledger);
  });
  ledgerQueue = task.catch(() => {});
  return task;
}

/** Disconnect: forget the in-memory ledger too, or its next save would bring it back. */
export function resetImportLedger() {
  return withLedger(() => {
    ledger = null;
  });
}

async function saveLedger() {
  const cutoff = Date.now() - KEEP_COMPLETE_MS;
  for (const [id, record] of ledger) {
    if (record.status === "complete" && record.completedAt < cutoff) ledger.delete(id);
  }
  await chrome.storage.local.set({ [IMPORTS_KEY]: Object.fromEntries(ledger) });
}

function totals(record) {
  const sum = { accepted: 0, failed: 0, created: 0, updated: 0, unchanged: 0 };
  for (const chunk of Object.values(record.received)) {
    for (const key of Object.keys(sum)) sum[key] += chunk[key] || 0;
  }
  return sum;
}

function view(record) {
  return {
    id: record.id,
    source: record.source,
    status: record.status,
    expectedRows: record.expectedRows ?? null,
    chunks: Object.keys(record.received).length,
    ...totals(record),
    createdAt: new Date(record.createdAt).toISOString(),
    completedAt: record.completedAt ? new Date(record.completedAt).toISOString() : null,
  };
}

function statusOf(record) {
  const receivedSequences = Object.keys(record.received).map(Number).sort((a, b) => a - b);
  let nextExpectedSequence = 0;
  while (record.received[nextExpectedSequence]) nextExpectedSequence++;
  return { import: view(record), nextExpectedSequence, receivedSequences };
}

function lookup(importId) {
  const record = ledger.get(importId);
  if (!record) throw new ApiError("Import not found", { status: 404 });
  return record;
}

async function createPeopleImport({ source = "linkedin", expectedRows, sourceCursor, clientImportKey } = {}) {
  // A network sync matches against the table as it is right now; a full one
  // re-reads it outright, so rows added or deleted by hand are seen.
  if (sourceCursor?.mode === "linkedin_network_connections") {
    await prepareTable({ force: sourceCursor.syncMode !== "soft" && !sourceCursor.nextSequence });
  }
  return withLedger(async (imports) => {
    if (clientImportKey) {
      const existing = [...imports.values()].find((record) => record.clientImportKey === clientImportKey);
      if (existing) {
        if (Number.isInteger(expectedRows) && Number.isInteger(existing.expectedRows)
            && expectedRows !== existing.expectedRows) {
          throw new ApiError("Import key already used with different parameters", { status: 409 });
        }
        return { import: view(existing) };
      }
    }
    const record = {
      id: crypto.randomUUID(),
      source,
      status: "open",
      expectedRows: Number.isInteger(expectedRows) ? expectedRows : null,
      clientImportKey: clientImportKey || null,
      mode: sourceCursor?.mode || null,
      received: {},
      createdAt: Date.now(),
      completedAt: null,
    };
    imports.set(record.id, record);
    await saveLedger();
    return { import: view(record) };
  });
}

async function getPeopleImportStatus(importId) {
  return withLedger(async () => statusOf(lookup(importId)));
}

async function putPeopleImportChunk(importId, sequence, rows) {
  const record = await withLedger(async () => lookup(importId));
  if (record.status === "complete") throw new ApiError("Import is already complete", { status: 409 });
  const replay = record.received[sequence];
  if (replay) return { chunk: { sequence, ...replay, replayed: true } };

  const tally = await writePeople(Array.isArray(rows) ? rows : [], { source: CONNECTION_SOURCE, degree: "1st" });
  const chunk = {
    rowCount: tally.rowCount,
    accepted: tally.accepted,
    failed: tally.failed,
    created: tally.created,
    updated: tally.updated,
    unchanged: tally.unchanged,
  };
  await withLedger(async () => {
    record.received[sequence] = chunk;
    await saveLedger();
  });
  return { chunk: { sequence, ...chunk, replayed: false } };
}

async function completePeopleImport(importId) {
  return withLedger(async () => {
    const record = lookup(importId);
    if (record.status !== "complete") {
      record.status = "complete";
      record.completedAt = Date.now();
      await saveLedger();
      const sum = totals(record);
      LOG(`Import ${importId}: ${sum.created} created, ${sum.updated} updated, ${sum.unchanged} unchanged, ${sum.failed} failed`);
    }
    return { import: view(record) };
  });
}

/** `{ known: boolean[] }`: who already has a row, so soft sync skips enriching them. */
async function softSyncCheck(rows) {
  return { known: await knownPeople(Array.isArray(rows) ? rows : []) };
}

/** Notification signals and warmth were EarthOS-side features; Airtable has no home for them. */
async function uploadNetworkSignals() {
  return { notifications: { signals: 0 }, profileSignals: { signals: 0 }, warmth: null };
}

// ─── Graph uploads ───────────────────────────────────────────────────────────

async function captureMutualConnections(results) {
  const all = Array.isArray(results) ? results : [];
  // A target LinkedIn wouldn't open comes back with no profile and no bridges:
  // writing it would add a nameless row, or zero a mutual count already there.
  const resolved = all.filter((result) => result?.profile?.name || (Array.isArray(result?.bridges) && result.bridges.length));
  const unresolved = all.length - resolved.length;
  if (!resolved.length) return { updated: 0, unresolved, mutualPeople: [] };
  const rows = resolved.map((result) => ({
    ...(result?.profile || {}),
    linkedinUrl: result?.linkedinUrl,
    degree: result?.connectionDegree ?? null,
    bridges: Array.isArray(result?.bridges) ? result.bridges : [],
    totalBridges: result?.totalBridges || 0,
  }));
  const tally = await writePeople(rows, { source: "Mutual finder" });
  return { updated: tally.accepted, unresolved: unresolved + tally.failed, mutualPeople: [] };
}

async function captureCompanyPeople(payload) {
  const company = String(payload?.company || "").trim();
  const people = Array.isArray(payload?.people) ? payload.people : [];
  const tally = await writePeople(people, { source: company ? `Company: ${company}` : "Company search" });
  return { accepted: tally.accepted, created: tally.created, updated: tally.updated, failed: tally.failed };
}

/** Profiles picked from search or the open tab. */
async function captureProfiles(profiles, { source = "Profile capture" } = {}) {
  return writePeople(Array.isArray(profiles) ? profiles : [], { source });
}

async function captureTwitter() {
  throw new ApiError("X capture isn't supported in this build.", { status: 400 });
}

export {
  getToken,
  checkAuth,
  logout,
  createPeopleImport,
  getPeopleImportStatus,
  putPeopleImportChunk,
  completePeopleImport,
  softSyncCheck,
  uploadNetworkSignals,
  captureTwitter,
  captureMutualConnections,
  captureCompanyPeople,
  captureProfiles,
};
