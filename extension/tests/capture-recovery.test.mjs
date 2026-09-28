/**
 * The stuck-sync class.
 *
 * Every parameter the capture engine sends the import API is read from LinkedIn
 * at some moment and then persisted in a checkpoint that outlives the attempt
 * that read it. The server validates several of those against what it stored
 * the first time — an idempotency key against its import's parameters, an
 * expectedRows against the rows actually received, an importId against a status
 * that may have closed — and answers a mismatch with a 4xx.
 *
 * That failure is deterministic. The checkpoint hands the same stale value back
 * on the next attempt, the run dies at the same line, and the panel's "Try
 * again" reruns it into the same wall. Users end up permanently unable to sync,
 * and updating the extension does not help because the poison is in
 * chrome.storage, not in the code.
 *
 * Three instances of this shipped: the create key held across attempts, the
 * enrichment batch key held across attempts, and expectedRows drifting under a
 * resumed import. The tests here cover the two defences that are meant to make
 * a fourth non-fatal — the backstop that retires an import failing the same way
 * twice, and the structural rule that every import opened by this extension is
 * either scoped to one attempt or recovers from a spent key.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(HERE, relative), "utf8");
const CAPTURE_SOURCE = read("../background/linkedin-capture.js");
const ENRICHMENT_UPLOAD_SOURCE = read("../background/enrichment-upload.js");

/**
 * The backstop helpers, lifted verbatim from the shipped engine and given their
 * free variables. Asserting on the source text alone would let an inverted
 * condition ship green, and this code only ever runs for users who are already
 * stranded — the one population that cannot afford it to be wrong.
 */
const BACKSTOP_SOURCE = (() => {
  const start = CAPTURE_SOURCE.indexOf("  function sanitizeImportFailure(failure) {");
  assert.notEqual(start, -1, "expected a sanitizeImportFailure() helper");
  const end = CAPTURE_SOURCE.indexOf("\n  // ─── Token Extraction", start);
  assert.notEqual(end, -1, "expected the backstop block to end before token extraction");
  return CAPTURE_SOURCE.slice(start, end);
})();

const BACKSTOP_FREE_VARIABLES = [
  "isAuthError",
  "isNetworkError",
  "LOG",
  "createRunId",
  "ROWS_PER_CHUNK",
  "LEGACY_ROWS_PER_CHUNK",
];

const backstop = (() => {
  const exported = [
    "sanitizeImportFailure",
    "isTransientFailure",
    "recordImportFailure",
    "condemnImport",
    "retireImportIfRepeatedlyFailing",
    "resetImportCheckpoint",
    "IMPORT_FAILURE_RETIRE_THRESHOLD",
  ];
  const factory = new Function(
    ...BACKSTOP_FREE_VARIABLES,
    `${BACKSTOP_SOURCE}\nreturn { ${exported.join(", ")} };`,
  );
  let minted = 0;
  return factory(
    (error) => error?.status === 401 || error?.status === 403,
    (error) => /Failed to fetch|NetworkError|timed out/.test(error?.message || ""),
    () => {},
    () => `minted-key-${++minted}`,
    100,
    1000,
  );
})();

function checkpoint(overrides = {}) {
  return {
    importId: "import-a",
    clientImportKey: "checkpoint-key",
    importFailure: null,
    expectedRows: 250,
    totalConnections: 250,
    totalChunks: 3,
    uploadedChunks: 2,
    nextSequence: 2,
    nextOffset: 200,
    accepted: 200,
    failed: 0,
    rowsPerChunk: 100,
    pendingEnrichmentSequences: [0, 1],
    enrichmentBatchCursors: { 0: 1 },
    enrichmentBatchOutcomes: { "0:0": { enriched: 25, unavailable: 0 } },
    softSyncNewKeys: { 0: ["a"] },
    discovered: 200,
    completedAt: null,
    ...overrides,
  };
}

const fail = (message, status) => Object.assign(new Error(message), { status });

