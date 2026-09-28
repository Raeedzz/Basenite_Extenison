/**
 * Durable capture state, shared by the message router and the LinkedIn engine.
 *
 * This used to live inside service-worker.js and was reachable only by sending
 * a runtime message from a content script. Now that the LinkedIn engine runs
 * inside the worker itself there is no message hop: the engine imports these
 * functions and calls them directly. The side panel reads the stored shapes.
 */

const LOG = (...args) => console.log("[EarthOS:Heart:BG]", ...args);

export const LINKEDIN_CAPTURE_LOCK_KEY = "earthos_linkedin_capture_lock";
export const LINKEDIN_CAPTURE_LOCK_MAX_AGE_MS = 5 * 60 * 1000;

let linkedinCaptureClaimQueue = Promise.resolve();
let captureProgressQueue = Promise.resolve();
let auxiliaryProgressQueue = Promise.resolve();
const terminalCaptureRuns = new Set();

/**
 * A run being started again under its own id (a resume, or a sync adopting it)
 * reports progress again, even after an earlier "error" for it closed it.
 */
export function reopenCaptureRun(runId) {
  if (runId) terminalCaptureRuns.delete(runId);
}

// ─── LinkedIn capture lock ───────────────────────────────────────────────────
//
// Only one capture run may own the import at a time. The lock outlived its
// original purpose (arbitrating between two LinkedIn tabs) but is still what
// lets a killed service worker recognise an interrupted run on restart, so it
// stays: `updatedAt` is the heartbeat that separates "running" from "stalled".

export function queueLinkedInCaptureLock(operation) {
  const task = linkedinCaptureClaimQueue.then(operation);
  linkedinCaptureClaimQueue = task.catch(() => {});
  return task;
}

export function claimLinkedInCapture(runId) {
  return queueLinkedInCaptureLock(async () => {
    if (!runId) return { claimed: false, error: "Missing capture run ID" };
    const stored = await chrome.storage.local.get(LINKEDIN_CAPTURE_LOCK_KEY);
    const current = stored[LINKEDIN_CAPTURE_LOCK_KEY];
    const fresh = current?.runId
      && Date.now() - Number(current.updatedAt || 0) < LINKEDIN_CAPTURE_LOCK_MAX_AGE_MS;
    if (fresh && current.runId !== runId) {
      return { claimed: false, runId: current.runId };
    }
    await chrome.storage.local.set({
      [LINKEDIN_CAPTURE_LOCK_KEY]: { runId, updatedAt: Date.now() },
    });
    return { claimed: true, runId };
  });
}

export function touchLinkedInCapture(runId) {
  return queueLinkedInCaptureLock(async () => {
    if (!runId) return;
    const stored = await chrome.storage.local.get(LINKEDIN_CAPTURE_LOCK_KEY);
    const current = stored[LINKEDIN_CAPTURE_LOCK_KEY];
    if (current?.runId !== runId) return;
    await chrome.storage.local.set({
      [LINKEDIN_CAPTURE_LOCK_KEY]: { ...current, updatedAt: Date.now() },
    });
  });
}

export function releaseLinkedInCapture(runId) {
  return queueLinkedInCaptureLock(async () => {
    if (!runId) return { released: false };
    const stored = await chrome.storage.local.get(LINKEDIN_CAPTURE_LOCK_KEY);
    const current = stored[LINKEDIN_CAPTURE_LOCK_KEY];
    if (current?.runId !== runId) return { released: false };
    await chrome.storage.local.remove(LINKEDIN_CAPTURE_LOCK_KEY);
    return { released: true };
  });
}

export async function readLinkedInCaptureLock() {
  const stored = await chrome.storage.local.get(LINKEDIN_CAPTURE_LOCK_KEY);
  return stored[LINKEDIN_CAPTURE_LOCK_KEY] || null;
}

// ─── Progress tracking ───────────────────────────────────────────────────────

