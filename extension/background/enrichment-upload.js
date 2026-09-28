/**
 * Enriched-profile batch upload.
 *
 * Moved out of service-worker.js unchanged so the LinkedIn capture engine can
 * call it directly instead of routing an ENRICHMENT_BATCH runtime message back
 * into the worker it already runs in.
 */

import {
  completePeopleImport,
  createPeopleImport,
  getPeopleImportStatus,
  putPeopleImportChunk,
} from "../lib/api-client.js";

const LINKEDIN_COMPAT_CHUNK_SIZE = 1_000;
const LINKEDIN_COMPAT_UPLOAD_CONCURRENCY = 3;

/**
 * Open the import one batch uploads into.
 *
 * clientImportKey is an idempotency key, and the server answers 409 the moment
 * a replay presents it with any material parameter moved — expectedRows above
 * all. Every caller derives its key from a checkpoint that outlives a single
 * attempt, while the batch that key covers is re-collected from LinkedIn on
 * each attempt: a resumed run re-enriches the page, soft sync filters it
 * against a freshly computed set of known people, and the row count moves. So
 * a key can arrive already spent under a different count, and because both
 * callers retry it unchanged, that 409 is deterministic — it fails the same
 * way forever and takes the whole sync down with it.
 *
 * A spent key is not a failure, it only means this batch cannot be deduplicated
 * against the earlier import, so fall back to a single-use key. Rows upsert by
 * person, so re-uploading them under a fresh import cannot duplicate anybody.
 */
async function openEnrichmentImport(items, clientImportKey) {
  const open = (key) => createPeopleImport({
    source: "linkedin",
    expectedRows: items.length,
    clientImportKey: key,
    sourceCursor: { mode: "manual_enrichment", nextSequence: 0 },
  });
  try {
    return await open(clientImportKey || crypto.randomUUID());
  } catch (error) {
    if (error?.status !== 409) throw error;
    return await open(crypto.randomUUID());
  }
}

export async function uploadEnrichmentBatch(items, clientImportKey) {
  if (!Array.isArray(items)) throw new Error("Enrichment batch must be an array");
  const created = await openEnrichmentImport(items, clientImportKey);
  const importId = created.import.id;
  if (created.import.status === "complete") {
    return {
      success: true,
      replayed: true,
      importId,
      total: items.length,
      processed: created.import.accepted + created.import.failed,
      chunks: created.import.chunks,
      accepted: created.import.accepted,
      created: created.import.created,
      updated: created.import.updated,
      unchanged: created.import.unchanged,
      failed: created.import.failed,
      import: created.import,
    };
  }
  const totalChunks = Math.ceil(items.length / LINKEDIN_COMPAT_CHUNK_SIZE);
  let nextSequence = 0;
  let processed = 0;
  const aggregate = { accepted: 0, created: 0, updated: 0, unchanged: 0, failed: 0 };

  async function worker() {
    while (nextSequence < totalChunks) {
      const sequence = nextSequence++;
      const rows = items.slice(
        sequence * LINKEDIN_COMPAT_CHUNK_SIZE,
        (sequence + 1) * LINKEDIN_COMPAT_CHUNK_SIZE,
      );
      const response = await putPeopleImportChunk(importId, sequence, rows, {
        sourceCursor: { mode: "manual_enrichment", nextSequence: sequence + 1, totalChunks },
      });
      const chunk = response.chunk;
      processed += chunk.rowCount;
      for (const key of Object.keys(aggregate)) aggregate[key] += chunk[key] || 0;
      // The caller reports the end-to-end stage only after this durable chunk
      // acknowledgement. Keeping that single owner avoids resetting an overall
      // capture to this 25-row sub-batch.
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(LINKEDIN_COMPAT_UPLOAD_CONCURRENCY, totalChunks) },
    () => worker(),
  ));
  const status = await getPeopleImportStatus(importId);
  if (status.nextExpectedSequence !== totalChunks) {
    throw new Error(`Import is incomplete at sequence ${status.nextExpectedSequence}`);
  }
  const completed = await completePeopleImport(importId, {
    mode: "manual_enrichment",
    totalChunks,
    totalRows: items.length,
  });
  return {
    success: true,
    importId,
    total: items.length,
    processed,
    chunks: totalChunks,
    ...aggregate,
    import: completed.import,
  };
}