test("one failure is bad luck and leaves the import alone", () => {
  const progress = checkpoint();
  backstop.recordImportFailure(progress, fail("clientImportKey is already associated", 409));

  assert.deepEqual(progress.importFailure, {
    importId: "import-a",
    message: "clientImportKey is already associated",
    count: 1,
  });
  assert.equal(backstop.retireImportIfRepeatedlyFailing(progress), false);
  // The half-uploaded import is still the right one to resume into.
  assert.equal(progress.importId, "import-a");
  assert.equal(progress.uploadedChunks, 2);
});

test("the same failure twice retires the import and rebuilds the plan", () => {
  const progress = checkpoint();
  const error = fail("Import expected 250 rows but has received 249", 409);
  backstop.recordImportFailure(progress, error);
  backstop.recordImportFailure(progress, error);

  assert.equal(progress.importFailure.count, backstop.IMPORT_FAILURE_RETIRE_THRESHOLD);
  assert.equal(backstop.retireImportIfRepeatedlyFailing(progress), true);

  // A brand new import under a brand new key: the point is that nothing the
  // server rejected can be presented to it again.
  assert.equal(progress.importId, null);
  assert.notEqual(progress.clientImportKey, "checkpoint-key");
  assert.equal(progress.importFailure, null);
  assert.equal(progress.nextSequence, 0);
  assert.equal(progress.uploadedChunks, 0);
  assert.equal(progress.accepted, 0);
  // Enrichment bookkeeping indexes sequences of an import that is gone.
  assert.deepEqual(progress.pendingEnrichmentSequences, []);
  assert.deepEqual(progress.enrichmentBatchCursors, {});
  assert.deepEqual(progress.softSyncNewKeys, {});
});

test("two different failures are not a stuck import", () => {
  const progress = checkpoint();
  backstop.recordImportFailure(progress, fail("Import has a gap at chunk 2"));
  backstop.recordImportFailure(progress, fail("Chunk sequence already exists with a different checksum", 409));

  // The count restarts on a new signature, so unrelated one-off failures never
  // accumulate into a retirement.
  assert.equal(progress.importFailure.count, 1);
  assert.equal(backstop.retireImportIfRepeatedlyFailing(progress), false);
  assert.equal(progress.importId, "import-a");
});

test("transient failures never count against the import", () => {
  for (const error of [
    fail("Failed to fetch"),
    fail("Server error", 503),
    fail("Too many requests", 429),
    fail("Not authenticated", 401),
    fail("Forbidden", 403),
  ]) {
    const progress = checkpoint();
    backstop.recordImportFailure(progress, error);
    backstop.recordImportFailure(progress, error);
    assert.equal(
      progress.importFailure,
      null,
      `${error.message} should not count toward retiring the import`,
    );
    assert.equal(backstop.retireImportIfRepeatedlyFailing(progress), false);
    assert.equal(progress.importId, "import-a");
  }
});

test("a transient failure does not clear a count already standing", () => {
  const progress = checkpoint();
  const deterministic = fail("Import is complete and cannot accept new chunks", 409);
  backstop.recordImportFailure(progress, deterministic);
  // A dropped connection proves nothing about the import, in either direction.
  backstop.recordImportFailure(progress, fail("Failed to fetch"));
  assert.equal(progress.importFailure.count, 1);
  backstop.recordImportFailure(progress, deterministic);

  assert.equal(progress.importFailure.count, 2);
  assert.equal(backstop.retireImportIfRepeatedlyFailing(progress), true);
});

test("a signature is never inherited by the import that replaces it", () => {
  const progress = checkpoint();
  const error = fail("Import expected 250 rows but has received 249", 409);
  backstop.recordImportFailure(progress, error);
  backstop.recordImportFailure(progress, error);
  backstop.retireImportIfRepeatedlyFailing(progress);

  // Without this, the replacement import starts one failure from retirement and
  // the engine rebuilds the network on every sync forever.
  progress.importId = "import-b";
  assert.equal(backstop.retireImportIfRepeatedlyFailing(progress), false);
  backstop.recordImportFailure(progress, error);
  assert.equal(progress.importFailure.count, 1);
});

