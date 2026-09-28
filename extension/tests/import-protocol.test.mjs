import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LINKEDIN_CHUNK_SIZE,
  blockSequenceForOffset,
  canonicalJson,
  classifyRetry,
  computeBackoffMs,
  orderBlockPages,
  pageOffsetsForBlock,
  parseRetryAfter,
  PEOPLE_IMPORT_KEY_MAX_LENGTH,
  peopleImportKeyForRun,
  planResumeSequences,
  sha256CanonicalRows,
} from "../lib/import-protocol.js";

/** The alphabet the backend accepts for a clientImportKey (people-api.ts). */
const SERVER_KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const CONTRACT_ROWS = [
  { z: 1, a: { y: 2, x: "é" }, omitted: undefined },
  [3, undefined, { b: false, a: null }],
];

// The LinkedIn engines moved out of content-scripts and into the service
// worker (no tab is opened for a sync any more). The capture and graph logic
// they assert on is unchanged; only the host boundary moved.
const LINKEDIN_SOURCE = readFileSync(
  new URL("../background/linkedin-capture.js", import.meta.url),
  "utf8",
);
const LINKEDIN_MUTUALS_SOURCE = readFileSync(
  new URL("../background/linkedin-graph.js", import.meta.url),
  "utf8",
);

test("canonical JSON matches backend ordering and undefined semantics", () => {
  assert.equal(
    canonicalJson(CONTRACT_ROWS),
    ' [{"a":{"x":"é","y":2},"z":1},[3,null,{"a":null,"b":false}]]'.trim(),
  );
});

test("sha256-canonical-json-v1 fixture is stable", async () => {
  assert.equal(
    await sha256CanonicalRows(CONTRACT_ROWS),
    "b822d1dc4e4a777b24c8a82c7040564b2a388c21a38e63a545f3e33bec701b31",
  );
});

test("retry classification and bounded backoff preserve status semantics", () => {
  assert.equal(classifyRetry(429, "chunk"), "retryable");
  assert.equal(classifyRetry(503, "chunk"), "retryable");
  assert.equal(classifyRetry(409, "chunk"), "conflict");
  assert.equal(classifyRetry(409, "complete"), "status_required");
  assert.equal(classifyRetry(401, "chunk"), "auth");
  assert.equal(classifyRetry(400, "chunk"), "hard");
  assert.equal(computeBackoffMs(4, { baseMs: 1_000, maxMs: 10_000, jitterRatio: 0, random: () => 0 }), 10_000);
  assert.equal(computeBackoffMs(0, { retryAfterMs: 250_000 }), 120_000);
  assert.equal(parseRetryAfter("2.5"), 2_500);
});

test("block sequences, page ordering, and resume holes are deterministic", () => {
  assert.equal(LINKEDIN_CHUNK_SIZE, 100);
  assert.equal(blockSequenceForOffset(199), 1);
  assert.deepEqual(pageOffsetsForBlock(1, 225), [100]);
  assert.deepEqual(pageOffsetsForBlock(2, 225), [200]);
  assert.deepEqual(orderBlockPages([
    { offset: 200, rows: ["c", "d"] },
    { offset: 0, rows: ["a", "b"] },
    { offset: 100, rows: ["x"] },
  ]), ["a", "b", "x", "c", "d"]);
  assert.deepEqual(
    planResumeSequences({ nextExpectedSequence: 3, receivedSequences: [3, 5] }, 7).pending,
    [4, 6],
  );
  assert.deepEqual(
    planResumeSequences({ nextExpectedSequence: 6, receivedSequences: [6, 8] }, 10).pending,
    [7, 9],
  );
});

test("LinkedIn pagination uses raw observations and adapts concurrency between one and eight", () => {
  assert.match(LINKEDIN_SOURCE, /page\.parsed\.rawCount < CONNECTIONS_PER_PAGE/);
  assert.doesNotMatch(LINKEDIN_SOURCE, /page\.parsed\.connections\.length < CONNECTIONS_PER_PAGE/);
  assert.match(
    LINKEDIN_SOURCE,
    /Math\.max\(MIN_PAGE_CONCURRENCY, Math\.floor\(adaptive\.pageConcurrency \/ 2\)\)/,
  );
  assert.match(LINKEDIN_SOURCE, /pendingOffsets\.unshift\(\.\.\.throttledOffsets\)/);
  assert.match(LINKEDIN_SOURCE, /phase: "fetch_cooldown"/);
  assert.match(LINKEDIN_SOURCE, /connection = connection \|\| invalidConnectionObservation/);
  assert.match(LINKEDIN_SOURCE, /connectedDate && !Number\.isNaN\(connectedDate\.getTime\(\)\)/);
});