async function performProgressUpdate(progress) {
  const stored = await chrome.storage.local.get("capture_progress");
  const previous = stored.capture_progress;
  const effectiveRunId = progress.runId || (
    previous?.site === progress.site && !["complete", "error", "canceled"].includes(previous?.status)
      ? previous.runId || null
      : null
  );
  progress = { ...progress, runId: effectiveRunId };
  if (progress.runId && terminalCaptureRuns.has(progress.runId)
      && !["complete", "error", "canceled"].includes(progress.status)) {
    return;
  }
  if (progress.runId && ["complete", "error", "canceled"].includes(progress.status)) {
    terminalCaptureRuns.add(progress.runId);
    // Run IDs are unique; bound retained tombstones for long-lived workers.
    if (terminalCaptureRuns.size > 100) terminalCaptureRuns.delete(terminalCaptureRuns.values().next().value);
  }
  const sameRun = Boolean(progress.runId && previous?.runId === progress.runId);
  const phase = progress.phase || (
    progress.status === "starting" ? "starting"
      : progress.status === "complete" ? "complete"
        : progress.status === "error" ? "error"
          : progress.status === "canceled" ? "canceled"
            : progress.status === "uploading" ? "saving"
              : "capturing"
  );
  const requestedCurrent = Math.max(0, Number(progress.current) || 0);
  const previousSaved = sameRun ? Math.max(0, Number(previous.saved) || 0) : 0;
  // Only a total somebody actually reported. Clamping up to `current` reads as
  // a guard against "1,100 of 1,000", but it is how an unknown total became a
  // fake one: LinkedIn does not always say how many connections there are, the
  // capture engine then sends total 0, and this turned every such run into
  // "1,000 of 1,000" — a full bar, at 100%, while the next page was still
  // loading. Both surfaces already draw an unknown total honestly, a swept bar
  // beside a bare "1,000 found"; they were just never given the chance.
  //
  // Carried across a run so one message that omits the total cannot drop a
  // determinate bar back to a sweep, and still clamped to the count once a
  // real total exists, because a denominator behind its own numerator is the
  // other way to print nonsense.
  const previousTotal = sameRun ? Math.max(0, Number(previous.total) || 0) : 0;
  const reportedTotal = Math.max(previousTotal, Math.max(0, Number(progress.total) || 0));
  const total = reportedTotal > 0 ? Math.max(requestedCurrent, reportedTotal) : 0;
  const previousEnriched = sameRun ? Math.max(0, Number(previous.enriched) || 0) : 0;
  const previousDiscovered = sameRun ? Math.max(0, Number(previous.discovered) || 0) : 0;
  const savedCandidate = Number.isFinite(Number(progress.saved))
    ? Number(progress.saved)
    : (["saving", "complete"].includes(phase) ? requestedCurrent : previousSaved);
  const enrichedCandidate = Number.isFinite(Number(progress.enriched))
    ? Number(progress.enriched)
    : (phase === "enriching" ? requestedCurrent : previousEnriched);
  const discoveredCandidate = Number.isFinite(Number(progress.discovered))
    ? Number(progress.discovered)
    : (phase === "capturing" ? requestedCurrent : previousDiscovered);
  const saved = Math.max(previousSaved, Math.max(0, savedCandidate));
  const enriched = Math.max(previousEnriched, Math.max(0, enrichedCandidate));
  const discovered = Math.max(previousDiscovered, Math.max(0, discoveredCandidate), saved);
  const revision = Math.max(Date.now(), sameRun ? (Number(previous.revision) || 0) + 1 : 0);
  const normalized = {
    ...(sameRun ? previous : {}),
    ...progress,
    phase,
    current: phase === "enriching" ? enriched : saved,
    total,
    discovered,
    saved,
    enriched,
    revision,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ capture_progress: normalized });
}

/**
 * Storage reads and writes are asynchronous, while the capture engine emits
 * progress without awaiting every update. Serialize the complete read/merge/
 * write transaction so a slower older update cannot overwrite a newer one or
 * resurrect a run after its terminal status was stored.
 */
export function updateProgress(progress) {
  const task = captureProgressQueue.then(
    () => performProgressUpdate(progress),
    () => performProgressUpdate(progress),
  );
  captureProgressQueue = task.catch(() => {});
  return task;
}

export async function getCaptureStatus() {
  const { capture_progress } = await chrome.storage.local.get("capture_progress");
  return capture_progress || { status: "idle" };
}

export async function readCaptureProgress() {
  const { capture_progress } = await chrome.storage.local.get("capture_progress");
  return capture_progress || null;
}

