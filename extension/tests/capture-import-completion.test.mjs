import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PEOPLE_IMPORT_KEY_MAX_LENGTH, peopleImportKeyForRun } from "../lib/import-protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_SOURCE = fs.readFileSync(
  path.join(HERE, "../background/linkedin-capture.js"),
  "utf8",
);

test("every progressive LinkedIn import checkpoint carries its capture run id", () => {
  const cursorBlocks = [...CAPTURE_SOURCE.matchAll(
    /sourceCursor:\s*\{\s*mode:\s*"linkedin_network_connections",([\s\S]*?)\}/g,
  )];
  assert.ok(cursorBlocks.length >= 5, "expected create, chunk, and completion cursors");
  for (const [, body] of cursorBlocks) {
    assert.match(body, /\brunId,\s*/, "network import cursor omitted its capture run id");
    assert.match(
      body,
      /\bsyncMode:\s*softSync\s*\?\s*"soft"\s*:\s*"full",/,
      "network import cursor omitted its soft/full sync mode",
    );
  }
});

/**
 * The stuck-sync regression.
 *
 * The server treats clientImportKey as an idempotency key and answers 409 —
 * "clientImportKey is already associated with different import parameters" —
 * when a key is replayed with parameters that have moved. A key held across
 * attempts guarantees that: the create cursor carries the run id, the sync mode
 * flips when a soft run is promoted to a full one, and expectedRows tracks a
 * LinkedIn connection count that drifts between reads. Because the checkpoint
 * keeps handing the same key back, every retry fails identically and the panel's
 * own "Try again" cannot clear it.
 *
 * Two things have to hold: the key is scoped to the attempt so the conflict
 * cannot arise, and a conflict that does arrive — from a checkpoint an older
 * build stranded — opens a new import instead of failing the sync.
 */

/**
 * Exactly the openImport() body, bounded by the declaration that follows it.
 * A fixed character window would silently overrun into acknowledgeComplete,
 * whose legitimate resetImportCheckpoint() call would then defeat the assertion
 * below that the recovery does not reset the checkpoint.
 */
