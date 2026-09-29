/**
 * Bulk enrich: a pasted list of LinkedIn profile URLs, enriched from LinkedIn
 * and written into Airtable in small batches.
 *
 * The job lives in chrome.storage and advances one batch at a time, so a
 * worker killed halfway resumes at the next unwritten batch rather than
 * starting over or losing the list. Progress goes to `enrich_progress`, which
 * the side panel already renders.
 */

import { captureProfiles } from "../lib/api-client.js";
import { prefetchLinkedDetails } from "../lib/airtable-sink.js";
import { canonicalLinkedinUrl } from "../lib/airtable-fields.js";
import { setEnrichProgress } from "./capture-state.js";
import { enrichProfileUrls } from "./linkedin-graph.js";

const LOG = (...args) => console.log("[BulkEnrich]", ...args);

export const BULK_JOB_KEY = "bulk_enrich_job";
export const BULK_MAX_URLS = 2_000;
// A whole table is read, not pasted, so it can be bigger.
export const TABLE_MAX_URLS = 10_000;
const BATCH_SIZE = 10;
// Between batches, on top of the enricher's own pacing inside a batch.
const BATCH_PAUSE_MS = [500, 1_500];
// A signed-out or blocked session fails every profile without an error of its
// own. Two whole batches with nothing back is that, not bad luck.
const EMPTY_BATCHES_BEFORE_PAUSE = 2;

let running = false;
let cancelRequested = false;
let settledHook = async () => {};

export function isBulkEnrichRunning() {
  return running;
}

export function onBulkEnrichSettled(hook) {
  if (typeof hook === "function") settledHook = hook;
}