/** Streamed progress from the capture engine, guarded against superseded runs. */
export async function reportCaptureProgress(message) {
  const current = await readCaptureProgress();
  if (current?.status === "canceled") return { acknowledged: true, ignored: "canceled" };
  if (current?.runId && message.runId && current.runId !== message.runId) {
    return { acknowledged: true, ignored: "superseded" };
  }
  await touchLinkedInCapture(message.runId);
  await updateProgress({
    site: message.site || "unknown",
    status: message.status || "in_progress",
    current: message.current || 0,
    total: message.total || 0,
    message: message.message,
    runId: message.runId || null,
    phase: message.phase,
    discovered: message.discovered,
    saved: message.saved,
    enriched: message.enriched,
  });
  return { acknowledged: true };
}

export async function reportCaptureError({ site = "linkedin", error, runId }) {
  const current = await readCaptureProgress();
  if (current?.status === "canceled") return { acknowledged: true, ignored: "canceled" };
  if (current?.runId && runId && current.runId !== runId) {
    return { acknowledged: true, ignored: "superseded" };
  }
  await updateProgress({
    site,
    status: "error",
    phase: "error",
    current: Number(current?.current) || 0,
    total: Number(current?.total) || 0,
    discovered: Number(current?.discovered) || 0,
    saved: Number(current?.saved) || 0,
    enriched: Number(current?.enriched) || 0,
    message: error || "LinkedIn capture failed",
    runId: runId || current?.runId || null,
  });
  return { acknowledged: true };
}

/**
 * `silent` is for a scheduled soft sync, which publishes no progress of its
 * own. Both guards below read the visible progress record, and for a silent
 * run that record belongs to some *other*, earlier run — so they would read
 * every completion as superseded and fail the run at the finish line. It still
 * records the result: a soft sync is a real sync, and `capture_results` is what
 * "last synced" and the initial-sync gate are read from.
 */
export async function reportImportCompleted(summary = {}, { silent = false } = {}) {
  const currentProgress = silent ? null : await readCaptureProgress();
  if (!silent) {
    if (currentProgress?.status === "canceled") return { acknowledged: true, ignored: "canceled" };
    if (currentProgress?.runId && summary.runId && currentProgress.runId !== summary.runId) {
      return { acknowledged: true, ignored: "superseded" };
    }
  }
  const total = Number(summary.total) || Number(summary.accepted) || 0;
  const compact = {
    site: "linkedin",
    timestamp: Date.now(),
    importId: summary.importId || null,
    total,
    accepted: Number(summary.accepted) || total,
    failed: Number(summary.failed) || 0,
    chunks: Number(summary.totalChunks) || 0,
    resumed: Boolean(summary.resumed),
    completedAt: summary.completedAt || new Date().toISOString(),
    runId: summary.runId || currentProgress?.runId || null,
    sample: summary.sample === true,
  };
  await chrome.storage.local.set({
    capture_results: compact,
    // Durable: a later test sync overwrites capture_results, not this.
    ...(compact.sample ? {} : { earthos_initial_sync_done: compact.completedAt }),
  });
  if (!silent) {
    await updateProgress({
      site: "linkedin",
      status: "complete",
      phase: "complete",
      current: total,
      total,
      discovered: Math.max(total, Number(currentProgress?.discovered) || 0),
      saved: total,
      enriched: Number(currentProgress?.enriched) || 0,
      message: summary.sample
        ? `Test sync done: ${total.toLocaleString()} contacts`
        : `Synced ${total.toLocaleString()} contacts`,
      lastResult: compact,
      runId: compact.runId,
    });
  }
  LOG(`LinkedIn import complete: ${total} contacts${silent ? " (scheduled soft sync)" : ""}`);
  return { acknowledged: true };
}

// ─── Secondary progress channels ─────────────────────────────────────────────

export async function setEnrichProgress(progress) {
  return queueAuxiliaryProgress(() => chrome.storage.local.set({ enrich_progress: progress }));
}

export async function mergeEnrichProgress(patch) {
  return queueAuxiliaryProgress(async () => {
    const { enrich_progress: current } = await chrome.storage.local.get("enrich_progress");
    await chrome.storage.local.set({ enrich_progress: { ...(current || {}), ...patch } });
  });
}

export async function setMutualProgress(progress) {
  return queueAuxiliaryProgress(() => chrome.storage.local.set({ mutual_progress: progress }));
}

export async function setCompanyProgress(progress) {
  return queueAuxiliaryProgress(() => chrome.storage.local.set({ company_progress: progress }));
}

function queueAuxiliaryProgress(operation) {
  const task = auxiliaryProgressQueue.then(operation, operation);
  auxiliaryProgressQueue = task.catch(() => {});
  return task;
}