test("a checkpoint whose import is gone starts over instead of failing forever", () => {
  // Deleting an EarthOS account and signing back in with the same login
  // rebuilds the same workspace id with none of the old rows. The extension
  // still holds a checkpoint naming an import the server no longer has, and a
  // 404 is classified "hard" — so without this the resume fails on every
  // attempt and the user can never sync again.
  assert.match(LINKEDIN_SOURCE, /resumedStatus = await statusForImport\(\)/);
  assert.match(LINKEDIN_SOURCE, /if \(error\?\.status !== 404\) throw error/);
  assert.match(
    LINKEDIN_SOURCE,
    /resetImportCheckpoint\(progress, \{ freshWorkspace: true \}\)/,
  );
  // The probe replaces the resume's status read rather than adding one.
  assert.match(LINKEDIN_SOURCE, /let status = resumedStatus \?\? await statusForImport\(\)/);
  assert.equal(classifyRetry(404, "chunk"), "hard");
  // A fresh workspace also drops the enrichment queue (those sequences
  // described rows that no longer exist) and any legacy chunk size, which only
  // ever existed to finish an import opened under it.
  assert.match(LINKEDIN_SOURCE, /if \(!freshWorkspace\) return;/);
  assert.match(LINKEDIN_SOURCE, /progress\.rowsPerChunk = ROWS_PER_CHUNK;/);
  assert.match(LINKEDIN_SOURCE, /progress\.pendingEnrichmentSequences = \[\];/);
  assert.match(LINKEDIN_SOURCE, /rowsPerChunk = rowsPerChunkFor\(progress\);\s*\n\s*resumed = false;/);
});