test("a stale signature naming some other import is discarded", () => {
  const progress = checkpoint({
    importFailure: { importId: "import-old", message: "boom", count: 9 },
  });

  assert.equal(backstop.retireImportIfRepeatedlyFailing(progress), false);
  assert.equal(progress.importFailure, null);
  assert.equal(progress.importId, "import-a");
});

test("a failure before an import exists has nothing to blame", () => {
  const progress = checkpoint({ importId: null });
  backstop.recordImportFailure(progress, fail("LinkedIn returned an empty first page"));

  assert.equal(progress.importFailure, null);
});

test("an import known to be unfinishable is condemned on sight", () => {
  const progress = checkpoint();
  // expectedRows is immutable server-side, so a drifted resume can never pass
  // the completion check again — no reason to make the user watch it fail twice.
  backstop.condemnImport(progress, "LinkedIn ended at 251 rows, but the import expects 250");

  assert.equal(backstop.retireImportIfRepeatedlyFailing(progress), true);
  assert.equal(progress.importId, null);
});

test("a persisted signature survives a restart but a malformed one does not", () => {
  assert.deepEqual(
    backstop.sanitizeImportFailure({ importId: "i", message: "m", count: 2, extra: "x" }),
    { importId: "i", message: "m", count: 2 },
  );
  for (const bad of [null, undefined, "nope", {}, { importId: "i" }, { importId: "i", message: "m", count: 0 }]) {
    assert.equal(backstop.sanitizeImportFailure(bad), null);
  }
  // Unbounded error text would grow chrome.storage without bound.
  const long = backstop.sanitizeImportFailure({ importId: "i", message: "x".repeat(5000), count: 1 });
  assert.equal(long.message.length, 300);
});

test("the backstop is wired into the checkpoint and the run", () => {
  // Persisted, or the count resets on every service-worker restart and the
  // threshold is never reached.
  assert.match(CAPTURE_SOURCE, /importFailure: sanitizeImportFailure\(progress\.importFailure\)/);
  assert.match(CAPTURE_SOURCE, /progress\.importFailure = sanitizeImportFailure\(progress\.importFailure\);/);
  // Recorded on the way out of a failed run, but never for a cancel — the user
  // stopping a sync says nothing about the import.
  assert.match(
    CAPTURE_SOURCE,
    /if \(!runtimeState\.cancelRequested\) recordImportFailure\(progress, error\);/,
  );
  // Retiring rebuilds the chunk plan from LinkedIn, so the run must stop
  // calling itself a resume and re-read the chunk size it now uses.
  assert.match(
    CAPTURE_SOURCE,
    /if \(retireImportIfRepeatedlyFailing\(progress\)\) \{\s*\n\s*rowsPerChunk = rowsPerChunkFor\(progress\);\s*\n\s*resumed = false;\s*\n\s*await saveProgress\(progress\);\s*\n\s*\}/,
  );
  // And it has to happen before anything resumes into the doomed import.
  assert.ok(
    CAPTURE_SOURCE.indexOf("if (retireImportIfRepeatedlyFailing(progress)) {")
      < CAPTURE_SOURCE.indexOf("resumedStatus = await statusForImport();"),
    "the backstop must run before the import is resumed into",
  );
  // A drifted resume condemns its import instead of repeating forever.
  assert.match(CAPTURE_SOURCE, /if \(resumed\) condemnImport\(progress, drift\);/);
});

/**
 * The class guard.
 *
 * Both stuck-sync bugs that reached users were an import opened under a key the
 * checkpoint kept across attempts, and the second one shipped because the fix
 * for the first was applied to one call site while another went unnoticed. So
 * the rule is enforced over the whole extension rather than over the two sites
 * that are known about: every place that can open an import server-side is
 * enumerated from the source tree, and each has to be safe by construction —
 * the key is scoped to the attempt, or a spent key is recovered from. A new
 * call site that is neither fails here instead of in somebody's browser.
 */
const EXTENSION_SOURCES = (() => {
  const root = path.join(HERE, "..");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.name.endsWith(".js")) files.push(relative);
    }
  };
  for (const dir of ["background", "lib", "popup"]) walk(dir);
  return new Map(files.map((relative) => [relative, read(`../${relative}`)]));
})();