const openImportSource = (() => {
  const start = CAPTURE_SOURCE.indexOf("    async function openImport() {");
  assert.notEqual(start, -1, "expected an openImport() helper in the capture engine");
  const end = CAPTURE_SOURCE.indexOf("\n    function assertNotCanceled(", start);
  assert.notEqual(end, -1, "expected openImport() to be followed by assertNotCanceled()");
  return CAPTURE_SOURCE.slice(start, end);
})();
test("an import is opened under a key scoped to the attempt that opens it", () => {
  assert.match(
    openImportSource,
    /const clientImportKey = peopleImportKeyForRun\(progress\.clientImportKey, runId\);/,
  );
  // Derived once per send, so both the first attempt and the post-conflict
  // resend read the checkpoint key as it stands at that moment.
  assert.match(openImportSource, /const send = \(\) => \{/);
  // The raw checkpoint key is never what gets sent: it outlives the attempt,
  // which is precisely what makes a replay conflict inevitable.
  assert.doesNotMatch(openImportSource, /clientImportKey: progress\.clientImportKey\b/);
  // A derived key can come back null, and the server's schema takes the key as
  // optional — an explicit null is a 400, so the field is omitted instead.
  assert.match(openImportSource, /\.\.\.\(clientImportKey \? \{ clientImportKey \} : \{\}\)/);
  assert.match(
    CAPTURE_SOURCE,
    /import \{ peopleImportKeyForRun \} from "\.\.\/lib\/import-protocol\.js"/,
  );
  // The one create call site goes through the helper.
  assert.match(CAPTURE_SOURCE, /const created = await openImport\(\);/);
});

test("a spent import key opens a new import rather than failing every sync", () => {
  // A 409 is a spent key, not a failed sync: retire it, persist that, resend.
  assert.match(openImportSource, /if \(error\?\.status !== 409\) throw error;/);
  assert.match(openImportSource, /progress\.clientImportKey = createRunId\(\);/);
  assert.match(openImportSource, /await saveProgress\(progress\);/);
  assert.match(openImportSource, /assertNotCanceled\(\);\s*\n\s*return await send\(\);/);
  // Only the key is retired. resetImportCheckpoint() would also zero
  // totalChunks, and an import with no chunks completes immediately — the whole
  // network would be silently dropped on the way out of the recovery.
  assert.doesNotMatch(openImportSource, /resetImportCheckpoint/);
});

/**
 * The regex assertions above pin the shape of the recovery; these run it.
 *
 * Nothing else in the suite ever executes openImport() — the worker-level tests
 * all resume an import that already exists, so they enter the capture past the
 * branch that opens one. A misspelled closure variable or an inverted condition
 * in the recovery would therefore ship green, and it would only surface for the
 * users who are already stuck, which is precisely who the recovery is for.
 *
 * The real shipped source is lifted out and given its free variables as
 * parameters, so what runs here is the same text the extension loads.
 */
const OPEN_IMPORT_FREE_VARIABLES = [
  "sendImportRequest",
  "progress",
  "peopleImportKeyForRun",
  "runId",
  "softSync",
  "rowsPerChunk",
  "createRunId",
  "saveProgress",
  "LOG",
  "assertNotCanceled",
];

function instantiateOpenImport(overrides = {}) {
  const sent = [];
  const saved = [];
  let minted = 0;
  const deps = {
    sendImportRequest: async (type, payload, maxAttempts) => {
      sent.push({ type, payload, maxAttempts });
      const reply = overrides.replies?.[sent.length - 1];
      if (reply instanceof Error) throw reply;
      return reply ?? { import: { id: `import-${sent.length}` } };
    },
    progress: {
      clientImportKey: "checkpoint-key",
      expectedRows: 250,
      totalConnections: 250,
      ...overrides.progress,
    },
    peopleImportKeyForRun,
    runId: overrides.runId ?? "run-1",
    softSync: overrides.softSync === true,
    rowsPerChunk: 100,
    createRunId: () => `minted-key-${++minted}`,
    saveProgress: async (value) => { saved.push(value.clientImportKey); },
    LOG: () => {},
    assertNotCanceled: overrides.assertNotCanceled ?? (() => {}),
  };
  const factory = new Function(
    ...OPEN_IMPORT_FREE_VARIABLES,
    `${openImportSource}\nreturn openImport;`,
  );
  return {
    openImport: factory(...OPEN_IMPORT_FREE_VARIABLES.map((name) => deps[name])),
    progress: deps.progress,
    sent,
    saved,
  };
}

/** The 409 the server answers when a key is replayed with moved parameters. */
function keyMismatch() {
  return Object.assign(
    new Error("clientImportKey is already associated with different import parameters"),
    { status: 409 },
  );
}

test("opening an import sends the run-scoped key and the connections cursor", async () => {
  const { openImport, sent } = instantiateOpenImport();
  const created = await openImport();

  assert.equal(created.import.id, "import-1");
  assert.equal(sent.length, 1);
  const { input } = sent[0].payload;
  assert.equal(sent[0].type, "PEOPLE_IMPORT_CREATE");
  assert.equal(input.clientImportKey, "checkpoint-key:run-1");
  assert.equal(input.expectedRows, 250);
  assert.deepEqual(input.sourceCursor, {
    mode: "linkedin_network_connections",
    syncMode: "full",
    runId: "run-1",
    nextSequence: 0,
    nextOffset: 0,
    rowsPerChunk: 100,
    totalConnections: 250,
  });
});

test("a 409 retires the spent key, persists it, and opens a new import", async () => {
  const { openImport, progress, sent, saved } = instantiateOpenImport({
    replies: [keyMismatch()],
  });
  const created = await openImport();

  // The sync survives the conflict instead of failing, which is the whole point.
  assert.equal(created.import.id, "import-2");
  assert.equal(sent.length, 2);
  // The resend carries a genuinely different key, so it cannot collide with the
  // stranded import the first key was already spent on.
  assert.equal(sent[0].payload.input.clientImportKey, "checkpoint-key:run-1");
  assert.equal(sent[1].payload.input.clientImportKey, "minted-key-1:run-1");
  // Persisted before the resend, so a worker death in between still recovers.
  assert.deepEqual(saved, ["minted-key-1"]);
  assert.equal(progress.clientImportKey, "minted-key-1");
  // The chunk plan the caller just computed is untouched by the recovery.
  assert.equal(progress.expectedRows, 250);
  assert.equal(progress.totalConnections, 250);
});

test("only a 409 is treated as a spent key", async () => {
  for (const status of [400, 401, 404, 500]) {
    const failure = Object.assign(new Error(`boom ${status}`), { status });
    const { openImport, progress, sent, saved } = instantiateOpenImport({
      replies: [failure],
    });
    await assert.rejects(openImport(), /boom/);
    // No blind resend, and the key is left alone for the resume to reuse.
    assert.equal(sent.length, 1, `status ${status} should not resend`);
    assert.deepEqual(saved, [], `status ${status} should not rewrite the key`);
    assert.equal(progress.clientImportKey, "checkpoint-key");
  }
});

test("a cancel during the recovery stops it before a stray import is opened", async () => {
  const { openImport, sent } = instantiateOpenImport({
    replies: [keyMismatch()],
    assertNotCanceled: () => { throw new Error("Sync canceled"); },
  });

  await assert.rejects(openImport(), /Sync canceled/);
  assert.equal(sent.length, 1);
});

test("a key that cannot be derived is omitted rather than sent as null", () => {
  // The server takes clientImportKey as optional but rejects an explicit null,
  // so a degenerate checkpoint must lose idempotency, not fail validation.
  assert.equal(peopleImportKeyForRun("", ""), null);
  // Either half alone is still a usable key.
  assert.equal(peopleImportKeyForRun("", "run-1"), "run-1");
  assert.equal(peopleImportKeyForRun("checkpoint-key", ""), "checkpoint-key");
});

test("an import with no derivable key omits the field instead of sending null", async () => {
  const { openImport, sent } = instantiateOpenImport({
    progress: { clientImportKey: "" },
    runId: "",
  });
  await openImport();

  assert.ok(!("clientImportKey" in sent[0].payload.input));
});

test("a soft run opens its import in soft mode", async () => {
  const { openImport, sent } = instantiateOpenImport({
    softSync: true,
    runId: "run-soft",
    progress: { expectedRows: null, totalConnections: 0 },
  });
  await openImport();

  const { input } = sent[0].payload;
  // warmth/store.ts selects completed soft syncs on these exact cursor fields.
  assert.equal(input.sourceCursor.syncMode, "soft");
  assert.equal(input.sourceCursor.mode, "linkedin_network_connections");
  assert.equal(input.sourceCursor.runId, "run-soft");
  // A null expectedRows is omitted, not sent — an unknown total stays unknown.
  assert.ok(!("expectedRows" in input));
});

/**
 * The same regression on the enrichment side.
 *
 * Scoping the create key to the run left the second create untouched. Every
 * enriched batch opens an import of its own, keyed by the checkpoint, and that
 * key is just as unstable across attempts as the create key was: the rows
 * behind one (sequence, batchIndex) are re-collected from LinkedIn on each
 * attempt, soft sync re-filters them against a freshly computed set of known
 * people, and expectedRows moves with the count. Both call sites then retry the
 * key unchanged — the capture engine four times, bulk enrichment three — so the
 * 409 repeats identically and fails the sync, which is why an updated extension
 * still reported "clientImportKey is already associated with different import
 * parameters".
 */
const ENRICHMENT_UPLOAD_SOURCE = fs.readFileSync(
  path.join(HERE, "../background/enrichment-upload.js"),
  "utf8",
);

/** Exactly the openEnrichmentImport() body, bounded by the export after it. */
const openEnrichmentImportSource = (() => {
  const start = ENRICHMENT_UPLOAD_SOURCE.indexOf(
    "async function openEnrichmentImport(items, clientImportKey) {",
  );
  assert.notEqual(start, -1, "expected an openEnrichmentImport() helper");
  const end = ENRICHMENT_UPLOAD_SOURCE.indexOf("\nexport async function uploadEnrichmentBatch", start);
  assert.notEqual(end, -1, "expected it to be followed by uploadEnrichmentBatch()");
  return ENRICHMENT_UPLOAD_SOURCE.slice(start, end);
})();

function instantiateOpenEnrichmentImport(replies = []) {
  const sent = [];
  let minted = 0;
  const createPeopleImport = async (input) => {
    sent.push(input);
    const reply = replies[sent.length - 1];
    if (reply instanceof Error) throw reply;
    return reply ?? { import: { id: `import-${sent.length}`, status: "receiving" } };
  };
  const crypto = { randomUUID: () => `minted-${++minted}` };
  const factory = new Function(
    "createPeopleImport",
    "crypto",
    `${openEnrichmentImportSource}\nreturn openEnrichmentImport;`,
  );
  return { openEnrichmentImport: factory(createPeopleImport, crypto), sent };
}

test("an enrichment batch opens its import under the caller's key", async () => {
  const { openEnrichmentImport, sent } = instantiateOpenEnrichmentImport();
  const created = await openEnrichmentImport([{ a: 1 }, { a: 2 }], "batch-key");

  assert.equal(created.import.id, "import-1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].clientImportKey, "batch-key");
  assert.equal(sent[0].expectedRows, 2);
  assert.equal(sent[0].source, "linkedin");
  assert.deepEqual(sent[0].sourceCursor, { mode: "manual_enrichment", nextSequence: 0 });
});

test("a spent enrichment key falls back to a single-use one", async () => {
  const { openEnrichmentImport, sent } = instantiateOpenEnrichmentImport([keyMismatch()]);
  const created = await openEnrichmentImport([{ a: 1 }], "batch-key");

  // The batch uploads instead of taking the sync down with it.
  assert.equal(created.import.id, "import-2");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].clientImportKey, "batch-key");
  // A fresh key, so it cannot collide with the import the first one is spent on.
  assert.equal(sent[1].clientImportKey, "minted-1");
  // Same rows: only the key is retired, never what is being uploaded.
  assert.equal(sent[1].expectedRows, 1);
  assert.deepEqual(sent[1].sourceCursor, sent[0].sourceCursor);
});