test("LinkedIn capture makes each base page durable before progressive enrichment", () => {
  assert.match(LINKEDIN_SOURCE, /async function enrichConnectionBlock/);
  assert.match(LINKEDIN_SOURCE, /const ROWS_PER_CHUNK = 100/);
  assert.match(LINKEDIN_SOURCE, /const ENRICH_UPLOAD_BATCH_SIZE = 25/);
  assert.match(LINKEDIN_SOURCE, /await enqueueChunk\(sequence, rowsWithInteractionSnapshot\(block\.rows, interactionSnapshot\)\)/);
  const baseUploadIndex = LINKEDIN_SOURCE.indexOf("await enqueueChunk(sequence, rowsWithInteractionSnapshot(block.rows, interactionSnapshot))");
  // The drain now runs alongside the base pass instead of after it, so "durable
  // first" is enforced by a watermark rather than by the two being sequential:
  // the drain may only take a sequence the server has already acknowledged.
  assert.match(
    LINKEDIN_SOURCE,
    /baseSettledThrough = Math\.max\(baseSettledThrough, sequence\)/,
  );
  assert.match(
    LINKEDIN_SOURCE,
    /if \(!baseCapturePaging \|\| sequence < baseSettledThrough\) return sequence/,
  );
  // And the run still cannot finish with enrichment outstanding.
  const drainJoinIndex = LINKEDIN_SOURCE.indexOf("await enrichmentDrain;");
  const completeIndex = LINKEDIN_SOURCE.indexOf('sendImportRequest("PEOPLE_IMPORT_COMPLETE"', drainJoinIndex);
  assert.ok(baseUploadIndex >= 0 && baseUploadIndex < drainJoinIndex);
  assert.ok(drainJoinIndex > 0 && drainJoinIndex < completeIndex);
  assert.match(LINKEDIN_SOURCE, /pendingEnrichmentSequences/);
  assert.match(LINKEDIN_SOURCE, /enrichmentBatchCursors/);
  assert.match(LINKEDIN_SOURCE, /sendImportRequest\("ENRICHMENT_BATCH"/);
  assert.match(LINKEDIN_SOURCE, /linkedin-progressive-/);
  assert.match(LINKEDIN_SOURCE, /FullProfileWithEntities-93/);
  assert.match(LINKEDIN_SOURCE, /_earthosEnrichment: \{ status: "complete"/);
});

test("LinkedIn profile throttling retries only failed profiles and recovers adaptively", () => {
  assert.match(LINKEDIN_SOURCE, /retryRateLimit: false/);
  assert.match(LINKEDIN_SOURCE, /pending\.unshift\(\.\.\.throttledItems\.splice\(0\)\)/);
  assert.match(LINKEDIN_SOURCE, /ENRICH_MIN_PARALLEL = 1/);
  assert.match(LINKEDIN_SOURCE, /applyProfileThrottle\(adaptive, serverDelayMs\)/);
  assert.match(LINKEDIN_SOURCE, /recordCleanProfiles\(adaptive, cleanSinceRecoveryCheck\)/);
  assert.match(LINKEDIN_SOURCE, /profileAdaptive: sanitizeProfileAdaptive\(progress\.profileAdaptive\)/);
  assert.doesNotMatch(LINKEDIN_SOURCE, /rateLimitRetries > 5/);
  assert.doesNotMatch(LINKEDIN_SOURCE, /never upgrades/);
});

test("LinkedIn connection-list descriptions are captured as bio, not role/company headlines", () => {
  assert.match(LINKEDIN_SOURCE, /const bio = profile\.headline \|\| member\.headline \|\| ""/);
  assert.match(LINKEDIN_SOURCE, /return \{ name, bio, linkedinUrl, externalId, memberId, photoUrl \}/);
  assert.doesNotMatch(LINKEDIN_SOURCE, /return \{ name, headline, linkedinUrl/);
});

test("restricted LinkedIn connections retain stable member identities instead of failing", () => {
  assert.match(LINKEDIN_SOURCE, /normalizedMemberExternalId/);
  assert.match(LINKEDIN_SOURCE, /_captureIncomplete: true/);
  assert.match(LINKEDIN_SOURCE, /memberIdFor\(item\) === referencedMemberId/);
});

test("an import with MISSING rows retries, but row-level rejections complete with a warning", () => {
  // Genuinely missing rows (chunks that never arrived) still force a fresh retry.
  assert.match(LINKEDIN_SOURCE, /if \(accepted \+ failed < expected\)/);
  assert.match(LINKEDIN_SOURCE, /were received.*missing/);
  assert.match(LINKEDIN_SOURCE, /progress\.importId = null/);
  // But when every connection is accounted for and only some rows failed
  // validation (permanent, e.g. an unusual profile id), the sync completes with
  // a non-fatal warning instead of looping on an unrecoverable "retry".
  assert.match(LINKEDIN_SOURCE, /const skippedWarning = failed > 0/);
  assert.match(LINKEDIN_SOURCE, /warning: skippedWarning/);
  assert.doesNotMatch(LINKEDIN_SOURCE, /if \(failed > 0 \|\| accepted < expected\)/);
});

test("LinkedIn detailed capture preserves person photos and current-company logos", () => {
  assert.match(LINKEDIN_SOURCE, /profile\.profilePictureDisplayImage/);
  assert.match(LINKEDIN_SOURCE, /companyLogoUrl: extractCompanyLogoUrl\(entity\)/);
  assert.match(LINKEDIN_SOURCE, /companyPhotoUrl: parsed\.companyPhotoUrl/);
  assert.match(LINKEDIN_SOURCE, /companyLogosByUrn/);
});

test("LinkedIn detailed capture preserves educational institution logos", () => {
  assert.match(LINKEDIN_SOURCE, /schoolLogoUrl: extractSchoolLogoUrl\(entity\)/);
  assert.match(LINKEDIN_SOURCE, /schoolLogosByUrn/);
  assert.match(LINKEDIN_SOURCE, /schoolLogosByName/);
  assert.match(LINKEDIN_MUTUALS_SOURCE, /schoolLogoUrl: extractSchoolLogoUrl\(entity\)/);
  assert.match(LINKEDIN_MUTUALS_SOURCE, /schoolLogosByUrn/);
  assert.match(LINKEDIN_MUTUALS_SOURCE, /schoolLogosByName/);
});

test("a slower auxiliary progress write cannot resurrect a completed task", async () => {
  const previousChrome = globalThis.chrome;
  const store = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: store.get(key) };
        },
        async set(values) {
          const progress = values.enrich_progress;
          if (progress?.status === "in_progress") {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          for (const [key, value] of Object.entries(values)) store.set(key, value);
        },
      },
    },
  };
  try {
    const { setEnrichProgress } = await import("../background/capture-state.js");
    const older = setEnrichProgress({ status: "in_progress", current: 1 });
    const terminal = setEnrichProgress({ status: "complete", current: 2 });
    await Promise.all([older, terminal]);
    assert.deepEqual(store.get("enrich_progress"), { status: "complete", current: 2 });
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test("an import key belongs to one attempt, so a later attempt can never replay it", () => {
  const base = "3f1c0d6e-0000-4000-8000-000000000001";
  const first = peopleImportKeyForRun(base, "run-a");
  const second = peopleImportKeyForRun(base, "run-b");

  // Same checkpoint, different run: different key, so the second attempt opens
  // its own import instead of colliding with the stranded first one.
  assert.notEqual(first, second);
  // Same run: the byte-identical transport retry inside one send still dedupes,
  // which is the only replay the key is actually there to serve.
  assert.equal(peopleImportKeyForRun(base, "run-a"), first);
  // The checkpoint half stays legible in the key, so a stranded import can be
  // traced back to the run that opened it.
  assert.ok(first.startsWith(`${base}:`));
});

test("a derived import key is always one the server will accept", () => {
  // Run ids reach the engine from the worker's restart paths and from the app,
  // and their alphabet is wider than the key's: an underscore or a leading dash
  // would be a 400, which is a worse failure than the 409 being fixed.
  for (const [baseKey, runId] of [
    ["3f1c0d6e-0000-4000-8000-000000000001", "run_interrupted_1"],
    ["li-1730000000000-9ab3", "-leading-dash"],
    ["key", "a run id with spaces"],
    ["key", "emoji-🙂-run"],
    ["_leading-underscore", "run-1"],
    ["key", "x".repeat(400)],
    ["b".repeat(400), "run-1"],
  ]) {
    const key = peopleImportKeyForRun(baseKey, runId);
    assert.match(key, SERVER_KEY_SHAPE, `rejected shape for ${baseKey} / ${runId}`);
    assert.ok(key.length <= PEOPLE_IMPORT_KEY_MAX_LENGTH, `too long for ${baseKey} / ${runId}`);
  }
  // Truncation eats the run half, never the checkpoint half that identifies it.
  const long = peopleImportKeyForRun("base-key", "x".repeat(400));
  assert.ok(long.startsWith("base-key:"));
});