test("nothing opens a people import except the two audited call sites", () => {
  const callers = [...EXTENSION_SOURCES]
    // api-client.js is where createPeopleImport is defined and exported.
    .filter(([relative]) => relative !== "lib/api-client.js")
    .filter(([, source]) => /\bcreatePeopleImport\(/.test(source))
    .map(([relative]) => relative)
    .sort();

  assert.deepEqual(
    callers,
    ["background/enrichment-upload.js", "background/linkedin-capture.js"],
    "a new module opens people imports; audit its key for the stuck-sync class "
    + "and add it here",
  );
});

test("the network sync opens its import in exactly one place, scoped to the attempt", () => {
  // The dispatcher is the only thing that reaches api-client, so counting sends
  // of the operation counts every import this engine can open.
  const sends = CAPTURE_SOURCE.match(/sendImportRequest\("PEOPLE_IMPORT_CREATE"/g) || [];
  assert.equal(sends.length, 1, "expected exactly one create, inside openImport()");
  assert.equal((CAPTURE_SOURCE.match(/\bcreatePeopleImport\(/g) || []).length, 1);

  const openImport = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("    async function openImport() {"),
    CAPTURE_SOURCE.indexOf("\n    function assertNotCanceled("),
  );
  assert.ok(openImport.includes('sendImportRequest("PEOPLE_IMPORT_CREATE"'), "the create must live in openImport()");
  // Scoped to the attempt...
  assert.match(openImport, /peopleImportKeyForRun\(progress\.clientImportKey, runId\)/);
  // ...and a spent key still recovers rather than failing the sync.
  assert.match(openImport, /if \(error\?\.status !== 409\) throw error;/);
  assert.match(openImport, /progress\.clientImportKey = createRunId\(\);/);
});

test("every enrichment batch is scoped to the attempt or recovers from a spent key", () => {
  const sends = CAPTURE_SOURCE.match(/sendImportRequest\("ENRICHMENT_BATCH"/g) || [];
  assert.equal(sends.length, 1, "expected exactly one progressive enrichment upload");
  // Scoped to the attempt, exactly as the create key is.
  assert.match(
    CAPTURE_SOURCE,
    /clientImportKey: peopleImportKeyForRun\(\s*\n\s*enrichmentBatchKey\(progress, sequence, batchIndex\),\s*\n\s*runId,\s*\n\s*\)/,
  );
  assert.doesNotMatch(
    CAPTURE_SOURCE,
    /clientImportKey: enrichmentBatchKey\(progress, sequence, batchIndex\)/,
  );

  // Bulk enrichment keys its batches off a checkpoint with no run id to fold
  // in, and service-worker.js forwards whatever key a message carries. Neither
  // is attempt-scoped, so both depend on the recovery in the shared helper —
  // which is where the recovery lives, so every caller inherits it.
  assert.match(
    ENRICHMENT_UPLOAD_SOURCE,
    /if \(error\?\.status !== 409\) throw error;\s*\n\s*return await open\(crypto\.randomUUID\(\)\);/,
  );
  assert.equal(
    (ENRICHMENT_UPLOAD_SOURCE.match(/\bcreatePeopleImport\(/g) || []).length,
    1,
    "every enrichment import must go through the recovering helper",
  );
});

test("the shared enrichment upload retires only a spent key, never the rows", () => {
  // The recovery must reopen with the same batch. Dropping rows here would lose
  // people silently, which is worse than the 409 it is recovering from.
  const helper = ENRICHMENT_UPLOAD_SOURCE.slice(
    ENRICHMENT_UPLOAD_SOURCE.indexOf("async function openEnrichmentImport"),
  ).slice(0, 900);
  assert.match(helper, /const open = \(key\) => createPeopleImport\(\{/);
  assert.match(helper, /expectedRows: items\.length/);
  // One definition of the request, so the retry cannot drift from the original.
  assert.equal(helper.match(/createPeopleImport\(/g).length, 1);
});