test("only a 409 retires an enrichment key", async () => {
  for (const status of [400, 401, 404, 500]) {
    const failure = Object.assign(new Error(`boom ${status}`), { status });
    const { openEnrichmentImport, sent } = instantiateOpenEnrichmentImport([failure]);
    await assert.rejects(openEnrichmentImport([{ a: 1 }], "batch-key"), /boom/);
    assert.equal(sent.length, 1, `status ${status} should not resend`);
  }
});

test("a keyless enrichment batch still gets an idempotency key", async () => {
  const { openEnrichmentImport, sent } = instantiateOpenEnrichmentImport();
  await openEnrichmentImport([{ a: 1 }], null);

  assert.equal(sent[0].clientImportKey, "minted-1");
});

test("the capture engine's enrichment key is scoped to the run", () => {
  // The checkpoint key stays the durable identity the batch keys are built
  // from; only what is sent is scoped, exactly as on the create path.
  assert.match(
    CAPTURE_SOURCE,
    /clientImportKey: peopleImportKeyForRun\(\s*\n\s*enrichmentBatchKey\(progress, sequence, batchIndex\),\s*\n\s*runId,\s*\n\s*\)/,
  );
  // The unscoped key is never what gets sent.
  assert.doesNotMatch(
    CAPTURE_SOURCE,
    /clientImportKey: enrichmentBatchKey\(progress, sequence, batchIndex\)/,
  );
  // Longest realistic shape: the original key, a promoted generation suffix and
  // a uuid run id all have to survive the server's 128-character limit, or the
  // truncation drops the run id and the conflict comes straight back.
  const base = `linkedin-progressive-${"0".repeat(36)}-4096-99-g12`;
  const runId = "1".repeat(36);
  const scoped = peopleImportKeyForRun(base, runId);
  assert.ok(scoped.length <= PEOPLE_IMPORT_KEY_MAX_LENGTH);
  assert.equal(scoped, `${base}:${runId}`);
});