/** Profile URLs from free text: one per line, commas, or mixed in with other text. */
export function parseProfileUrls(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[\s,;]+/);
  const seen = new Set();
  const urls = [];
  for (const value of values) {
    const url = canonicalLinkedinUrl(String(value || "").trim());
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

export async function readBulkJob() {
  const stored = await chrome.storage.local.get(BULK_JOB_KEY);
  return stored[BULK_JOB_KEY] || null;
}

async function saveJob(job) {
  await chrome.storage.local.set({ [BULK_JOB_KEY]: { ...job, updatedAt: Date.now() } });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A wait that ends early on Stop. */
async function pause(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until && !cancelRequested) await sleep(Math.min(250, until - Date.now()));
}

/** A job that can't be resumed keeps its counts, not the pasted list of people. */
function done(job) {
  return { ...job, total: job.urls.length, urls: [], failedUrls: [] };
}

async function stopped() {
  return cancelRequested || (await readBulkJob())?.status === "canceled";
}

function summary(job) {
  const parts = [
    job.created ? `${job.created.toLocaleString()} added` : "",
    job.updated ? `${job.updated.toLocaleString()} updated` : "",
    job.unchanged ? `${job.unchanged.toLocaleString()} already current` : "",
    job.failed ? `${job.failed.toLocaleString()} not found` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "Nothing to write";
}

async function publish(job, patch = {}) {
  await setEnrichProgress({
    status: "in_progress",
    enrichedCount: job.next,
    totalConnections: job.urls.length,
    currentName: job.lastName || null,
    message: `Enriching ${Math.min(job.next + 1, job.urls.length).toLocaleString()} of ${job.urls.length.toLocaleString()}`
      + (job.lastName ? ` · ${job.lastName}` : ""),
    bulk: true,
    ...patch,
  });
}

/** Start a new job over `input` (text or an array of URLs). */
export async function startBulkEnrich(input, { source = "Bulk enrich", maxUrls = BULK_MAX_URLS } = {}) {
  if (running) return { error: "A bulk enrich is already running." };
  const urls = parseProfileUrls(input);
  if (urls.length === 0) return { error: "No LinkedIn profile URLs found. They look like linkedin.com/in/…" };
  if (urls.length > maxUrls) {
    return { error: `That's ${urls.length.toLocaleString()} profiles; enrich at most ${maxUrls.toLocaleString()} at a time.` };
  }
  cancelRequested = false;
  const job = {
    id: crypto.randomUUID(),
    source,
    urls,
    next: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    failedUrls: [],
    emptyBatches: 0,
    emptyFrom: null,
    status: "running",
    error: null,
    startedAt: Date.now(),
  };
  await saveJob(job);
  void runJob();
  return { started: true, total: urls.length };
}

/** Pick a paused, failed, or interrupted job back up where it stopped. */
export async function resumeBulkEnrich() {
  if (running) return { started: true, alreadyRunning: true };
  const job = await readBulkJob();
  if (!job || job.status === "complete" || job.status === "canceled") return { resumed: false };
  if (job.next >= job.urls.length) return { resumed: false };
  cancelRequested = false;
  await saveJob({ ...job, status: "running", error: null, emptyBatches: 0 });
  void runJob();
  return { started: true, resumed: true, remaining: job.urls.length - job.next };
}

export async function cancelBulkEnrich() {
  cancelRequested = true;
  // Stored at once, so a worker that dies before the loop notices can't resume it.
  const job = await readBulkJob();
  // A paused job ("error") is only ended by Stop while it's the thing running;
  // Stop pressed on some other capture leaves it resumable.
  if (job?.status === "running" || (job?.status === "error" && running)) await saveJob({ ...done(job), status: "canceled" });
}

async function runJob() {
  if (running) return;
  running = true;
  let job = await readBulkJob();
  // While one batch writes to Airtable, the next is read from LinkedIn: its
  // profiles, then the companies its write would ask about. LinkedIn still
  // sees one paced stream; only the Airtable time is overlapped.
  let cursor = job?.next ?? 0;
  let emptyBatches = job?.emptyBatches ?? 0;
  let emptyFrom = job?.emptyFrom ?? null;
  let writing = null;
  const land = async () => {
    if (!writing) return;
    const batch = writing;
    writing = null;
    const tally = batch.profiles.length ? await batch.write : null;
    job = {
      ...job,
      emptyFrom: batch.emptyFrom,
      next: batch.end,
      created: job.created + (tally?.created || 0),
      updated: job.updated + (tally?.updated || 0),
      unchanged: job.unchanged + (tally?.unchanged || 0),
      failed: job.failed + batch.failedUrls.length + (tally?.failed || 0),
      failedUrls: [...job.failedUrls, ...batch.failedUrls].slice(-500),
      emptyBatches: batch.emptyBatches,
      lastName: batch.profiles.at(-1)?.name || job.lastName || null,
    };
    // Stopped meanwhile: the caller stores it as canceled; saving it as running could resume it.
    if (await stopped()) return;
    await saveJob(job);
    await publish(job);
  };
  try {
    await publish(job);
    const cancel = async () => {
      job = { ...done(job), status: "canceled" };
      await saveJob(job);
      await setEnrichProgress({ status: "canceled" });
    };
    // Stopped: what was already sent to Airtable is kept, and the job stays stopped.
    const landThenCancel = async () => {
      await land().catch(() => {});
      return cancel();
    };
    while (cursor < job.urls.length) {
      if (await stopped()) return landThenCancel();
      const batch = job.urls.slice(cursor, cursor + BATCH_SIZE);
      const enriched = await enrichProfileUrls(batch);
      const profiles = Array.isArray(enriched?.profiles) ? enriched.profiles : [];
      const failedUrls = Array.isArray(enriched?.failedUrls) ? enriched.failedUrls : [];
      emptyBatches = profiles.length === 0 ? emptyBatches + 1 : 0;
      if (emptyBatches >= EMPTY_BATCHES_BEFORE_PAUSE) {
        await land();
        // Every empty batch in the run was the session, not those people:
        // rewind to the first of them so resuming retries all of it.
        const from = emptyFrom ?? job.next;
        const rewound = job.urls.slice(from, job.next);
        job = {
          ...job,
          next: from,
          failed: Math.max(0, job.failed - rewound.length),
          failedUrls: job.failedUrls.filter((url) => !rewound.includes(url)),
          status: "error",
          emptyBatches: 0,
          emptyFrom: null,
          error: "LinkedIn returned none of the last profiles. Check you're signed in to linkedin.com, then resume.",
        };
        await saveJob(job);
        await setEnrichProgress({ status: "error", message: job.error, bulk: true });
        return;
      }
      emptyFrom = profiles.length ? null : emptyFrom ?? cursor;
      if (profiles.length) await prefetchLinkedDetails(profiles).catch(() => {});
      const fetchedAt = Date.now();
      await land();
      if (await stopped()) return cancel();
      const write = profiles.length ? captureProfiles(profiles, { source: job.source || "Bulk enrich" }) : null;
      // Awaited in land(); until then a failure mustn't read as unhandled.
      write?.catch(() => {});
      writing = { end: cursor + batch.length, profiles, failedUrls, emptyBatches, emptyFrom, write };
      cursor += batch.length;
      if (cursor < job.urls.length) {
        // Time spent writing to Airtable counts toward LinkedIn's rest.
        await pause(BATCH_PAUSE_MS[0] + Math.random() * (BATCH_PAUSE_MS[1] - BATCH_PAUSE_MS[0]) - (Date.now() - fetchedAt));
      }
    }
    await land();
    if (await stopped()) return cancel();
    job = { ...job, status: "complete", completedAt: Date.now() };
    await saveJob(done(job));
    await setEnrichProgress({
      status: "complete",
      enrichedCount: job.urls.length,
      totalConnections: job.urls.length,
      message: summary(job),
      bulk: true,
    });
    LOG(`Done: ${summary(job)}`);
  } catch (error) {
    // A write still in flight lands first, so the counts and the resume point include it.
    if (writing) await land().catch(() => {});
    const message = error?.message || String(error);
    LOG("Stopped:", message);
    if (cancelRequested && job?.urls) {
      // Stopped mid-batch: the abort surfaces as an error, but the user asked for this.
      await saveJob({ ...done(job), status: "canceled" });
      await setEnrichProgress({ status: "canceled" });
      return;
    }
    job = { ...(job || {}), status: "error", error: message };
    if (job.urls) await saveJob(job);
    await setEnrichProgress({ status: "error", message, bulk: true });
  } finally {
    running = false;
    try { await settledHook(); } catch { /* cosmetic */ }
  }
}
