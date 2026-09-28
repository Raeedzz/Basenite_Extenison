/**
 * LinkedIn capture engine — runs inside the background service worker.
 *
 * Previously this was a content script injected into a linkedin.com tab. The
 * capture never touched the DOM: it paginates Voyager's REST API and uploads
 * resumable chunks, so the tab existed only to supply session cookies and the
 * CSRF token. Both now come from the cookie jar (lib/linkedin-session.js) and
 * no tab is opened at all.
 *
 * What changed from the content-script version:
 *   • the chrome.runtime.onMessage listener became the exported entry points
 *   • document.cookie became chrome.cookies (getCsrfToken)
 *   • relative Voyager paths are resolved against linkedin.com in fetch
 *   • runtime messages to the worker became direct function calls
 * Everything else — parsing, pagination, adaptive throttling, checkpointing —
 * is unchanged.
 *
 * Progress is checkpointed to chrome.storage.local after every block, so a
 * service worker that is terminated mid-run resumes from the last durable
 * sequence instead of restarting (see resumeInterruptedCapture in the worker).
 */

import {
  completePeopleImport,
  createPeopleImport,
  getPeopleImportStatus,
  getToken,
  putPeopleImportChunk,
  softSyncCheck,
  uploadNetworkSignals,
} from "../lib/api-client.js";
import { peopleImportKeyForRun } from "../lib/import-protocol.js";
import { isPlaceholderImage } from "../lib/airtable-fields.js";
import { enrichmentWalked } from "../lib/enrichment-progress.js";
import { stageMessage, waitMessage } from "../lib/progress-copy.js";
import {
  getCsrfToken,
  linkedinUrl as voyagerUrl,
  LinkedInSessionError,
} from "../lib/linkedin-session.js";
import {
  claimLinkedInCapture,
  reopenCaptureRun,
  mergeEnrichProgress,
  releaseLinkedInCapture,
  reportCaptureError,
  reportCaptureProgress,
  reportImportCompleted,
  setEnrichProgress,
  touchLinkedInCapture,
  updateProgress,
} from "./capture-state.js";
import { uploadEnrichmentBatch } from "./enrichment-upload.js";
import { recordSoftSyncRun } from "./soft-sync.js";
// Classic script that assigns globalThis.EarthOSLinkedInMessagingProtocol.
import "../lib/linkedin-messaging-protocol.js";

const engine = (function () {
  const LOG_LEVEL = "info"; // "debug" for development
  const LOG = (...args) => console.log("[EarthOS:LI]", ...args);
  const DEBUG = (...args) => LOG_LEVEL === "debug" && console.log("[EarthOS:LI]", ...args);
  const ERR = (...args) => console.error("[EarthOS:LI]", ...args);


  // ─── Enrichment State ──────────────────────────────────────────────────────
  let enrichmentPaused = false;
  const runtimeState = {
    captureRunning: false,
    capturePromise: null,
    captureRunId: null,
    // A scheduled soft sync reports nothing to the user: no progress record and
    // no error banner for a run they never started. Lifted by revealCapture()
    // when a user-initiated sync arrives while the soft run is still going.
    captureSilent: false,
    // The depth the live run is actually using. A request may arrive before an
    // adopted checkpoint has loaded, so null means "not known yet" rather than
    // full. This lets a soft request reveal a scheduled soft run without
    // accidentally deepening it, while a full request can still promote an
    // already-visible soft run.
    captureMode: null,
    // A full sync arriving during a live soft run promotes that same resumable
    // import to full enrichment. The capture loop consumes this signal at
    // durable boundaries so no second import races the first.
    captureUpgradeRequested: false,
    // Once terminal persistence begins, the existing import can no longer be
    // upgraded safely. A manual request in that narrow window queues a fresh
    // full run instead.
    captureAcceptingUpgrade: false,
    captureRestartRequested: false,
    // A visible progress record must belong to this run before a promoted soft
    // sync starts publishing. Completion and error paths await this promise so
    // they cannot race the ownership handoff and be rejected as superseded.
    captureRevealPromise: null,
    // The person cap of the live run when it is a test sync, else 0.
    captureSampleLimit: 0,
    enrichmentRunning: false,
    cancelRequested: false,
    // Where the visible run had got to when it last published counters, so the
    // pauses and sub-steps raised deep inside the fetch helpers can republish
    // the same percentage rather than inventing a sentence. A silent run
    // records nothing here, for the same reason it publishes nothing anywhere.
    syncCounts: { phase: "starting", current: 0, total: 0 },
  };
  // Set by the worker so it can retire the keep-alive alarms once a run ends.
  let settledHook = async () => {};
  const activeAbortControllers = new Set();

  function abortAllActiveFetches() {
    for (const ctrl of activeAbortControllers) {
      try { ctrl.abort(); } catch {}
    }
    activeAbortControllers.clear();
  }

  async function cancelEverything() {
    runtimeState.cancelRequested = true;
    enrichmentPaused = false; // unblock any pause-wait so the loop can see the cancel flag
    abortAllActiveFetches();
    try {
      const progress = await loadProgress();
      if (progress) {
        progress.status = "canceled";
        progress.retry = { phase: "canceled", attempt: 0, lastError: null, nextRetryAt: null };
        await saveProgress(progress);
      }
      await chrome.storage.local.remove("earthos_li_enrich_progress");
    } catch {}
    LOG("Sync canceled by user");
  }

  // ─── Entry points ──────────────────────────────────────────────────────────
  //
  // These were the branches of the content script's onMessage listener. The
  // worker calls them directly now, so a run is a promise this module owns
  // rather than a message round-trip into a tab.

  function isCaptureRunning() {
    return runtimeState.captureRunning;
  }

  /**
   * A run that was stopped but is still finishing its in-flight write. A new
   * request must wait it out, not join it: joining a stopped run starts nothing.
   */
  async function waitForStop(timeoutMs = 60_000) {
    if (!runtimeState.captureRunning || !runtimeState.cancelRequested) return;
    const running = runtimeState.capturePromise;
    if (!running) return;
    await Promise.race([running.catch(() => {}), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  function isEnrichmentRunning() {
    return runtimeState.enrichmentRunning;
  }

  function currentRunId() {
    return runtimeState.captureRunId;
  }

  /**
   * Join a user request to the in-flight capture.
   *
   * A scheduled soft run becomes visible when any requested sync lands. Only a
   * full request deepens it; a requested soft sync must remain soft. The same
   * depth rule applies after the run is already visible, which matters when a
   * durable soft task starts first and a full task is queued while it walks.
   */
  async function revealCapture(requestedMode = "full") {
    // A stopped run is on its way out; there's nothing to join.
    if (!runtimeState.captureRunning || runtimeState.cancelRequested) return false;
    const runId = runtimeState.captureRunId;
    if (requestedMode === "full" && runtimeState.captureMode !== "full") {
      if (runtimeState.captureAcceptingUpgrade) {
        runtimeState.captureUpgradeRequested = true;
      } else {
        runtimeState.captureRestartRequested = true;
      }
    }
    // A second request can be deeper than the one whose visibility write is in
    // flight. Record its depth above before sharing the first request's promise.
    if (runtimeState.captureRevealPromise) return runtimeState.captureRevealPromise;
    if (!runtimeState.captureSilent) return true;
    const revealPromise = (async () => {
      await updateProgress({
        site: "linkedin",
        status: "starting",
        phase: "starting",
        current: 0,
        total: 0,
        discovered: 0,
        saved: 0,
        enriched: 0,
        message: stageMessage("starting"),
        runId,
      });
      if (!runtimeState.captureRunning
          || runtimeState.captureRunId !== runId) {
        return false;
      }
      // A concurrent request may already have revealed this run while the
      // progress write was in flight. It still joined the same live capture.
      if (!runtimeState.captureSilent) return true;
      runtimeState.captureSilent = false;
      return true;
    })();
    runtimeState.captureRevealPromise = revealPromise;
    try {
      return await revealPromise;
    } finally {
      if (runtimeState.captureRevealPromise === revealPromise) {
        runtimeState.captureRevealPromise = null;
      }
    }
  }

  /**
   * Does the stored checkpoint belong to a scheduled soft run? The crash-resume
   * path needs this to inherit the run's reporting: a soft run the worker
   * restarted has to stay as invisible as it started, and its resume failures
   * belong in the soft-sync status record rather than in the user's face.
   * Reads the raw record — loadProgress() reconciles stale checkpoints against
   * the server, which is far too much work for a predicate.
   */
  async function isSoftCheckpoint() {
    const key = storageKey();
    const stored = await chrome.storage.local.get(key).catch(() => ({}));
    return stored?.[key]?.softSync === true;
  }

  /**
   * Was the stored checkpoint's run invisible to the user? Only a scheduled
   * run is; a soft run the user asked for reports progress like any other, so
   * resume must not silence it. Pre-`silent` checkpoints fall back to the old
   * rule, under which soft and silent were the same thing.
   */
  async function isSilentCheckpoint() {
    const key = storageKey();
    const stored = await chrome.storage.local.get(key).catch(() => ({}));
    const record = stored?.[key];
    return record?.silent === undefined ? record?.softSync === true : record.silent === true;
  }

  function onSettled(hook) {
    if (typeof hook === "function") settledHook = hook;
  }

  function startCapture(requestedRunId, options = {}) {
    if (runtimeState.enrichmentRunning) {
      return { error: "Finish or cancel LinkedIn enrichment before starting a base capture." };
    }
    if (runtimeState.captureRunning) {
      if (runtimeState.cancelRequested) {
        return { error: "The previous LinkedIn capture is still stopping. Try again in a moment." };
      }
      return { started: true, alreadyRunning: true, runId: runtimeState.captureRunId };
    }

    const runId = typeof requestedRunId === "string" && requestedRunId
      ? requestedRunId
      : createRunId();
    reopenCaptureRun(runId);
    runtimeState.cancelRequested = false;
    resetProfileBatchSupport();
    runtimeState.captureRunning = true;
    runtimeState.captureRunId = runId;
    // Explicit visibility wins; without it, soft still means silent so the
    // scheduled sync and the crash-resume paths behave exactly as before.
    runtimeState.captureSilent = options.silent === undefined
      ? options.mode === "soft"
      : options.silent === true;
    runtimeState.captureMode = options.mode === "soft"
      ? "soft"
      : options.mode === "full" ? "full" : null;
    runtimeState.captureUpgradeRequested = false;
    runtimeState.captureAcceptingUpgrade = true;
    runtimeState.captureRestartRequested = false;
    runtimeState.captureRevealPromise = null;
    // Known now when asked for explicitly; a resume learns it from the checkpoint.
    runtimeState.captureSampleLimit = options.sampleLimit !== undefined
      ? sampleLimitOf({ sampleLimit: options.sampleLimit })
      : 0;
    // A new run has got nowhere yet; the previous run's position is not its.
    runtimeState.syncCounts = { phase: "starting", current: 0, total: 0 };
    runtimeState.lastMetrics = null;
    runtimeState.capturePromise = captureConnections(runId, options)
      .then(async (result) => {
        LOG("Capture finished:", result);
        if (result?.error) await reportAsyncCaptureError(result.error, runId);
        return result;
      })
      .catch(async (err) => {
        ERR("Capture error:", err.message, err.stack);
        await reportAsyncCaptureError(err.message, runId);
      })
      .finally(async () => {
        runtimeState.captureAcceptingUpgrade = false;
        await runtimeState.captureRevealPromise?.catch(() => {});
        await releaseLinkedInCapture(runId).catch(() => {});
        // A reveal can start while lock release is in flight. Let it finish
        // choosing between promotion and restart before clearing run state.
        await runtimeState.captureRevealPromise?.catch(() => {});
        // Preserve the identity of the work that actually settled after every
        // in-flight reveal has chosen its final visibility/depth, but before
        // the runtime state is cleared (or a requested full restart replaces
        // it). The service worker uses this to avoid scheduling a capture retry
        // from stale progress when unrelated enrichment settles later.
        const settledRun = {
          kind: "capture",
          runId,
          mode: runtimeState.captureMode === "soft" ? "soft" : "full",
          silent: runtimeState.captureSilent,
        };
        let restartFullCapture = false;
        if (runtimeState.captureRunId === runId) {
          restartFullCapture = runtimeState.captureRestartRequested;
          runtimeState.captureRunning = false;
          runtimeState.capturePromise = null;
          runtimeState.captureRunId = null;
          runtimeState.captureSilent = false;
          runtimeState.captureMode = null;
          runtimeState.captureUpgradeRequested = false;
          runtimeState.captureAcceptingUpgrade = false;
          runtimeState.captureRestartRequested = false;
          runtimeState.captureRevealPromise = null;
          runtimeState.captureSampleLimit = 0;
        }
        if (restartFullCapture) {
          const restartRunId = createRunId();
          await updateProgress({
            site: "linkedin",
            status: "starting",
            phase: "starting",
            current: 0,
            total: 0,
            discovered: 0,
            saved: 0,
            enriched: 0,
            message: stageMessage("starting"),
            runId: restartRunId,
          }).catch(() => {});
          startCapture(restartRunId, { mode: "full", sampleLimit: null });
        }
        try { await settledHook(settledRun); } catch { /* hook failures are cosmetic */ }
      });

    // Launch is acknowledged immediately; the run reports progress, failure,
    // cancellation, and completion through capture-state.
    return { started: true, runId };
  }

  function startEnrichmentRun(connections) {
    if (runtimeState.captureRunning) {
      return { error: "Finish or cancel the LinkedIn base capture before starting enrichment." };
    }
    if (runtimeState.enrichmentRunning) {
      return { started: true, alreadyRunning: true };
    }
    runtimeState.cancelRequested = false;
    resetProfileBatchSupport();
    startEnrichment(connections)
      .then(async (result) => {
        if (result?.error) {
          await setEnrichProgress({ status: "error", message: result.error });
        }
      })
      .catch(async (err) => {
        await setEnrichProgress({ status: "error", message: err.message });
      })
      .finally(async () => {
        // startEnrichment clears this on its own exit paths, but a throw before
        // its try block (CSRF extraction, progress load) would otherwise leave
        // the flag stuck true and wedge every future capture and enrichment.
        runtimeState.enrichmentRunning = false;
        try { await settledHook({ kind: "enrichment" }); } catch { /* hook failures are cosmetic */ }
      });
    return { started: true };
  }

  function pauseEnrichment() {
    enrichmentPaused = true;
    LOG("Enrichment paused");
    return { paused: true };
  }

  function resumeEnrichment() {
    enrichmentPaused = false;
    LOG("Enrichment resumed");
    return { resumed: true };
  }

  async function cancelAll() {
    await cancelEverything();
    return { canceled: true };
  }


  // ─── Constants ──────────────────────────────────────────────────────────────

  const CONNECTIONS_PER_PAGE = 100;
  const MIN_PAGE_CONCURRENCY = 1;
  const INITIAL_PAGE_CONCURRENCY = 4;
  const MAX_PAGE_CONCURRENCY = 8;
  const MAX_UPLOAD_CONCURRENCY = 3;
  const ROWS_PER_CHUNK = 100;
  const LEGACY_ROWS_PER_CHUNK = 1000;
  const ENRICH_UPLOAD_BATCH_SIZE = 25;
  const DECORATION_ID = "com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-15";
  const PAGE_DELAY_MS = [150, 400];
  const NETWORK_RETRY_BACKOFF = [3000, 8000, 15000];
  const RATE_LIMIT_BASE_WAIT_MS = 60000;
  const RATE_LIMIT_MAX_WAIT_MS = 10 * 60 * 1000;
  const PROGRESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const FETCH_TIMEOUT_MS = 20000;

  function createRunId() {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    return `li-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function reportAsyncCaptureError(error, runId) {
    if (runtimeState.cancelRequested) return;
    await runtimeState.captureRevealPromise?.catch(() => {});
    const message = error || "LinkedIn capture failed";
    // A scheduled run's failure is a log line and a status record, never an
    // error banner. The user did not start this sync, and a soft run that hit
    // a LinkedIn throttle has nothing for them to act on — the next scheduled
    // run (or their next manual sync) picks up exactly where this one stopped.
    if (runtimeState.captureSilent) {
      ERR("Scheduled soft sync failed:", message);
      await recordSoftSyncRun({ failed: message, runId }).catch(() => {});
      return;
    }
    try {
      await reportCaptureError({
        site: "linkedin",
        error: message,
        runId,
      });
    } catch {}
  }

  // ─── Progress Persistence ───────────────────────────────────────────────────

  function storageKey() {
    return "earthos_li_progress";
  }

  async function loadProgress() {
    const key = storageKey();
    const data = await chrome.storage.local.get(key);
    const progress = data[key];
    if (!progress) return null;
    if (progress.version !== 2 || Array.isArray(progress.connections) || Array.isArray(progress.seenUrls)) {
      LOG("Discarding legacy full-array checkpoint");
      await chrome.storage.local.remove(key);
      return null;
    }
    // Captures created before progressive uploads used 1,000-row sequences.
    // Preserve their cursor math; new captures make each enriched page of 100
    // durable as soon as it is ready.
    if (!Number.isInteger(progress.rowsPerChunk)) {
      progress.rowsPerChunk = LEGACY_ROWS_PER_CHUNK;
    }
    if (!Array.isArray(progress.pendingEnrichmentSequences)) {
      progress.pendingEnrichmentSequences = [];
    }
    if (!progress.enrichmentBatchCursors || typeof progress.enrichmentBatchCursors !== "object") {
      progress.enrichmentBatchCursors = {};
    }
    if (!progress.enrichmentBatchOutcomes || typeof progress.enrichmentBatchOutcomes !== "object") {
      progress.enrichmentBatchOutcomes = {};
    }
    progress.softSync = progress.softSync === true;
    // Soft used to imply silent, because the only soft runs were the scheduled
    // ones nobody asked for. A soft sync the user requested (from the app, from
    // chat, or by text) is theirs and must show progress, so visibility is now
    // its own flag. A checkpoint written before it existed keeps the old rule.
    progress.silent = progress.silent === undefined
      ? progress.softSync === true
      : progress.silent === true;
    if (!progress.softSyncNewKeys || typeof progress.softSyncNewKeys !== "object") {
      progress.softSyncNewKeys = {};
    }
    progress.enrichmentGeneration = Math.max(0, Number(progress.enrichmentGeneration) || 0);
    progress.importFailure = sanitizeImportFailure(progress.importFailure);
    // Same expiry the profile pace gets, for the same reason: this checkpoint
    // outlives its run, so a page throttle learned during one capture would
    // otherwise still be holding the next one to a single page at a time —
    // and a cooldown timestamp from an hour ago would stall the next start
    // before it read anything.
    const pageAdaptedAt = Math.max(0, Number(progress.pageAdaptedAt) || 0);
    if (pageAdaptedAt && Date.now() - pageAdaptedAt > ADAPTIVE_PACE_MAX_AGE_MS) {
      progress.pageConcurrency = INITIAL_PAGE_CONCURRENCY;
      progress.cleanWaves = 0;
      progress.pageThrottleStreak = 0;
      progress.pageCooldownUntil = 0;
      progress.pageAdaptedAt = 0;
    }
    progress.discovered = Math.max(
      Number(progress.discovered) || 0,
      (Number(progress.accepted) || 0) + (Number(progress.failed) || 0),
    );
    if (Date.now() - progress.updatedAt > PROGRESS_MAX_AGE_MS) {
      LOG("Stale progress found, reconciling with the server");
      if (progress.importId) {
        try {
          const status = await sendImportRequest("PEOPLE_IMPORT_STATUS", { importId: progress.importId }, 2);
          progress.status = status.import.status;
          progress.accepted = status.import.accepted || 0;
          progress.failed = status.import.failed || 0;
          progress.uploadedChunks = status.import.chunks || 0;
          progress.updatedAt = Date.now();
          return progress;
        } catch (error) {
          if (error.status === 404) {
            await chrome.storage.local.remove(key);
            return null;
          }
          // Preserve the checkpoint on transient/auth failures. The main flow
          // will surface the error without orphaning a potentially valid import.
          return progress;
        }
      }
      progress.updatedAt = Date.now();
      return progress;
    }
    return progress;
  }

  let checkpointWrites = Promise.resolve();

  /**
   * Write the checkpoint, one write at a time.
   *
   * The snapshot below is taken from the live progress object and then awaits
   * storage, so two writers overlapping — the base pass and the enrichment
   * drain now run side by side — could each snapshot and the one that started
   * first could land last, putting the older of the two states on disk and
   * losing every field the newer one had moved. Waiting for the previous write
   * before snapshotting means the last write on disk is always the newest
   * state, rather than whichever request the browser happened to finish first.
   */
  async function saveProgress(progress) {
    const previous = checkpointWrites;
    let done;
    checkpointWrites = new Promise((resolve) => { done = resolve; });
    // A failed write must not wedge every write after it.
    await previous.catch(() => {});
    try {
      const safe = {
        version: 2,
        importId: progress.importId || null,
        clientImportKey: progress.clientImportKey || null,
        runId: progress.runId || null,
        status: progress.status || "running",
        startedAt: progress.startedAt,
        updatedAt: Date.now(),
        totalConnections: Number(progress.totalConnections) || 0,
        expectedRows: Number.isInteger(progress.expectedRows) ? progress.expectedRows : null,
        totalChunks: Number.isInteger(progress.totalChunks) ? progress.totalChunks : null,
        nextSequence: Number(progress.nextSequence) || 0,
        nextOffset: Number(progress.nextOffset) || 0,
        rowsPerChunk: Number(progress.rowsPerChunk) === LEGACY_ROWS_PER_CHUNK
          ? LEGACY_ROWS_PER_CHUNK
          : ROWS_PER_CHUNK,
        pendingEnrichmentSequences: Array.from(new Set(
          (Array.isArray(progress.pendingEnrichmentSequences)
            ? progress.pendingEnrichmentSequences
            : [])
            .map(Number)
            .filter((sequence) => Number.isInteger(sequence) && sequence >= 0),
        )).sort((left, right) => left - right),
        enrichmentBatchCursors: Object.fromEntries(
          Object.entries(
            progress.enrichmentBatchCursors && typeof progress.enrichmentBatchCursors === "object"
              ? progress.enrichmentBatchCursors
              : {},
          )
            .map(([sequence, cursor]) => [Number(sequence), Number(cursor)])
            .filter(([sequence, cursor]) => Number.isInteger(sequence)
              && sequence >= 0
              && Number.isInteger(cursor)
              && cursor >= 0),
        ),
        enrichmentBatchOutcomes: Object.fromEntries(
          Object.entries(
            progress.enrichmentBatchOutcomes && typeof progress.enrichmentBatchOutcomes === "object"
              ? progress.enrichmentBatchOutcomes
              : {},
          )
            .filter(([key, outcome]) => /^\d+:\d+$/.test(key)
              && outcome
              && Number.isInteger(Number(outcome.enriched))
              && Number(outcome.enriched) >= 0
              && Number.isInteger(Number(outcome.unavailable))
              && Number(outcome.unavailable) >= 0)
            .map(([key, outcome]) => [key, {
              enriched: Number(outcome.enriched),
              unavailable: Number(outcome.unavailable),
            }]),
        ),
        softSync: progress.softSync === true,
        // A test sync's cap lives with the checkpoint, so a retry or a resume
        // after a worker restart stays a 10-person test.
        sampleLimit: sampleLimitOf(progress) || null,
        silent: progress.silent === true,
        // Bumped when a soft run is upgraded to a full one. It namespaces the
        // enrichment idempotency keys so re-queued pages upload again instead of
        // being deduplicated as replays of the soft run's batches.
        enrichmentGeneration: Math.max(0, Number(progress.enrichmentGeneration) || 0),
        softSyncNewKeys: Object.fromEntries(
          Object.entries(
            progress.softSyncNewKeys && typeof progress.softSyncNewKeys === "object"
              ? progress.softSyncNewKeys
              : {},
          )
            .filter(([sequence, keys]) => /^\d+$/.test(sequence) && Array.isArray(keys))
            .map(([sequence, keys]) => [
              sequence,
              keys.filter((key) => typeof key === "string" && key).slice(0, LEGACY_ROWS_PER_CHUNK),
            ]),
        ),
        discovered: Math.max(
          Number(progress.discovered) || 0,
          (Number(progress.accepted) || 0) + (Number(progress.failed) || 0),
        ),
        accepted: Number(progress.accepted) || 0,
        failed: Number(progress.failed) || 0,
        uploadedChunks: Number(progress.uploadedChunks) || 0,
        pageConcurrency: Math.max(MIN_PAGE_CONCURRENCY, Math.min(MAX_PAGE_CONCURRENCY, Number(progress.pageConcurrency) || INITIAL_PAGE_CONCURRENCY)),
        cleanWaves: Number(progress.cleanWaves) || 0,
        pageThrottleStreak: Math.max(0, Number(progress.pageThrottleStreak) || 0),
        pageCooldownUntil: Math.max(0, Number(progress.pageCooldownUntil) || 0),
        pageAdaptedAt: Math.max(0, Number(progress.pageAdaptedAt) || 0),
        profileAdaptive: sanitizeProfileAdaptive(progress.profileAdaptive),
        retry: progress.retry ? {
          phase: progress.retry.phase || null,
          attempt: Number(progress.retry.attempt) || 0,
          lastError: progress.retry.lastError || null,
          nextRetryAt: progress.retry.nextRetryAt || null,
        } : null,
        // How many times in a row this exact import has failed this exact way.
        // Must survive the checkpoint or the count resets every restart and the
        // backstop below never reaches its threshold. `retry.attempt` cannot be
        // reused: the run zeroes it at each phase, so it measures the phase, not
        // the checkpoint.
        importFailure: sanitizeImportFailure(progress.importFailure),
        completedAt: progress.completedAt || null,
      };
      Object.assign(progress, safe);
      await chrome.storage.local.set({ [storageKey()]: safe });
      dumpDebugJson(safe);
    } finally {
      done();
    }
  }

  async function clearProgress() {
    await chrome.storage.local.remove(storageKey());
  }

  function dumpDebugJson(progress) {
    const summary = {
      elapsed: ((Date.now() - progress.startedAt) / 1000).toFixed(1) + "s",
      importId: progress.importId,
      status: progress.status,
      total: progress.totalConnections,
      nextSequence: progress.nextSequence,
      accepted: progress.accepted,
      pageConcurrency: progress.pageConcurrency,
    };
    DEBUG("Capture progress:", summary);
  }

  function newProgress(runId) {
    return {
      version: 2,
      importId: null,
      clientImportKey: createRunId(),
      runId,
      status: "starting",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      totalConnections: 0,
      expectedRows: null,
      totalChunks: null,
      nextSequence: 0,
      nextOffset: 0,
      rowsPerChunk: ROWS_PER_CHUNK,
      pendingEnrichmentSequences: [],
      enrichmentBatchCursors: {},
      enrichmentBatchOutcomes: {},
      softSync: false,
      silent: false,
      softSyncNewKeys: {},
      enrichmentGeneration: 0,
      discovered: 0,
      accepted: 0,
      failed: 0,
      uploadedChunks: 0,
      pageConcurrency: INITIAL_PAGE_CONCURRENCY,
      cleanWaves: 0,
      pageThrottleStreak: 0,
      pageCooldownUntil: 0,
      pageAdaptedAt: 0,
      profileAdaptive: createProfileAdaptive(),
      retry: null,
      importFailure: null,
      completedAt: null,
    };
  }

  /**
   * The stuck-sync backstop.
   *
   * Every parameter this engine sends is derived from LinkedIn at the moment it
   * is read, and the checkpoint outlives the attempt that read it. So a stored
   * value can disagree with a live one — an idempotency key spent under an
   * earlier row count, an expectedRows the connection count has since drifted
   * away from, an importId the server has already closed — and the server
   * answers those with a 4xx that is entirely deterministic: the checkpoint
   * hands back the same value, the run fails at the same place, and the panel's
   * own "Try again" cannot clear it. Every such bug found so far has had that
   * exact shape, and each was fixed one at a time after a user got stranded.
   *
   * This catches the class rather than the instances. A failure that is not
   * transient (network, rate limit, server fault, signed out) and not a cancel
   * is a candidate; the same message failing the same import twice running is
   * the signature of one that will never resolve itself, so the import is
   * retired and the next attempt opens a fresh one.
   *
   * Two, not one, because a first occurrence is indistinguishable from bad luck,
   * and retiring an import throws away durable uploaded chunks — the rows upsert
   * by person so nothing duplicates, but the work is redone. Two consecutive
   * identical failures against one importId is not luck. The automatic retry
   * schedule in service-worker.js is three attempts deep, so this normally
   * clears itself before the user is ever asked to press anything.
   */
  function sanitizeImportFailure(failure) {
    if (!failure || typeof failure !== "object") return null;
    const importId = failure.importId ? String(failure.importId) : null;
    const message = failure.message ? String(failure.message).slice(0, 300) : null;
    const count = Math.max(0, Number(failure.count) || 0);
    if (!importId || !message || count <= 0) return null;
    return { importId, message, count };
  }

  /**
   * Transient failures say nothing about the checkpoint, so they must neither
   * count toward the threshold nor clear a count already standing: a run that
   * dies on a dropped connection has not proved the stored import is usable.
   */
  function isTransientFailure(error) {
    if (isAuthError(error)) return true;
    const status = Number(error?.status) || 0;
    if (status === 429 || status >= 500) return true;
    return status === 0 && isNetworkError(error);
  }

  function recordImportFailure(progress, error) {
    if (!progress.importId || isTransientFailure(error)) return;
    const message = String(error?.message || error).slice(0, 300);
    const previous = sanitizeImportFailure(progress.importFailure);
    const repeated = previous?.importId === progress.importId && previous.message === message;
    progress.importFailure = {
      importId: progress.importId,
      message,
      count: repeated ? previous.count + 1 : 1,
    };
  }

  const IMPORT_FAILURE_RETIRE_THRESHOLD = 2;

  /**
   * Condemn an import that is already known to be unable to finish, so the next
   * attempt retires it without waiting for the threshold to be reached the slow
   * way. For failures that prove themselves on sight rather than by repeating.
   */
  function condemnImport(progress, message) {
    if (!progress.importId) return;
    progress.importFailure = {
      importId: progress.importId,
      message: String(message).slice(0, 300),
      count: IMPORT_FAILURE_RETIRE_THRESHOLD,
    };
  }

  /**
   * Returns true when a doomed import was retired, so the caller knows the
   * chunk plan has to be rebuilt from LinkedIn rather than resumed.
   */
  function retireImportIfRepeatedlyFailing(progress) {
    const failure = sanitizeImportFailure(progress.importFailure);
    if (!failure || failure.importId !== progress.importId) {
      // A signature that no longer names the stored import is spent history.
      progress.importFailure = null;
      return false;
    }
    if (failure.count < IMPORT_FAILURE_RETIRE_THRESHOLD) return false;
    LOG(
      `Import ${failure.importId} failed ${failure.count} times running with the same error `
      + `("${failure.message}"); retiring it and starting a new one`,
    );
    resetImportCheckpoint(progress, { freshWorkspace: true });
    return true;
  }

  /**
   * Forget the server half of a checkpoint so the next attempt opens a brand
   * new import. What was already discovered locally (mode, page tuning) stays;
   * only the upload bookkeeping resets.
   *
   * `freshWorkspace` additionally drops the enrichment queue, which is right
   * when the rows those sequences described no longer exist server-side.
   */
  function resetImportCheckpoint(progress, { freshWorkspace = false } = {}) {
    // The signature names an import that no longer exists here. Carrying it
    // would count the retired import's failures against its replacement.
    progress.importFailure = null;
    progress.importId = null;
    progress.clientImportKey = createRunId();
    progress.nextSequence = 0;
    progress.nextOffset = 0;
    progress.totalChunks = 0;
    progress.uploadedChunks = 0;
    progress.accepted = 0;
    progress.failed = 0;
    if (!freshWorkspace) return;
    // LEGACY_ROWS_PER_CHUNK only exists to finish imports opened under it.
    // Nothing is being finished here, so the new import gets the modern shape.
    progress.rowsPerChunk = ROWS_PER_CHUNK;
    progress.pendingEnrichmentSequences = [];
    progress.enrichmentBatchCursors = {};
    progress.enrichmentBatchOutcomes = {};
    progress.softSyncNewKeys = {};
    progress.discovered = 0;
    progress.completedAt = null;
  }

  // ─── Token Extraction ───────────────────────────────────────────────────────

  // The page used to read this from document.cookie. The worker reads the same
  // cookie out of the jar; a missing one means the user is signed out of
  // LinkedIn, which surfaces as an actionable LinkedInSessionError.
  async function extractCsrfToken() {
    const token = await getCsrfToken({ force: true });
    DEBUG("CSRF token read from cookie jar:", token.slice(0, 15) + "...");
    return token;
  }

  function apiHeaders(csrfToken) {
    return {
      "csrf-token": csrfToken,
      "x-restli-protocol-version": "2.0.0",
      "x-li-lang": "en_US",
      "x-li-page-instance": "urn:li:page:d_flagship3_people_connections;",
    };
  }

  // ─── API Fetch with retry (429 + network errors) ───────────────────────────

  function isNetworkError(err) {
    const msg = err?.message || "";
    return msg.includes("Failed to fetch") || msg.includes("NetworkError") ||
           msg.includes("INTERNET_DISCONNECTED") || msg.includes("network") ||
           msg.includes("ERR_") || msg.includes("timed out") ||
           err?.name === "AbortError" || err instanceof TypeError;
  }

  class LinkedInApiError extends Error {
    constructor(message, status = 0, retryAfterMs = null) {
      super(message);
      this.name = "LinkedInApiError";
      this.status = status;
      this.retryAfterMs = retryAfterMs;
    }
  }

  class ImportOperationError extends Error {
    constructor(response) {
      super(response?.error || "Import operation failed");
      this.name = "ImportOperationError";
      this.status = Number(response?.status) || 0;
      this.body = response?.body || null;
      this.retryAfterMs = response?.retryAfterMs ?? null;
      this.code = response?.code || null;
    }
  }

  function retryAfterMs(response) {
    const value = response.headers.get("retry-after");
    if (!value) return null;
    if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.ceil(Number(value) * 1000);
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
  }

  function retryDelay(attempt, serverDelay = null) {
    if (Number.isFinite(serverDelay) && serverDelay >= 0) return Math.min(120000, serverDelay);
    const base = Math.min(30000, 1000 * (2 ** Math.max(0, attempt)));
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    activeAbortControllers.add(ctrl);
    try {
      return await fetch(voyagerUrl(url), { ...options, signal: ctrl.signal, credentials: "include" });
    } catch (err) {
      if (err?.name === "AbortError") {
        if (runtimeState.cancelRequested) throw new Error("Sync canceled");
        throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(t);
      activeAbortControllers.delete(ctrl);
    }
  }

  async function apiFetch(url, options = {}, retries = 3) {
    const { onThrottle, onSourceFailure, retryRateLimit = true, ...fetchOptions } = options;
    for (let attempt = 1; attempt <= retries; attempt++) {
      let resp;
      try {
        resp = await fetchWithTimeout(url, fetchOptions, FETCH_TIMEOUT_MS);
      } catch (err) {
        if (runtimeState.cancelRequested) throw err;
        if (isNetworkError(err) && attempt < retries) {
          if (attempt >= 2) onSourceFailure?.();
          const backoff = NETWORK_RETRY_BACKOFF[attempt - 1] || retryDelay(attempt - 1);
          DEBUG(`Network error on attempt ${attempt}/${retries}, waiting ${backoff / 1000}s: ${err.message}`);
          sendProgress(waitMessage("offline", { seconds: backoff / 1000, ...runtimeState.syncCounts }));
          await sleep(backoff);
          if (runtimeState.cancelRequested) throw err;
          continue;
        }
        throw err;
      }

      if (resp.status === 429) {
        const serverDelay = retryAfterMs(resp);
        onThrottle?.(serverDelay);
        if (!retryRateLimit) {
          throw new LinkedInApiError("Rate limited by LinkedIn.", 429, serverDelay);
        }
        if (attempt < retries) {
          const backoff = retryDelay(attempt - 1, serverDelay);
          LOG(`429 — waiting ${Math.ceil(backoff / 1000)}s (attempt ${attempt}/${retries})`);
          sendProgress(waitMessage("rate_limited", { seconds: backoff / 1000, ...runtimeState.syncCounts }));
          await sleep(backoff);
          continue;
        }
        throw new LinkedInApiError("Rate limited by LinkedIn after multiple retries.", 429, serverDelay);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new LinkedInApiError("LinkedIn rejected the request — sign in to linkedin.com again, then retry.", resp.status);
      }
      if (resp.status >= 500 && attempt < retries) {
        if (attempt >= 2) onSourceFailure?.();
        await sleep(retryDelay(attempt - 1, retryAfterMs(resp)));
        continue;
      }
      if (!resp.ok) throw new LinkedInApiError(`LinkedIn API ${resp.status} ${resp.statusText}`, resp.status, retryAfterMs(resp));

      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        if (attempt < retries) {
          const backoff = NETWORK_RETRY_BACKOFF[attempt - 1] || 15000;
          DEBUG(`Got non-JSON response, retrying in ${backoff / 1000}s: ${text.slice(0, 100)}`);
          await sleep(backoff);
          continue;
        }
        throw new Error("LinkedIn returned non-JSON response — possible rate limit or session issue.");
      }
    }
  }

  // ─── Messenger interaction metadata snapshot ──────────────────────────────
  //
  // A sync reads the inbox metadata once, builds a member-id index in memory,
  // and joins that index onto connection rows before upload. This is O(inbox +
  // connections), not one inbox scan per connection. The parser never touches
  // message bodies, subjects, or rendered content. Conversation identifiers are
  // used transiently for bounded thread follow-ups and never uploaded or stored.

  const MESSAGING_PAGE_SIZE = 20;
  const MAX_MESSAGING_PAGES = 100;
  const RECIPROCITY_LEDGER_KEY = "earthos_li_reciprocity_probed";

  function messagingProtocol() {
    return globalThis.EarthOSLinkedInMessagingProtocol || null;
  }

  async function fetchMessagingMetadata(url, csrfToken, accept = "application/graphql") {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        accept,
        "csrf-token": csrfToken,
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
      },
    }, FETCH_TIMEOUT_MS);
    if (response.status === 401 || response.status === 403) {
      throw new LinkedInApiError("LinkedIn rejected the request — sign in to linkedin.com again, then retry.", response.status);
    }
    if (response.status === 429) throw new LinkedInApiError("Rate limited by LinkedIn.", 429, retryAfterMs(response));
    if (!response.ok) throw new LinkedInApiError(`LinkedIn messaging API ${response.status}`, response.status);
    try {
      return await response.json();
    } catch {
      throw new Error("LinkedIn messaging metadata returned an invalid response");
    }
  }

  async function writeReciprocityLedger(ledger) {
    const entries = Object.entries(ledger)
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, 5_000);
    await chrome.storage.local
      .set({ [RECIPROCITY_LEDGER_KEY]: Object.fromEntries(entries) })
      .catch(() => undefined);
  }
  async function captureInteractionSnapshot(csrfToken) {
    const protocol = messagingProtocol();
    if (!protocol) return { byMemberId: new Map(), complete: false, conversations: 0 };
    sendProgress("Reading your recent LinkedIn messages and replies…");
    const me = await fetchMessagingMetadata("/voyager/api/me", csrfToken, "application/json");
    const selfProfileUrn = protocol.extractSelfProfileUrn(me);
    if (!selfProfileUrn) throw new Error("LinkedIn could not resolve the signed-in member identity");

    const byMemberId = new Map();
    let lastUpdatedBefore = Date.now();
    let conversationsSeen = 0;
    let complete = false;
    for (let page = 0; page < MAX_MESSAGING_PAGES; page++) {
      if (runtimeState.cancelRequested) throw new Error("Sync canceled");
      const url = protocol.buildConversationsUrl(selfProfileUrn, lastUpdatedBefore, MESSAGING_PAGE_SIZE);
      const response = await fetchMessagingMetadata(url, csrfToken);
      const conversations = protocol.conversationElements(response);
      conversationsSeen += conversations.length;
      for (const [memberId, summary] of protocol.directInteractionEntries(conversations, selfProfileUrn)) {
        const existing = byMemberId.get(memberId);
        if (!existing || Number(summary.lastInteractionAt || 0) > Number(existing.lastInteractionAt || 0)) {
          byMemberId.set(memberId, summary);
        }
      }
      if (conversations.length < MESSAGING_PAGE_SIZE) {
        complete = true;
        break;
      }
      const oldest = protocol.oldestActivityAt(conversations);
      if (!oldest || oldest >= lastUpdatedBefore) break;
      lastUpdatedBefore = oldest - 1;
      await sleep(150 + Math.random() * 200);
    }

    // Message threads aren't opened: the inbox listing above is all Airtable uses.
    const reciprocity = { ledger: null, updates: {} };
    return {
      byMemberId,
      complete,
      conversations: conversationsSeen,
      reciprocityLedger: reciprocity.ledger,
      reciprocityLedgerUpdates: reciprocity.updates,
      reciprocityPersistedKeys: new Set(),
    };
  }

  function rowsWithInteractionSnapshot(rows, snapshot) {
    if (!Array.isArray(rows) || !snapshot?.byMemberId) return rows;
    return rows.map((row) => {
      const status = row?.memberId ? snapshot.byMemberId.get(row.memberId) : null;
      // An incomplete scan can safely enrich matches, but must not overwrite a
      // previously captured interaction with a false negative for non-matches.
      if (!status && !snapshot.complete) return row;
      if (status?.reciprocityLedgerKey && snapshot.reciprocityPersistedKeys instanceof Set) {
        snapshot.reciprocityPersistedKeys.add(status.reciprocityLedgerKey);
      }
      const timestamp = Number(status?.lastInteractionAt);
      const lastInteractionAt = Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp).toISOString()
        : null;
      return {
        ...row,
        hasInteracted: status?.hasInteracted === true,
        messageSent: status?.messageSent === true,
        messageReceived: status?.messageReceived === true,
        lastInteraction: lastInteractionAt,
        lastInteractionAt,
        lastInteractionDirection: status?.lastInteractionDirection === "sent" || status?.lastInteractionDirection === "received"
          ? status.lastInteractionDirection
          : null,
        // Up to five timestamp/direction pairs, newest first. The thread URN
        // used to fetch them never enters this row or leaves the extension.
        recentMessageMetadata: Array.isArray(status?.recentMessageMetadata)
          ? status.recentMessageMetadata
            .map((entry) => ({
              deliveredAt: Number(entry?.deliveredAt),
              direction: entry?.direction,
            }))
            .filter((entry) => Number.isFinite(entry.deliveredAt)
              && entry.deliveredAt > 0
              && (entry.direction === "sent" || entry.direction === "received"))
            .slice(0, 5)
          : [],
        lastSentAt: isoOrNull(status?.lastSentAt),
        lastReceivedAt: isoOrNull(status?.lastReceivedAt),
        reciprocal: status?.reciprocal === true,
        // Thread posture, from the same response at no extra cost. `hasDraft`
        // records that an unsent message to this person exists — never its text.
        hasDraft: status?.hasDraft === true,
        draftUpdatedAt: isoOrNull(status?.draftUpdatedAt),
        threadLastReadAt: isoOrNull(status?.lastReadAt),
        threadUnreadCount: Number.isFinite(Number(status?.unreadCount))
          ? Math.max(0, Math.trunc(Number(status.unreadCount)))
          : 0,
        threadMuted: status?.muted === true,
      };
    });
  }

  /** Epoch millis to an ISO string, or null. Keeps source_data uniform. */
  function isoOrNull(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
  }

  // ─── Connection Data Extraction ────────────────────────────────────────────

  // Bounded DFS for the first usable vectorImage anywhere in the subtree.
  // Voyager keeps adding new wrapper shapes (displayImageReference,
  // displayImageWithDefault, displayImageReferenceResolutionResult,
  // nonEntityProfilePicture, …) so enumerating each path is a losing game.
  // Artifacts that can make a URL; the widest of these is the one used.
  function withPath(artifacts) {
    const usable = artifacts.filter((a) => a?.fileIdentifyingUrlPathSegment);
    return usable.length ? usable : artifacts;
  }

  function _findVectorImage(node, depth) {
    if (!node || typeof node !== "object" || depth > 12) return null;
    if (Array.isArray(node.artifacts) && node.artifacts.length > 0 &&
        (typeof node.rootUrl === "string"
          || node.artifacts.some((a) => /^https?:\/\//.test(a?.fileIdentifyingUrlPathSegment || "")))) return node;
    if (node.vectorImage) {
      const vi = _findVectorImage(node.vectorImage, depth + 1);
      if (vi) return vi;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") {
        const found = _findVectorImage(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function _findCdnUrlString(node, depth) {
    if (!node || depth > 12) return null;
    if (typeof node === "string") {
      return /^https:\/\/([a-z0-9-]+\.)*licdn\.com\/[^\s"'<>]+$/i.test(node) && !isPlaceholderImage(node) ? node : null;
    }
    if (typeof node !== "object") return null;
    for (const k of Object.keys(node)) {
      const found = _findCdnUrlString(node[k], depth + 1);
      if (found) return found;
    }
    return null;
  }

  function extractPhotoUrl(profilePicture) {
    if (!profilePicture) return "";
    try {
      if (typeof profilePicture === "string" && profilePicture.startsWith("http")) {
        if (isPlaceholderImage(profilePicture)) return "";
        return profilePicture;
      }
      const vi = _findVectorImage(profilePicture, 0);
      if (vi) {
        const largest = withPath(vi.artifacts).reduce(
          (best, a) => ((a.width || 0) > (best.width || 0) ? a : best),
          withPath(vi.artifacts)[0]
        );
        const segment = largest?.fileIdentifyingUrlPathSegment || "";
        // New shape: segment is already absolute; rootUrl is "".
        // Legacy shape: segment is a path; rootUrl is the CDN prefix.
        if (/^https?:\/\//.test(segment)) return segment;
        if (segment && vi.rootUrl) return `${vi.rootUrl}${segment}`;
      }
      const cdn = _findCdnUrlString(profilePicture, 0);
      return cdn || "";
    } catch {
      return "";
    }
  }

  function firstImageUrl(...candidates) {
    for (const candidate of candidates) {
      const url = extractPhotoUrl(candidate);
      if (url) return url;
    }
    return "";
  }

  // Airtable keeps its own copy of the logo, so take the largest artifact.
  function extractLogoUrl(candidate) {
    if (!candidate) return "";
    try {
      if (typeof candidate === "string" && candidate.startsWith("http")) return isPlaceholderImage(candidate) ? "" : candidate;
      const vi = _findVectorImage(candidate, 0);
      if (vi) {
        const chosen = withPath(vi.artifacts).reduce(
          (best, a) => ((a.width || 0) > (best.width || 0) ? a : best),
          withPath(vi.artifacts)[0],
        );
        const segment = chosen?.fileIdentifyingUrlPathSegment || "";
        if (/^https?:\/\//.test(segment)) return segment;
        if (segment && vi.rootUrl) return `${vi.rootUrl}${segment}`;
      }
      return _findCdnUrlString(candidate, 0) || "";
    } catch {
      return "";
    }
  }

  function firstLogoUrl(...candidates) {
    for (const candidate of candidates) {
      const url = extractLogoUrl(candidate);
      if (url) return url;
    }
    return "";
  }

  function extractCompanyLogoUrl(entity) {
    if (!entity || typeof entity !== "object") return "";
    return firstLogoUrl(
      entity.companyLogo,
      entity.companyLogoImage,
      entity.logo,
      entity.logoV2,
      entity.image,
      entity.company?.companyLogo,
      entity.company?.logo,
      entity.company?.logoV2,
      entity.company?.image,
    );
  }

  function extractSchoolLogoUrl(entity) {
    if (!entity || typeof entity !== "object") return "";
    return firstLogoUrl(
      entity.schoolLogo,
      entity.schoolLogoImage,
      entity.logo,
      entity.logoV2,
      entity.image,
      entity.school?.schoolLogo,
      entity.school?.logo,
      entity.school?.logoV2,
      entity.school?.image,
    );
  }

  /**
   * Company and school logos indexed by URN and by lower-cased name.
   *
   * A LinkedIn profile response carries the logo on a separate company or
   * school entity, not on the position or education entry that references it,
   * so an entry parsed on its own frequently has no logo at all. Both response
   * formats need this: the flat `included` array is one long list of those
   * entities, and the Dash decoration still ships an `included` alongside the
   * nested profile often enough to be worth reading.
   */
  function buildLogoLookups(entities) {
    const companyLogosByUrn = new Map();
    const companyLogosByName = new Map();
    const schoolLogosByUrn = new Map();
    const schoolLogosByName = new Map();
    for (const entity of Array.isArray(entities) ? entities : []) {
      if (!entity || typeof entity !== "object") continue;
      const type = entity["$type"] || "";
      if (/(?:Company|Organization)/.test(type) && !type.includes("Position")) {
        const logoUrl = extractCompanyLogoUrl(entity);
        const urn = companyUrnFor(entity, true);
        const name = entity.name || entity.companyName || "";
        if (logoUrl && urn) companyLogosByUrn.set(urn, logoUrl);
        if (logoUrl && name) companyLogosByName.set(name.toLowerCase(), logoUrl);
      }
      if (/(?:School|EducationInstitution|University)/.test(type)) {
        const logoUrl = extractSchoolLogoUrl(entity);
        const urn = schoolUrnFor(entity, true);
        const name = entity.name || entity.schoolName || "";
        if (logoUrl && urn) schoolLogosByUrn.set(urn, logoUrl);
        if (logoUrl && name) schoolLogosByName.set(name.toLowerCase(), logoUrl);
      }
    }
    return { companyLogosByUrn, companyLogosByName, schoolLogosByUrn, schoolLogosByName };
  }

  function companyUrnFor(entity, includeEntityUrn = false) {
    const candidates = [
      entity?.companyUrn,
      entity?.companyEntityUrn,
      entity?.company?.entityUrn,
      typeof entity?.company === "string" ? entity.company : "",
      includeEntityUrn ? entity?.entityUrn : "",
    ];
    return candidates.find((value) => typeof value === "string" && value) || "";
  }

  function schoolUrnFor(entity, includeEntityUrn = false) {
    const candidates = [
      entity?.schoolUrn,
      entity?.schoolEntityUrn,
      entity?.school?.entityUrn,
      typeof entity?.school === "string" ? entity.school : "",
      includeEntityUrn ? entity?.entityUrn : "",
    ];
    return candidates.find((value) => typeof value === "string" && value) || "";
  }

  function memberIdFromUrn(value) {
    if (typeof value !== "string") return "";
    const match = value.match(/(?:fsd_profile|fs_miniProfile|member):([^,)]+)/i);
    return match ? match[1] : "";
  }

  function memberIdFor(entity) {
    const candidates = [
      entity?.entityUrn,
      entity?.trackingUrn,
      entity?.memberUrn,
      entity?.connectedMember,
      entity?.["*connectedMember"],
    ];
    for (const candidate of candidates) {
      const memberId = memberIdFromUrn(candidate);
      if (memberId) return memberId;
    }
    const directId = entity?.memberId || entity?.member?.id || entity?.id;
    return typeof directId === "string" ? directId : "";
  }

  function normalizedMemberExternalId(memberId) {
    if (!memberId) return "";
    return `member_${memberId.toLowerCase().replace(/[^a-z0-9_-]+/g, "_")}`.slice(0, 200);
  }

  // ─── Rust/Wasm capture core ──────────────────────────────────────────────
  //
  // Chrome requires a JavaScript content-script host, but the CPU-heavy
  // Voyager JSON normalization runs in Rust. The exact JavaScript parser stays
  // as a fail-open fallback so a blocked/corrupt Wasm resource cannot strand a
  // user's capture.
  let rustCaptureWorkerPromise = null;

  async function rustCaptureWorker() {
    if (rustCaptureWorkerPromise) return rustCaptureWorkerPromise;
    rustCaptureWorkerPromise = (async () => {
      const response = await fetch(chrome.runtime.getURL("wasm/capture-worker.wasm"), {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Rust capture worker returned ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      const worker = instance.exports;
      if (
        !(worker.memory instanceof WebAssembly.Memory)
        || typeof worker.capture_worker_alloc !== "function"
        || typeof worker.capture_worker_dealloc !== "function"
        || typeof worker.capture_worker_parse_connections !== "function"
      ) {
        throw new Error("Rust capture worker exports are incomplete");
      }
      return worker;
    })().catch((error) => {
      rustCaptureWorkerPromise = null;
      throw error;
    });
    return rustCaptureWorkerPromise;
  }

  async function parseConnectionsWithRust(data) {
    const worker = await rustCaptureWorker();
    const input = new TextEncoder().encode(JSON.stringify(data));
    const inputPointer = worker.capture_worker_alloc(input.byteLength);
    if (!inputPointer) throw new Error("Rust capture worker could not allocate input");
    try {
      new Uint8Array(worker.memory.buffer, inputPointer, input.byteLength).set(input);
      const packed = worker.capture_worker_parse_connections(inputPointer, input.byteLength);
      if (typeof packed !== "bigint" || packed === 0n) {
        throw new Error("Rust capture worker rejected the LinkedIn response");
      }
      const outputPointer = Number(packed & 0xffffffffn);
      const outputLength = Number(packed >> 32n);
      if (!outputPointer || !outputLength) {
        throw new Error("Rust capture worker returned an empty response");
      }
      try {
        const output = new Uint8Array(worker.memory.buffer, outputPointer, outputLength);
        return JSON.parse(new TextDecoder().decode(output));
      } finally {
        worker.capture_worker_dealloc(outputPointer, outputLength);
      }
    } finally {
      worker.capture_worker_dealloc(inputPointer, input.byteLength);
    }
  }

  function parseConnectionElement(element) {
    // The connection data might be at different nesting levels depending on decoration
    const member = element.connectedMemberResolutionResult
                || element.connectedMember
                || element;

    // If member is a URN string rather than an object, we need the included array
    if (typeof member === "string") return null;

    const profile = member.miniProfile || member.profile || member;
    const firstName = profile.firstName || member.firstName || "";
    const lastName = profile.lastName || member.lastName || "";
    const name = `${firstName} ${lastName}`.trim();
    if (!name) return null;

    const publicId = profile.publicIdentifier || member.publicIdentifier || "";
    const memberId = memberIdFor(profile) || memberIdFor(member);
    const externalId = publicId || normalizedMemberExternalId(memberId);
    if (!externalId) return null;

    // LinkedIn calls this a "headline", but in the connections UI it is the
    // freeform description shown beneath the person's name. Treating it as a
    // structured role/company corrupts spreadsheet data, so EarthOS stores it
    // as bio unless the full-profile response supplies a richer About section.
    const bio = profile.headline || member.headline || "";
    const photoUrl = firstImageUrl(
      profile.profilePicture,
      profile.profilePictureDisplayImage,
      profile.displayPhoto,
    );
    const linkedinUrl = publicId ? `https://www.linkedin.com/in/${publicId}` : "";

    return { name, bio, linkedinUrl, externalId, memberId, photoUrl };
  }

  function invalidConnectionObservation(element, index, pageStart) {
    const urn = element?.entityUrn
      || element?.connectedMember
      || element?.["*connectedMember"]
      || null;
    const memberId = memberIdFor(element) || memberIdFromUrn(urn);
    const externalId = normalizedMemberExternalId(memberId)
      || `connection_offset_${pageStart + index}`;
    const firstName = element?.firstName || element?.connectedMemberResolutionResult?.firstName || "";
    const lastName = element?.lastName || element?.connectedMemberResolutionResult?.lastName || "";
    const name = `${firstName} ${lastName}`.trim() || "LinkedIn member";
    return {
      name,
      externalId,
      memberId,
      linkedinUrl: "",
      bio: element?.headline || "",
      photoUrl: firstImageUrl(element?.profilePicture, element?.connectedMemberResolutionResult?.profilePicture),
      _captureIncomplete: true,
      _captureError: "LinkedIn did not expose a resolvable public profile for this connection",
      _sourceOffset: pageStart + index,
      _entityUrn: typeof urn === "string" ? urn : null,
    };
  }

  function parseConnectionsResponseFallback(data) {
    const paging = data.paging || {};
    const pageStart = Number.isInteger(Number(paging.start)) ? Number(paging.start) : 0;
    const included = Array.isArray(data.included) ? data.included : [];
    // `elements` is the authoritative page cardinality. The included fallback
    // is used only for older Voyager decorations that omit elements entirely.
    const rawElements = Array.isArray(data.elements)
      ? data.elements
      : included.filter((item) => item && (item.publicIdentifier || item.entityUrn));
    const connections = rawElements.map((element, index) => {
      let connection = parseConnectionElement(element);
      if (!connection) {
        const memberUrn = element?.connectedMember || element?.["*connectedMember"];
        if (typeof memberUrn === "string") {
          const referencedMemberId = memberIdFromUrn(memberUrn);
          const resolved = included.find((item) =>
            item.entityUrn === memberUrn
            || item["$id"] === memberUrn
            || (referencedMemberId && memberIdFor(item) === referencedMemberId)
          );
          if (resolved) connection = parseConnectionElement(resolved);
        }
      }
      connection = connection || invalidConnectionObservation(element, index, pageStart);
      // The Connection wrapper (not the resolved profile) carries the epoch-ms
      // timestamp of when the two members connected.
      const createdAt = Number(element?.createdAt);
      connection.connectedAt = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null;
      return connection;
    });
    const hasReportedTotal = paging.total !== undefined && paging.total !== null && paging.total !== "";
    const reportedTotal = hasReportedTotal ? Number(paging.total) : NaN;
    const total = Number.isInteger(reportedTotal) && reportedTotal >= 0 ? reportedTotal : null;

    return {
      connections,
      rawCount: rawElements.length,
      total,
      count: Number(paging.count) || rawElements.length,
      start: pageStart,
    };
  }

  async function parseConnectionsResponse(data) {
    let parsed;
    try {
      parsed = await parseConnectionsWithRust(data);
    } catch (error) {
      DEBUG("Rust capture worker unavailable; using JS fallback:", error?.message || error);
      parsed = parseConnectionsResponseFallback(data);
    }
    // Both parsers surface the Connection wrapper's createdAt as epoch ms;
    // normalize to ISO here so rows carry the same timestamp shape as
    // lastInteractionAt. A finite number can still exceed JavaScript Date's
    // representable range, so validate the constructed date before formatting.
    if (Array.isArray(parsed?.connections)) {
      for (const connection of parsed.connections) {
        const epochMs = Number(connection?.connectedAt);
        const connectedDate = Number.isFinite(epochMs) && epochMs > 0
          ? new Date(epochMs)
          : null;
        connection.connectedAt = connectedDate && !Number.isNaN(connectedDate.getTime())
          ? connectedDate.toISOString()
          : null;
      }
    }
    return parsed;
  }

  function reducePageConcurrency(adaptive, serverDelayMs = null) {
    adaptive.pageConcurrency = Math.max(MIN_PAGE_CONCURRENCY, Math.floor(adaptive.pageConcurrency / 2));
    adaptive.cleanWaves = 0;
    adaptive.pageThrottleStreak = Math.max(0, Number(adaptive.pageThrottleStreak) || 0) + 1;
    adaptive.pageAdaptedAt = Date.now();
    const exponentialWait = Math.min(
      RATE_LIMIT_MAX_WAIT_MS,
      RATE_LIMIT_BASE_WAIT_MS * (2 ** Math.min(3, adaptive.pageThrottleStreak - 1)),
    );
    const cooldownMs = Math.max(
      Number.isFinite(serverDelayMs) ? serverDelayMs : 0,
      exponentialWait,
    );
    adaptive.pageCooldownUntil = Math.max(
      Number(adaptive.pageCooldownUntil) || 0,
      Date.now() + cooldownMs + Math.round(Math.random() * 5000),
    );
  }

  function recordCleanWave(adaptive) {
    adaptive.cleanWaves++;
    if (adaptive.cleanWaves >= 2 && adaptive.pageConcurrency < MAX_PAGE_CONCURRENCY) {
      adaptive.pageConcurrency++;
      adaptive.cleanWaves = 0;
      adaptive.pageThrottleStreak = Math.max(0, (Number(adaptive.pageThrottleStreak) || 0) - 1);
    }
  }

  async function waitForPageCooldown(adaptive) {
    while (Number(adaptive.pageCooldownUntil) > Date.now()) {
      if (runtimeState.cancelRequested) throw new Error("Sync canceled");
      const remainingMs = adaptive.pageCooldownUntil - Date.now();
      sendProgress(waitMessage("cooldown", { seconds: remainingMs / 1000, ...runtimeState.syncCounts }));
      await sleep(Math.min(remainingMs, 5000));
    }
    adaptive.pageCooldownUntil = 0;
  }

  function connectionPageUrl(offset) {
    return `/voyager/api/relationships/dash/connections` +
      `?decorationId=${encodeURIComponent(DECORATION_ID)}` +
      `&count=${CONNECTIONS_PER_PAGE}&q=search&start=${offset}`;
  }

  function rowsPerChunkFor(progress) {
    return Number(progress?.rowsPerChunk) === LEGACY_ROWS_PER_CHUNK
      ? LEGACY_ROWS_PER_CHUNK
      : ROWS_PER_CHUNK;
  }

  async function fetchConnectionBlock(sequence, totalConnections, csrfToken, adaptive) {
    const rowsPerChunk = rowsPerChunkFor(adaptive);
    const pagesPerChunk = Math.max(1, Math.ceil(rowsPerChunk / CONNECTIONS_PER_PAGE));
    const blockStart = sequence * rowsPerChunk;
    const offsets = [];
    for (let page = 0; page < pagesPerChunk; page++) {
      const offset = blockStart + page * CONNECTIONS_PER_PAGE;
      if (totalConnections > 0 && offset >= totalConnections) break;
      offsets.push(offset);
    }

    const pages = [];
    const pendingOffsets = [...offsets];
    while (pendingOffsets.length > 0) {
      if (runtimeState.cancelRequested) throw new Error("Sync canceled");
      await waitForPageCooldown(adaptive);
      const wave = pendingOffsets.splice(0, adaptive.pageConcurrency);
      let degraded = false;
      const results = await Promise.allSettled(wave.map(async (offset, waveIndex) => {
        if (waveIndex > 0) await sleep(waveIndex * PAGE_DELAY_MS[0]);
        const data = await apiFetch(connectionPageUrl(offset), {
          headers: apiHeaders(csrfToken),
          onSourceFailure: () => {
            degraded = true;
            adaptive.pageConcurrency = Math.max(
              MIN_PAGE_CONCURRENCY,
              Math.floor(adaptive.pageConcurrency / 2),
            );
            adaptive.cleanWaves = 0;
          },
          retryRateLimit: false,
        }, 4);
        return { offset, parsed: await parseConnectionsResponse(data) };
      }));

      const throttledOffsets = [];
      let longestServerDelay = null;
      for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
        const result = results[resultIndex];
        if (result.status === "fulfilled") {
          pages.push(result.value);
          continue;
        }
        const error = result.reason;
        if (error?.status === 429 || /rate limit/i.test(error?.message || "")) {
          throttledOffsets.push(wave[resultIndex]);
          if (Number.isFinite(error?.retryAfterMs)) {
            longestServerDelay = Math.max(longestServerDelay || 0, error.retryAfterMs);
          }
          continue;
        }
        throw error;
      }

      if (throttledOffsets.length > 0) {
        pendingOffsets.unshift(...throttledOffsets);
        degraded = true;
        reducePageConcurrency(adaptive, longestServerDelay);
        LOG(
          `Connection capture throttled; retrying ${throttledOffsets.length} page(s) `
          + `at ${adaptive.pageConcurrency} parallel`,
        );
        if (adaptive?.startedAt) {
          adaptive.retry = {
            phase: "fetch_cooldown",
            attempt: adaptive.pageThrottleStreak,
            lastError: "LinkedIn rate limit",
            nextRetryAt: new Date(adaptive.pageCooldownUntil).toISOString(),
          };
          await saveProgress(adaptive);
        }
        await waitForPageCooldown(adaptive);
        continue;
      }
      if (!degraded) recordCleanWave(adaptive);
    }

    pages.sort((left, right) => left.offset - right.offset);
    const pageReportedTotal = pages.find((page) => page.parsed.total !== null)?.parsed.total;
    const targetTotal = totalConnections > 0 ? totalConnections : pageReportedTotal;
    const prematurePartial = pages.find((page) =>
      Number.isInteger(targetTotal)
      && page.offset + page.parsed.rawCount < targetTotal
      && page.parsed.rawCount < CONNECTIONS_PER_PAGE
    );
    if (prematurePartial) {
      throw new Error(
        `LinkedIn returned only ${prematurePartial.parsed.rawCount} raw connections at offset ${prematurePartial.offset} before the reported total ${targetTotal}`,
      );
    }
    const terminalPage = pages.find((page) =>
      page.parsed.rawCount < CONNECTIONS_PER_PAGE
      || (Number.isInteger(targetTotal) && page.offset + page.parsed.rawCount >= targetTotal)
    );
    const endOffset = terminalPage
      ? Math.min(
          terminalPage.offset + terminalPage.parsed.rawCount,
          Number.isInteger(targetTotal) ? targetTotal : Number.MAX_SAFE_INTEGER,
        )
      : null;
    const rows = pages
      .filter((page) => terminalPage === undefined || page.offset <= terminalPage.offset)
      .flatMap((page) => page.parsed.connections);
    const block = {
      rows,
      endOffset,
      reportedTotal: Number.isInteger(pageReportedTotal) ? pageReportedTotal : null,
      rawCount: pages[0]?.parsed.rawCount || 0,
    };
    return clipToSample(block, blockStart, sampleLimitOf(adaptive));
  }

  /** The person cap of a test sync, or 0 for a real one. */
  function sampleLimitOf(progress) {
    const limit = Number(progress?.sampleLimit);
    return Number.isInteger(limit) && limit > 0 ? limit : 0;
  }

  /**
   * A test sync sees a network that ends after its first `limit` people. Every
   * block passes through here, so the import, enrichment, and completion checks
   * all agree on that smaller network without knowing it is a test.
   */
  function clipToSample(block, blockStart, limit) {
    if (!limit) return block;
    const room = Math.max(0, limit - blockStart);
    const rows = block.rows.slice(0, room);
    const reachesLimit = blockStart + block.rawCount >= limit || block.endOffset !== null;
    return {
      rows,
      endOffset: reachesLimit ? Math.min(block.endOffset ?? limit, limit) : null,
      reportedTotal: block.reportedTotal === null ? null : Math.min(block.reportedTotal, limit),
      rawCount: Math.min(block.rawCount, room),
    };
  }

  // The content script reached the import API by messaging the worker, which
  // then called api-client. Same operations, same retry policy, no hop — and
  // the lock heartbeat that used to ride on each message is kept explicitly.
  async function dispatchImportOperation(type, payload) {
    await touchLinkedInCapture(runtimeState.captureRunId);
    switch (type) {
      case "PEOPLE_IMPORT_CREATE":
        return createPeopleImport(payload.input || {});
      case "PEOPLE_IMPORT_STATUS":
        return getPeopleImportStatus(payload.importId);
      case "PEOPLE_IMPORT_PUT_CHUNK":
        return putPeopleImportChunk(payload.importId, payload.sequence, payload.rows, {
          sourceCursor: payload.sourceCursor,
          checksum: payload.checksum,
        });
      case "PEOPLE_IMPORT_COMPLETE":
        return completePeopleImport(payload.importId, payload.sourceCursor);
      case "ENRICHMENT_BATCH":
        return uploadEnrichmentBatch(payload.data, payload.clientImportKey);
      case "SOFT_SYNC_CHECK":
        return softSyncCheck(payload.rows);
      default:
        throw new ImportOperationError({ error: `Unknown import operation ${type}` });
    }
  }

  async function sendImportRequest(type, payload, maxAttempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await dispatchImportOperation(type, payload);
        if (response?.error) throw new ImportOperationError(response);
        return response;
      } catch (error) {
        // api-client throws ApiError with the fields the worker used to
        // serialize back over the message channel. Carry them across so a 400
        // stays non-retryable instead of degrading to an unknown status.
        lastError = error instanceof ImportOperationError
          ? error
          : new ImportOperationError({
            error: error?.message || String(error),
            status: Number(error?.status) || 0,
            body: error?.body ?? null,
            retryAfterMs: error?.retryAfterMs ?? null,
            code: error?.code || null,
          });
        const retryable = lastError.status === 0 || lastError.status === 429 || lastError.status >= 500;
        if (!retryable || attempt + 1 >= maxAttempts || runtimeState.cancelRequested) throw lastError;
        await sleep(retryDelay(attempt, lastError.retryAfterMs));
      }
    }
    throw lastError;
  }

  function isAuthError(error) {
    // A signed-out LinkedIn cookie jar is an auth failure just like a 401 —
    // report it to the user instead of rethrowing it as an unknown crash.
    if (error instanceof LinkedInSessionError) return true;
    return error?.status === 401 || error?.status === 403 || /session expired|not authenticated/i.test(error?.message || "");
  }

  // ─── Profile Detail Fetching & Parsing ─────────────────────────────────────

  const ENRICH_STORAGE_KEY = "earthos_li_enrich_progress";
  const ENRICH_BATCH_SIZE = 20;
  const ENRICH_PROGRESS_SAVE_INTERVAL = 500;
  // Two-mode enrichment: start in fast mode, drop to safe mode permanently
  // (for this run) on the first 429. LinkedIn's rate limiter is sticky —
  // once it flags us, staying aggressive just earns more 429s. Safe mode
  // mirrors the prior proven-stable cadence; fast mode is the new aggressive
  // default we use until LinkedIn pushes back.
  const ENRICH_FAST_PARALLEL = 8;
  // 100ms between starts, not 200. The window holds 8 requests open whatever
  // the spacing, so this only decides how fast they are handed out; a profile
  // fetch takes several hundred ms, which means the old gate, not LinkedIn, was
  // what kept the window from filling. Doubling the offered rate is a bet on
  // LinkedIn's tolerance and nothing here can prove it: what makes it safe to
  // take is that the first 429 still jumps the spacing straight to 800ms
  // (ENRICH_SAFE_DELAY_MS below, via applyProfileThrottle) and halves the
  // window, so the cost of being wrong is one throttle, not a flagged account.
  const ENRICH_FAST_DELAY_MS = [100, 250];
  const ENRICH_SAFE_PARALLEL = 5;
  const ENRICH_SAFE_DELAY_MS = [800, 1500];
  const ENRICH_RATE_LIMIT_WAIT_MS = RATE_LIMIT_BASE_WAIT_MS;
  const ENRICH_MIN_PARALLEL = 1;
  const ENRICH_MAX_SPACING_MS = 4000;
  const ENRICH_MAX_RATE_LIMIT_WAIT_MS = RATE_LIMIT_MAX_WAIT_MS;
  const ENRICH_RECOVERY_CLEAN_PROFILES = 24;
  const ENRICH_CIRCUIT_BREAKER = 3;
  // How many profiles LinkedIn may refuse in a row before the run stops
  // believing the refusals are about the profiles. See `refusalBudget`.
  const ENRICH_MAX_PROFILE_REFUSALS = 10;
  // How long the enrichment drain waits when the base pass has not yet made
  // another sequence durable. Short enough not to be the thing that paces a
  // capture, long enough not to spin.
  const DRAIN_IDLE_POLL_MS = 150;

  // Profile API endpoints — try dash endpoint first (current), fall back to legacy
  const PROFILE_ENDPOINTS = [
    (id) => `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`,
    (id) => `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-92`,
    (id) => `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}`,
    (id) => `/voyager/api/identity/profiles/${encodeURIComponent(id)}/profileView`,
  ];
  let workingEndpointIndex = 0; // Cache which endpoint works

  /**
   * Ask for many profiles in one request.
   *
   * The finder above answers about one person per round trip, which is what
   * made enrichment the longest phase of a capture: three thousand connections
   * meant three thousand requests. The Rest.li batch form of the same resource
   * takes a list of profile URNs and returns the identical records under
   * `results`, keyed by URN. Measured against a live account, fifty profiles
   * cost one request and about 60ms each against 470ms each one at a time.
   *
   * The reason that is worth more than the arithmetic suggests: LinkedIn's
   * rate limiter counts requests, not people. Eight parallel single fetches
   * with no spacing earned a 429 after 61 profiles in roughly two seconds,
   * while the same hundred people asked for as two batches drew none, and
   * forty batch requests in a row — two thousand profiles — drew none either.
   *
   * The batch is addressed by URN because that is the resource's own key. The
   * connection rows already carry the member id it is built from, so nothing
   * extra has to be fetched to name anyone.
   */
  const PROFILE_BATCH_DECORATION =
    "com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93";
  const PROFILE_BATCH_MAX_SIZE = 50;
  /** Failed batches, with none ever accepted, that mean the shape is wrong. */
  const PROFILE_BATCH_GIVE_UP_AFTER = 3;

  let batchProfilesSupported = true;
  let batchProfilesEverWorked = false;
  let batchProfileFailures = 0;

  /**
   * Give the batch endpoint a fresh hearing at the top of every run.
   *
   * Giving up is a decision about the shape LinkedIn is serving today, not a
   * permanent fact, and a worker lives across many captures. Keeping the
   * verdict for the life of the process would mean one afternoon's outage
   * costs every later capture the whole speedup, with nothing short of a
   * browser restart to undo it.
   */
  function resetProfileBatchSupport() {
    batchProfilesSupported = true;
    batchProfilesEverWorked = false;
    batchProfileFailures = 0;
  }

  function profileUrnFor(connection) {
    const memberId = connection?.memberId;
    return typeof memberId === "string" && memberId
      ? `urn:li:fsd_profile:${memberId}`
      : null;
  }

  function profileBatchUrl(urns) {
    const ids = urns.map((urn) => encodeURIComponent(urn)).join(",");
    return `/voyager/api/identity/dash/profiles?ids=List(${ids})`
      + `&decorationId=${PROFILE_BATCH_DECORATION}`;
  }

  async function fetchProfileBatch(urns, csrfToken, options = {}) {
    const { retries = 3, ...requestOptions } = options;
    return apiFetch(
      profileBatchUrl(urns),
      { headers: apiHeaders(csrfToken), ...requestOptions },
      retries,
    );
  }

  /**
   * Whether a failed batch is worth re-asking as two smaller ones.
   *
   * LinkedIn answers a batch containing one profile it will not serve with a
   * flat 403 and an empty body — no per-entry error map, no partial results —
   * so the only way to learn which URN it objected to is to ask for fewer. A
   * 429 is about the request rather than its contents and splitting it would
   * only make two more; a 5xx or a network failure has already been retried by
   * `apiFetch` and says nothing about any particular person.
   */
  function isSplittableBatchError(error) {
    return error?.status === 400
      || error?.status === 403
      || error?.status === 404
      || error?.status === 410;
  }

  function noteBatchFailure() {
    if (batchProfilesEverWorked) return;
    batchProfileFailures++;
    if (batchProfileFailures < PROFILE_BATCH_GIVE_UP_AFTER) return;
    // Three batches rejected and not one ever accepted is not a bad URN, it is
    // a batch endpoint that no longer takes this shape. Fall back to the
    // per-profile finder for the rest of the run rather than paying a failed
    // request per split to rediscover that on every group.
    batchProfilesSupported = false;
    LOG("Batch profile endpoint kept rejecting — falling back to per-profile fetches");
  }

  /**
   * One profile, and a decision about what a refusal means.
   *
   * A 403 on a single profile is normally one person who went private, was
   * deleted, or blocked the account between the listing and the enrichment;
   * the run should record that and carry on. But a signed-out session refuses
   * every profile with the same status, and quietly filing three thousand rows
   * as "unavailable" would be a wrong answer with nothing to show for it.
   * Refusals with no success in between is what separates the two, so the
   * budget is what decides — not the status.
   */
  async function resolveOneProfile(item, csrfToken, requestOptions, budget) {
    try {
      const data = await fetchProfileDetails(item.publicId, csrfToken, requestOptions);
      budget.refusals = 0;
      return { item, parsed: parseProfileView(data) };
    } catch (error) {
      if (error?.status !== 403) return { item, error };
      budget.refusals++;
      if (budget.refusals > budget.limit) {
        const fatal = new LinkedInApiError(
          `LinkedIn refused ${budget.refusals} profiles in a row — `
          + "sign in to linkedin.com again, then retry.",
          error.status,
        );
        fatal.sessionRefusal = true;
        throw fatal;
      }
      return { item, error };
    }
  }

  /**
   * Resolve a group of profiles, blaming the smallest set of them it can.
   *
   * Because one bad URN fails the whole request, a single connection who went
   * private since the listing would otherwise cost the forty-nine people
   * batched with them. A failure a smaller request might survive halves the
   * group and re-asks for both halves, which isolates the bad URN in about
   * 2·log2(n) extra requests and still returns everybody else. The halves go
   * one after another, not together: a group is one slot in the enrichment
   * window, and a splitting group must not quietly become two.
   *
   * At a group of one there is nothing left to split, so the per-profile finder
   * answers instead. It is the endpoint that can say "unavailable" about
   * exactly one person, and it also covers a row whose member id never made it
   * as far as a URN.
   */
  async function resolveProfileGroup(items, csrfToken, requestOptions, budget) {
    if (items.length === 0) return [];

    const canBatch = batchProfilesSupported && items.every((item) => item.profileUrn);

    if (!canBatch) {
      const settlements = [];
      for (const item of items) {
        settlements.push(await resolveOneProfile(item, csrfToken, requestOptions, budget));
      }
      return settlements;
    }

    let data;
    try {
      data = await fetchProfileBatch(
        items.map((item) => item.profileUrn), csrfToken, requestOptions,
      );
    } catch (error) {
      if (!isSplittableBatchError(error)) throw error;
      noteBatchFailure();
      // Nothing left to split. Ask the finder, which can say "unavailable"
      // about one person where the batch form can only fail whole.
      if (items.length === 1) {
        return [await resolveOneProfile(items[0], csrfToken, requestOptions, budget)];
      }
      const middle = Math.floor(items.length / 2);
      const head = await resolveProfileGroup(
        items.slice(0, middle), csrfToken, requestOptions, budget,
      );
      const tail = await resolveProfileGroup(
        items.slice(middle), csrfToken, requestOptions, budget,
      );
      return [...head, ...tail];
    }

    // A batch LinkedIn answered proves the session is alive, whatever it did
    // or did not contain.
    batchProfilesEverWorked = true;
    batchProfileFailures = 0;
    budget.refusals = 0;

    const results = data?.results && typeof data.results === "object" ? data.results : {};
    return items.map((item) => {
      const profile = results[item.profileUrn];
      // Asked for and not returned. The batch form drops such a record rather
      // than reporting it, which is the same answer the finder gives as a 404.
      if (!profile) {
        return { item, error: new LinkedInApiError("LinkedIn did not return this profile.", 404) };
      }
      // A batch record is the same shape the finder puts in `elements`, so the
      // existing parser reads it unchanged.
      return { item, parsed: parseProfileView({ elements: [profile], included: data?.included }) };
    });
  }

  async function fetchProfileDetails(publicIdentifier, csrfToken, options = {}) {
    const headers = apiHeaders(csrfToken);
    const { retries = 3, ...requestOptions } = options;

    // Try the last-known working endpoint first
    for (let attempt = workingEndpointIndex; attempt < PROFILE_ENDPOINTS.length; attempt++) {
      const url = PROFILE_ENDPOINTS[attempt](publicIdentifier);
      try {
        const data = await apiFetch(url, { headers, ...requestOptions }, retries);
        if (attempt !== workingEndpointIndex) {
          LOG(`Profile endpoint #${attempt} works, caching for future calls`);
          workingEndpointIndex = attempt;
        }
        return data;
      } catch (err) {
        // 410 Gone or 404 = endpoint is dead, try next one
        if (err.message.includes("410") || err.message.includes("404")) {
          DEBUG(`Endpoint #${attempt} returned ${err.message}, trying next...`);
          continue;
        }
        // Any other error (429, 401, network) — don't try other endpoints, just throw
        throw err;
      }
    }
    throw new Error("All profile API endpoints returned 410/404 — LinkedIn may have changed their API");
  }

  function formatDate(dateObj) {
    if (!dateObj) return "";
    const y = dateObj.year;
    const m = dateObj.month;
    if (!y) return "";
    return m ? `${y}-${String(m).padStart(2, "0")}` : `${y}`;
  }

  function parseExperience(entity, group = {}) {
    const company = entity.companyName || entity.company?.name || group.company || "";
    return {
      title: entity.title || "",
      company,
      companyUrn: companyUrnFor(entity) || group.companyUrn || "",
      companyLogoUrl: extractCompanyLogoUrl(entity) || group.companyLogoUrl || "",
      location: entity.locationName || entity.geoLocationName || "",
      startDate: formatDate(entity.timePeriod?.startDate || entity.dateRange?.start),
      endDate: formatDate(entity.timePeriod?.endDate || entity.dateRange?.end),
      description: entity.description || "",
      isCurrent: !!(entity.timePeriod && !entity.timePeriod.endDate) || !!(entity.dateRange && !entity.dateRange.end),
    };
  }

  function parseEducation(entity, schoolDetails = {}) {
    const school = entity.schoolName || entity.school?.name || schoolDetails.school || "";
    return {
      school,
      schoolUrn: schoolUrnFor(entity) || schoolDetails.schoolUrn || "",
      schoolLogoUrl: extractSchoolLogoUrl(entity) || schoolDetails.schoolLogoUrl || "",
      degree: entity.degreeName || entity.degree || "",
      field: entity.fieldOfStudy || "",
      startDate: formatDate(entity.timePeriod?.startDate || entity.dateRange?.start),
      endDate: formatDate(entity.timePeriod?.endDate || entity.dateRange?.end),
    };
  }

  function parseCertification(entity) {
    return {
      name: entity.name || "",
      issuingOrg: entity.authority || entity.company?.name || "",
      startDate: formatDate(entity.timePeriod?.startDate),
      endDate: formatDate(entity.timePeriod?.endDate),
      credentialId: entity.licenseNumber || "",
    };
  }

  function parseVolunteering(entity) {
    return {
      role: entity.role || entity.title || "",
      organization: entity.companyName || entity.company?.name || "",
      cause: entity.cause || "",
      startDate: formatDate(entity.timePeriod?.startDate || entity.dateRange?.start),
      endDate: formatDate(entity.timePeriod?.endDate || entity.dateRange?.end),
    };
  }

  function parseProfileView(data) {
    const result = {
      bio: "",
      industry: "",
      location: "",
      photoUrl: "",
      companyPhotoUrl: "",
      experience: [],
      education: [],
      skills: [],
      languages: [],
      licenses: [],
      volunteering: [],
    };

    if (!data) return result;

    // Dash endpoint format: { elements: [profile], paging }
    if (data.elements && Array.isArray(data.elements) && data.elements.length > 0) {
      const profile = data.elements[0];

      result.bio = profile.summary || "";
      result.industry = profile.industryName || profile.industry?.name || "";
      result.location = profile.geoLocation?.geo?.defaultLocalizedNameWithoutCountryName
        || profile.address || profile.locationName || "";
      result.photoUrl = firstImageUrl(
        profile.profilePicture,
        profile.profilePictureDisplayImage,
        profile.displayPhoto,
      );

      // The Dash decoration nests the sections, but the logos still live on
      // company/school entities in the companion `included` array when there
      // is one. Reading it here is what stops this path from parsing an
      // experience list with every logo missing — which a later capture would
      // then merge over the top of a stored list that had them.
      const {
        companyLogosByUrn, companyLogosByName, schoolLogosByUrn, schoolLogosByName,
      } = buildLogoLookups(data.included);

      // Experience — nested under profilePositionGroups
      const posGroups = profile.profilePositionGroups?.elements || [];
      for (const group of posGroups) {
        const company = group.companyName || group.name || group.company?.name || "";
        const companyUrn = companyUrnFor(group);
        // parseExperience prefers a logo on the position itself; this is the
        // fallback for the whole group.
        const companyLogoUrl = extractCompanyLogoUrl(group)
          || extractCompanyLogoUrl(group.company)
          || companyLogosByUrn.get(companyUrn)
          || companyLogosByName.get(company.toLowerCase())
          || "";
        const positions = group.profilePositionInPositionGroup?.elements || [];
        for (const pos of positions) {
          result.experience.push(parseExperience(pos, { company, companyUrn, companyLogoUrl }));
        }
      }

      // Education. The school details are resolved here rather than left to
      // parseEducation's entity-only lookup, which on this path found neither
      // the logo nor the school URN.
      const eduEntries = profile.profileEducations?.elements || [];
      for (const edu of eduEntries) {
        const school = edu.schoolName || edu.school?.name || "";
        const schoolUrn = schoolUrnFor(edu);
        const schoolLogoUrl = extractSchoolLogoUrl(edu)
          || extractSchoolLogoUrl(edu.school)
          || schoolLogosByUrn.get(schoolUrn)
          || schoolLogosByName.get(school.toLowerCase())
          || "";
        result.education.push(parseEducation(edu, { school, schoolUrn, schoolLogoUrl }));
      }

      // Skills
      const skillEntries = profile.profileSkills?.elements || [];
      for (const s of skillEntries) {
        if (s.name) result.skills.push(s.name);
      }

      // Languages
      const langEntries = profile.profileLanguages?.elements || [];
      for (const l of langEntries) {
        if (l.name) result.languages.push(l.name);
      }

      // Certifications
      const certEntries = profile.profileCertifications?.elements || [];
      for (const c of certEntries) {
        result.licenses.push(parseCertification(c));
      }

      // Volunteering
      const volEntries = profile.profileVolunteerExperiences?.elements || [];
      for (const v of volEntries) {
        result.volunteering.push(parseVolunteering(v));
      }

      result.companyPhotoUrl = result.experience.find((entry) => entry.isCurrent && entry.companyLogoUrl)?.companyLogoUrl
        || result.experience.find((entry) => entry.companyLogoUrl)?.companyLogoUrl
        || "";
      return result;
    }

    // Legacy format: { included: [...] } — kept as fallback
    if (!data.included || !Array.isArray(data.included)) return result;

    const {
      companyLogosByUrn, companyLogosByName, schoolLogosByUrn, schoolLogosByName,
    } = buildLogoLookups(data.included);

    for (const entity of data.included) {
      const type = entity["$type"] || "";

      if (type.includes("Profile") && !type.includes("Position") && !type.includes("Education") &&
          !type.includes("Skill") && !type.includes("Language") && !type.includes("Certification") &&
          !type.includes("Volunteer")) {
        if (entity.summary && !result.bio) result.bio = entity.summary;
        if (entity.industryName && !result.industry) result.industry = entity.industryName;
        if (entity.geoLocationName && !result.location) result.location = entity.geoLocationName;
        if (entity.locationName && !result.location) result.location = entity.locationName;
        if (!result.photoUrl) {
          result.photoUrl = firstImageUrl(
            entity.profilePicture,
            entity.profilePictureDisplayImage,
            entity.displayPhoto,
          );
        }
      }

      if (type.includes("Position")) {
        const company = entity.companyName || entity.company?.name || "";
        const companyUrn = companyUrnFor(entity);
        const companyLogoUrl = extractCompanyLogoUrl(entity)
          || companyLogosByUrn.get(companyUrn)
          || companyLogosByName.get(company.toLowerCase())
          || "";
        result.experience.push(parseExperience(entity, { company, companyUrn, companyLogoUrl }));
      } else if (type.includes("Education")) {
        const school = entity.schoolName || entity.school?.name || "";
        const schoolUrn = schoolUrnFor(entity);
        const schoolLogoUrl = extractSchoolLogoUrl(entity)
          || schoolLogosByUrn.get(schoolUrn)
          || schoolLogosByName.get(school.toLowerCase())
          || "";
        result.education.push(parseEducation(entity, { school, schoolUrn, schoolLogoUrl }));
      } else if (type.includes("Skill")) {
        if (entity.name) result.skills.push(entity.name);
      } else if (type.includes("Language")) {
        if (entity.name) result.languages.push(entity.name);
      } else if (type.includes("Certification")) {
        result.licenses.push(parseCertification(entity));
      } else if (type.includes("Volunteer")) {
        result.volunteering.push(parseVolunteering(entity));
      }
    }

    result.companyPhotoUrl = result.experience.find((entry) => entry.isCurrent && entry.companyLogoUrl)?.companyLogoUrl
      || result.experience.find((entry) => entry.companyLogoUrl)?.companyLogoUrl
      || "";
    return result;
  }

  function extractPublicIdentifier(linkedinUrl) {
    if (!linkedinUrl) return null;
    const match = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function mergeProfileDetails(connection, parsed) {
    return {
      ...connection,
      // The base row's `bio` is LinkedIn's headline; keep it once the About
      // section takes that slot.
      headline: connection.headline || connection.bio || "",
      bio: parsed.bio || connection.bio || "",
      industry: parsed.industry || connection.industry || "",
      location: parsed.location || connection.location || "",
      photoUrl: parsed.photoUrl || connection.photoUrl || "",
      companyPhotoUrl: parsed.companyPhotoUrl || connection.companyPhotoUrl || "",
      experience: parsed.experience.length > 0 ? parsed.experience : (connection.experience || []),
      education: parsed.education.length > 0 ? parsed.education : (connection.education || []),
      skills: parsed.skills.length > 0 ? parsed.skills : (connection.skills || []),
      languages: parsed.languages.length > 0 ? parsed.languages : (connection.languages || []),
      licenses: parsed.licenses.length > 0 ? parsed.licenses : (connection.licenses || []),
      volunteering: parsed.volunteering.length > 0 ? parsed.volunteering : (connection.volunteering || []),
      _earthosEnrichment: { status: "complete", capturedAt: new Date().toISOString() },
    };
  }

  /**
   * How long a learned throttle still describes LinkedIn.
   *
   * The pace is deliberately sticky within a run: a 429 means the next request
   * should be slower, and forgetting that between waves would just earn another
   * one. It is not sticky across time. The checkpoint outlives the run that
   * wrote it — it survives worker restarts, resumes, and every later capture
   * until one completes — so without an expiry a single throttle an hour ago
   * still costs 1 parallel and 4s of spacing today, roughly fourteen times
   * slower than the fast pace, with no way for the user to clear it short of
   * finishing an import.
   *
   * Recovery cannot do this on its own: a throttle doubles the spacing at once
   * while recovery only takes 20% off per 24 clean profiles, so a run that is
   * throttled even occasionally ratchets to the floor and stays there.
   */
  const ADAPTIVE_PACE_MAX_AGE_MS = 30 * 60 * 1000;

  function createProfileAdaptive() {
    return {
      parallel: ENRICH_FAST_PARALLEL,
      spacingMs: ENRICH_FAST_DELAY_MS[0],
      cleanProfiles: 0,
      throttleStreak: 0,
      cooldownUntil: 0,
      adaptedAt: 0,
    };
  }

  function sanitizeProfileAdaptive(value) {
    const source = value && typeof value === "object" ? value : {};
    const adaptedAt = Math.max(0, Number(source.adaptedAt) || 0);
    // A pace nobody has re-confirmed in half an hour is a guess about a
    // LinkedIn that has moved on. Start fast again and let a live 429 — not a
    // stale one — decide otherwise.
    if (adaptedAt && Date.now() - adaptedAt > ADAPTIVE_PACE_MAX_AGE_MS) {
      return createProfileAdaptive();
    }
    return {
      parallel: Math.max(
        ENRICH_MIN_PARALLEL,
        Math.min(ENRICH_FAST_PARALLEL, Number(source.parallel) || ENRICH_FAST_PARALLEL),
      ),
      spacingMs: Math.max(
        ENRICH_FAST_DELAY_MS[0],
        Math.min(ENRICH_MAX_SPACING_MS, Number(source.spacingMs) || ENRICH_FAST_DELAY_MS[0]),
      ),
      cleanProfiles: Math.max(0, Number(source.cleanProfiles) || 0),
      throttleStreak: Math.max(0, Number(source.throttleStreak) || 0),
      cooldownUntil: Math.max(0, Number(source.cooldownUntil) || 0),
      adaptedAt,
    };
  }

  function applyProfileThrottle(adaptive, serverDelayMs = null) {
    adaptive.parallel = Math.max(ENRICH_MIN_PARALLEL, Math.floor(adaptive.parallel / 2));
    adaptive.spacingMs = Math.min(
      ENRICH_MAX_SPACING_MS,
      Math.max(ENRICH_SAFE_DELAY_MS[0], Math.round(adaptive.spacingMs * 2)),
    );
    adaptive.cleanProfiles = 0;
    adaptive.throttleStreak++;
    adaptive.adaptedAt = Date.now();

    const exponentialWait = Math.min(
      ENRICH_MAX_RATE_LIMIT_WAIT_MS,
      ENRICH_RATE_LIMIT_WAIT_MS * (2 ** Math.min(3, adaptive.throttleStreak - 1)),
    );
    const cooldownMs = Math.max(
      Number.isFinite(serverDelayMs) ? serverDelayMs : 0,
      exponentialWait,
    );
    // Small jitter prevents several pending requests from resuming together.
    adaptive.cooldownUntil = Math.max(
      adaptive.cooldownUntil,
      Date.now() + cooldownMs + Math.round(Math.random() * 5000),
    );
  }

  function recordCleanProfiles(adaptive, count) {
    adaptive.cleanProfiles += count;
    if (adaptive.cleanProfiles < ENRICH_RECOVERY_CLEAN_PROFILES) return false;

    adaptive.cleanProfiles = 0;
    adaptive.throttleStreak = Math.max(0, adaptive.throttleStreak - 1);
    adaptive.cooldownUntil = 0;
    if (adaptive.parallel < ENRICH_FAST_PARALLEL) adaptive.parallel++;
    // Halved, mirroring the doubling a throttle applies. At 20% a step the two
    // are not symmetric: one 429 undid three recoveries, so a run that met a
    // throttle now and then only ever descended, and each step down made the
    // next recovery slower to earn because the profiles come in more slowly.
    adaptive.spacingMs = Math.max(
      ENRICH_FAST_DELAY_MS[0],
      Math.round(adaptive.spacingMs / 2),
    );
    // Fully recovered is not a throttled state to expire; clearing the stamp
    // keeps it out of the staleness check entirely.
    adaptive.adaptedAt = adaptive.parallel >= ENRICH_FAST_PARALLEL
      && adaptive.spacingMs <= ENRICH_FAST_DELAY_MS[0]
      ? 0
      : Date.now();
    LOG(`Detailed capture recovered to ${adaptive.parallel} parallel, ${adaptive.spacingMs}ms spacing`);
    return true;
  }

  async function waitForProfileCooldown(adaptive) {
    while (adaptive.cooldownUntil > Date.now()) {
      if (runtimeState.cancelRequested) throw new Error("Sync canceled");
      const remainingMs = adaptive.cooldownUntil - Date.now();
      sendProgress(waitMessage("cooldown", { seconds: remainingMs / 1000, ...runtimeState.syncCounts }));
      await sleep(Math.min(remainingMs, 5000));
    }
    adaptive.cooldownUntil = 0;
  }

  /**
   * Enrich one page-size batch after its base rows are durable. The caller
   * checkpoints the sequence as pending first, so an interrupted enrichment is
   * safely refetched and replayed under the same idempotency key on resume.
   */
  async function enrichConnectionBlock(
    connections,
    csrfToken,
    blockStart,
    totalConnections,
    adaptiveState = null,
    onThrottleStateChange = async () => {},
  ) {
    const enriched = new Array(connections.length);
    const normalized = sanitizeProfileAdaptive(adaptiveState);
    const adaptive = adaptiveState && typeof adaptiveState === "object" ? adaptiveState : normalized;
    Object.assign(adaptive, normalized);
    const pending = [];
    let completed = 0;
    let fullyEnriched = 0;
    let unavailable = 0;

    for (let index = 0; index < connections.length; index++) {
      const connection = connections[index];
      const publicId = extractPublicIdentifier(connection.linkedinUrl);
      if (!publicId) {
        // Preserve invalid observations so the row-level API reports them;
        // never let one malformed LinkedIn item truncate the import.
        enriched[index] = connection;
        completed++;
        unavailable++;
        continue;
      }
      pending.push({ index, connection, publicId, profileUrn: profileUrnFor(connection) });
    }

    // A continuous window, not a wave.
    //
    // The engine used to launch `adaptive.parallel` profile fetches staggered
    // by `spacingMs`, wait for every one of them, sleep another `spacingMs`,
    // and only then start the next batch. That makes the slowest profile in
    // each wave the pace-setter for the seven that already finished: eight
    // 400ms requests spread across a 2.0s wave average 1.4 requests in flight
    // against a ceiling of 8, and leave the connection idle a fifth of the run.
    //
    // The window keeps both promises the wave made to LinkedIn — never more
    // than `parallel` requests at once, never two starts closer together than
    // `spacingMs` — but refills as each request lands instead of at a barrier.
    // Nothing about the request rate LinkedIn sees changes; the gaps between
    // requests do.
    const inFlight = new Map();
    // Block-wide, not per group: a signed-out session refuses every group at
    // once, and the point of the budget is to notice that before the whole
    // block is quietly filed as unavailable.
    const refusalBudget = { refusals: 0, limit: ENRICH_MAX_PROFILE_REFUSALS };
    const isThrottleError = (error) => !!error
      && (error.status === 429 || /rate limit/i.test(error.message || ""));
    const settled = [];
    const throttledItems = [];
    let longestServerDelay = null;
    let throttleHit = false;
    let cleanSinceRecoveryCheck = 0;
    let nextStartAt = 0;

    /** Hold every start `spacingMs` apart, however the window happens to drain. */
    async function waitForStartSlot() {
      const wait = nextStartAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextStartAt = Math.max(Date.now(), nextStartAt) + adaptive.spacingMs;
    }

    /**
     * How many profiles to ask for in one request.
     *
     * Enough to fill the window and no more: a block of 25 across 8 slots goes
     * out as groups of 4, which keeps every slot busy, where asking for the
     * whole block at once would be one request and seven idle slots. A
     * throttled run inverts the same arithmetic — down at one slot the rest of
     * the block becomes a single request — which is what a limiter counting
     * requests rather than people is asking for anyway.
     *
     * Planned per block rather than per start, and revised only when the pace
     * itself changes. Sizing off the slots that happen to be free at the
     * instant of a start sounds equivalent, but it is not: the window drains
     * between starts, so each group would be measured against an emptier
     * window than the last and the sizes would ratchet back towards one.
     */
    function planGroupSize() {
      if (!batchProfilesSupported) return 1;
      return Math.max(
        1,
        Math.min(PROFILE_BATCH_MAX_SIZE, Math.ceil(pending.length / adaptive.parallel)),
      );
    }
    let plannedGroupSize = planGroupSize();

    /** Take the next group off `pending`, keeping URN-less rows on their own. */
    function takeGroup() {
      const size = plannedGroupSize;
      const first = pending.shift();
      if (!batchProfilesSupported || !first.profileUrn) return [first];
      const group = [first];
      while (group.length < size && pending[0]?.profileUrn) group.push(pending.shift());
      return group;
    }

    function launch(group) {
      const key = group[0].index;
      const task = (async () => {
        try {
          const resolved = await resolveProfileGroup(
            group,
            csrfToken,
            { retries: 1, retryRateLimit: false },
            refusalBudget,
          );
          settled.push(...resolved);
          // Recovery counts requests, not people: one clean batch of fifty is
          // one piece of evidence that the pace is survivable, not fifty.
          if (!resolved.some(({ error }) => isThrottleError(error))) cleanSinceRecoveryCheck++;
        } catch (error) {
          // A failure the group could not pin on anyone belongs to all of them.
          for (const item of group) settled.push({ item, error });
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, task);
    }

    /** Fold everything that has landed into the block, throwing on a fatal error. */
    function harvest() {
      for (const { item, parsed, error } of settled.splice(0)) {
        if (!error) {
          enriched[item.index] = mergeProfileDetails(item.connection, parsed);
          completed++;
          fullyEnriched++;
          continue;
        }
        if (isThrottleError(error)) {
          // Keep fulfilled results and retry only the throttled profiles.
          // Replaying everything in flight amplified rate limits and
          // duplicated successful work.
          throttledItems.push(item);
          throttleHit = true;
          if (Number.isFinite(error?.retryAfterMs)) {
            longestServerDelay = Math.max(longestServerDelay || 0, error.retryAfterMs);
          }
          continue;
        }
        if (error?.sessionRefusal) throw error;
        if (error?.status === 403 || error?.status === 404 || error?.status === 410) {
          // Private/deleted profiles are still useful connection observations,
          // but explicitly record why no detailed record was available. A 403
          // reaches here only once `refusalBudget` has satisfied itself that
          // the refusal is about this profile and not about the session.
          enriched[item.index] = {
            ...item.connection,
            _earthosEnrichment: { status: "unavailable", httpStatus: error.status },
          };
          completed++;
          unavailable++;
          continue;
        }
        throw error;
      }
    }

    while (pending.length > 0 || inFlight.size > 0) {
      if (runtimeState.cancelRequested) throw new Error("Sync canceled");
      await waitForProfileCooldown(adaptive);

      while (!throttleHit && inFlight.size < adaptive.parallel && pending.length > 0) {
        // The pace gate is the one place a start waits, so re-check the run's
        // state across it rather than launching into a cancel or a throttle.
        await waitForStartSlot();
        if (runtimeState.cancelRequested) throw new Error("Sync canceled");
        harvest();
        if (throttleHit) break;
        launch(takeGroup());
      }

      if (inFlight.size > 0) await Promise.race(inFlight.values());
      harvest();

      if (throttleHit) {
        // Let the window drain before backing off: a request already in the
        // air cannot be recalled, and its result is worth keeping.
        await Promise.allSettled([...inFlight.values()]);
        harvest();
        const throttledCount = throttledItems.length;
        pending.unshift(...throttledItems.splice(0));
        const serverDelayMs = longestServerDelay;
        longestServerDelay = null;
        throttleHit = false;
        // The window reopens at the new pace rather than honouring a gate the
        // old spacing set.
        nextStartAt = 0;
        applyProfileThrottle(adaptive, serverDelayMs);
        plannedGroupSize = planGroupSize();
        await onThrottleStateChange(adaptive);
        LOG(
          `Detailed capture throttled; retrying ${throttledCount} profile(s) at `
          + `${adaptive.parallel} parallel / ${adaptive.spacingMs}ms spacing`,
        );
        await waitForProfileCooldown(adaptive);
        continue;
      }

      if (cleanSinceRecoveryCheck > 0) {
        if (recordCleanProfiles(adaptive, cleanSinceRecoveryCheck)) {
          plannedGroupSize = planGroupSize();
        }
        cleanSinceRecoveryCheck = 0;
      }
    }

    return { rows: enriched, enrichedCount: fullyEnriched, unavailableCount: unavailable };
  }

  // ─── Enrichment Progress Persistence ──────────────────────────────────────

  async function loadEnrichProgress() {
    const data = await chrome.storage.local.get(ENRICH_STORAGE_KEY);
    const progress = data[ENRICH_STORAGE_KEY];
    if (!progress) return null;
    // No max age for enrichment — user controls via pause/resume
    return progress;
  }

  async function saveEnrichProgress(progress) {
    progress.updatedAt = Date.now();
    await chrome.storage.local.set({ [ENRICH_STORAGE_KEY]: progress });
  }

  async function clearEnrichProgress() {
    await chrome.storage.local.remove(ENRICH_STORAGE_KEY);
  }

  // ─── Bulk Enrichment State Machine ────────────────────────────────────────

  async function startEnrichment(connections) {
    if (runtimeState.enrichmentRunning) {
      LOG("Enrichment already running");
      return { error: "Enrichment already in progress" };
    }

    runtimeState.enrichmentRunning = true;
    enrichmentPaused = false;

    const csrfToken = await extractCsrfToken();

    // Check for resumable progress
    let progress = await loadEnrichProgress();
    let resumed = false;

    if (progress && progress.currentIndex < progress.totalConnections) {
      resumed = true;
      LOG(`Resuming enrichment from index ${progress.currentIndex}/${progress.totalConnections}`);
    } else {
      progress = {
        startedAt: Date.now(),
        updatedAt: Date.now(),
        totalConnections: connections.length,
        enrichedCount: 0,
        currentIndex: 0,
        paused: false,
        connections: connections,
        failedUrls: [],
        batchesSent: 0,
      };
      await saveEnrichProgress(progress);
    }

    sendEnrichProgress(progress);

    let consecutiveFailures = 0;
    const enrichedBatch = [];
    let pendingBatchStartIndex = null;
    let lastSavedIndex = progress.currentIndex;
    let stoppedEarlyReason = "";

    async function uploadEnrichmentBatchWithRetry(batch) {
      let lastError = null;
      const retryDelays = [0, 1000, 3000];
      for (const retryDelay of retryDelays) {
        if (retryDelay > 0) await sleep(retryDelay);
        try {
          const response = await uploadEnrichmentBatch(
            batch,
            `linkedin-enrichment-${progress.startedAt}-${progress.batchesSent}`,
          );
          if (response?.error) throw new Error(response.error);
          return;
        } catch (err) {
          lastError = err;
          ERR(`Enrichment batch upload failed: ${err.message}`);
        }
      }
      throw lastError || new Error("Enrichment batch upload failed");
    }

    // Per-run adaptive pace. Throttles reduce concurrency and add spacing;
    // sustained clean work gradually recovers throughput.
    const adaptive = createProfileAdaptive();
    let parallel = adaptive.parallel;
    let delayMs = [adaptive.spacingMs, adaptive.spacingMs * 2];
    let pace = "adaptive";
    LOG(`Enrichment starting at ${parallel} parallel, ${delayMs[0]}-${delayMs[1]}ms delay`);

    function syncAdaptivePace() {
      parallel = adaptive.parallel;
      delayMs = [adaptive.spacingMs, Math.min(ENRICH_MAX_SPACING_MS, adaptive.spacingMs * 2)];
      pace = parallel === ENRICH_FAST_PARALLEL ? "fast" : "adaptive";
    }

    try {
      for (let i = progress.currentIndex; i < progress.connections.length; i += parallel) {
        const chunkParallel = parallel;
        if (runtimeState.cancelRequested) {
          LOG("Enrichment canceled by user");
          runtimeState.enrichmentRunning = false;
          return { canceled: true, enriched: progress.enrichedCount };
        }
        // Check for pause
        while (enrichmentPaused) {
          progress.paused = true;
          await saveEnrichProgress(progress);
          sendEnrichProgress(progress);
          await sleep(1000);
          if (runtimeState.cancelRequested) break;
        }
        if (runtimeState.cancelRequested) {
          LOG("Enrichment canceled by user");
          runtimeState.enrichmentRunning = false;
          return { canceled: true, enriched: progress.enrichedCount };
        }
        progress.paused = false;

        // Build a chunk of up to `parallel` connections to fetch concurrently
        const chunk = [];
        for (let j = i; j < Math.min(i + chunkParallel, progress.connections.length); j++) {
          const conn = progress.connections[j];
          const publicId = extractPublicIdentifier(conn.linkedinUrl);
          if (!publicId) {
            DEBUG(`Skipping connection with no publicIdentifier: ${conn.name}`);
            continue;
          }
          chunk.push({ index: j, conn, publicId });
        }

        if (chunk.length === 0) {
          progress.currentIndex = i + parallel;
          continue;
        }

        const chunkNames = chunk.map(c => c.conn.name).filter(Boolean);
        DEBUG(`Enriching batch ${i + 1}–${i + chunk.length}/${progress.connections.length} (${chunk.length} parallel, ${pace} mode)`);
        sendEnrichProgress(progress, chunkNames[0] || "");

        // Fetch all profiles in this chunk concurrently
        const results = await Promise.allSettled(
          chunk.map(async ({ index, conn, publicId }, waveIndex) => {
            if (waveIndex > 0) await sleep(waveIndex * adaptive.spacingMs);
            const profileData = await fetchProfileDetails(publicId, csrfToken, {
              retries: 1,
              retryRateLimit: false,
            });
            const parsed = parseProfileView(profileData);
            return { index, conn, publicId, parsed };
          })
        );

        if (runtimeState.cancelRequested) {
          LOG("Enrichment canceled by user");
          runtimeState.enrichmentRunning = false;
          return { canceled: true, enriched: progress.enrichedCount };
        }

        let hitRateLimit = false;
        let longestServerDelay = null;
        const batchLengthBeforeChunk = enrichedBatch.length;
        const enrichedCountBeforeChunk = progress.enrichedCount;
        const pendingBatchStartBeforeChunk = pendingBatchStartIndex;

        for (const result of results) {
          if (result.status === "fulfilled") {
            const { index, conn, parsed } = result.value;
            const enriched = {
              ...conn,
              bio: parsed.bio || conn.bio || "",
              location: parsed.location || conn.location || "",
              photoUrl: parsed.photoUrl || conn.photoUrl || "",
              companyPhotoUrl: parsed.companyPhotoUrl || conn.companyPhotoUrl || "",
              experience: parsed.experience.length > 0 ? parsed.experience : (conn.experience || []),
              education: parsed.education.length > 0 ? parsed.education : (conn.education || []),
              skills: parsed.skills.length > 0 ? parsed.skills : (conn.skills || []),
              languages: parsed.languages.length > 0 ? parsed.languages : (conn.languages || []),
              licenses: parsed.licenses.length > 0 ? parsed.licenses : (conn.licenses || []),
              volunteering: parsed.volunteering.length > 0 ? parsed.volunteering : (conn.volunteering || []),
            };
            if (pendingBatchStartIndex === null) pendingBatchStartIndex = index;
            enrichedBatch.push(enriched);
            progress.enrichedCount++;
            consecutiveFailures = 0;
          } else {
            const err = result.reason;
            const publicId = chunk.find(c => !results.some(r => r.status === "fulfilled" && r.value?.publicId === c.publicId) || true)?.publicId || "unknown";
            ERR(`Failed to enrich: ${err.message}`);

            if (err.message.includes("429") || err.message.includes("Rate limited")) {
              hitRateLimit = true;
              if (Number.isFinite(err.retryAfterMs)) {
                longestServerDelay = Math.max(longestServerDelay || 0, err.retryAfterMs);
              }
            } else if (err.message.includes("410") || err.message.includes("404")) {
              DEBUG(`Profile returned 410/404, skipping`);
            } else {
              consecutiveFailures++;
            }
          }
        }

        // Handle rate limiting — back off, drop to safe pace, retry the chunk
        if (hitRateLimit) {
          // Retry the chunk as one unit. Remove successes already staged from
          // this attempt so counts and uploads cannot duplicate them.
          enrichedBatch.length = batchLengthBeforeChunk;
          progress.enrichedCount = enrichedCountBeforeChunk;
          pendingBatchStartIndex = pendingBatchStartBeforeChunk;
          applyProfileThrottle(adaptive, longestServerDelay);
          syncAdaptivePace();
          LOG(`Rate limited during enrichment; retrying at ${parallel} parallel / ${adaptive.spacingMs}ms spacing`);
          consecutiveFailures = 0;
          await waitForProfileCooldown(adaptive);
          // Retry this chunk. Loop's update will add the post-downgrade
          // `parallel`, so subtracting it here puts us back at chunkStart.
          i -= parallel;
          continue;
        }

        if (consecutiveFailures >= ENRICH_CIRCUIT_BREAKER) {
          ERR("Enrichment circuit breaker — stopping after consecutive failures");
          stoppedEarlyReason = "LinkedIn profile requests failed repeatedly. Progress was saved and will resume on the next sync.";
          break;
        }

        progress.currentIndex = Math.min(i + chunkParallel, progress.connections.length);
        const recovered = recordCleanProfiles(adaptive, chunk.length);
        if (recovered) {
          syncAdaptivePace();
          // The for-loop increments with the new parallel value. Rebase i so
          // recovery cannot skip profiles when concurrency increases.
          i = progress.currentIndex - parallel;
        }

        // Send batch every ENRICH_BATCH_SIZE profiles
        if (enrichedBatch.length >= ENRICH_BATCH_SIZE) {
          LOG(`Sending enrichment batch: ${enrichedBatch.length} profiles`);
          await uploadEnrichmentBatchWithRetry([...enrichedBatch]);
          progress.batchesSent++;
          enrichedBatch.length = 0;
          pendingBatchStartIndex = null;
        }

        // Save progress periodically — skip if a cancel just cleared storage,
        // otherwise we'd resurrect the entry the next sync would resume from.
        if (!runtimeState.cancelRequested && progress.currentIndex - lastSavedIndex >= ENRICH_PROGRESS_SAVE_INTERVAL) {
          await saveEnrichProgress(progress);
          lastSavedIndex = progress.currentIndex;
        }
        sendEnrichProgress(progress);

        // Delay between parallel batches
        const delay = delayMs[0] + Math.random() * (delayMs[1] - delayMs[0]);
        await sleep(delay);
      }

      // Send remaining batch
      if (enrichedBatch.length > 0) {
        LOG(`Sending final enrichment batch: ${enrichedBatch.length} profiles`);
        await uploadEnrichmentBatchWithRetry([...enrichedBatch]);
        progress.batchesSent++;
        enrichedBatch.length = 0;
        pendingBatchStartIndex = null;
      }

      await saveEnrichProgress(progress);

      if (stoppedEarlyReason || progress.currentIndex < progress.totalConnections) {
        runtimeState.enrichmentRunning = false;
        sendProgress(stoppedEarlyReason || "Enrichment paused before completion");
        return {
          error: stoppedEarlyReason || "Enrichment stopped before completion",
          enriched: progress.enrichedCount,
          remaining: progress.totalConnections - progress.currentIndex,
        };
      }

      LOG(`Enrichment complete: ${progress.enrichedCount}/${progress.totalConnections} enriched, ${progress.failedUrls.length} failed`);

      await setEnrichProgress({
        status: "complete",
        enrichedCount: progress.enrichedCount,
        failedCount: progress.failedUrls.length,
        totalConnections: progress.totalConnections,
      });

      await clearEnrichProgress();
      runtimeState.enrichmentRunning = false;
      return { enriched: progress.enrichedCount, failed: progress.failedUrls.length };
    } catch (err) {
      ERR("Enrichment error:", err.message);
      if (pendingBatchStartIndex !== null) {
        // The rich rows in memory were not durably acknowledged. Rewind to the
        // first pending profile so a resume refetches and retries them.
        progress.currentIndex = Math.min(progress.currentIndex, pendingBatchStartIndex);
      }
      await saveEnrichProgress(progress);
      runtimeState.enrichmentRunning = false;
      return { error: err.message, enriched: progress.enrichedCount };
    }
  }

  function sendEnrichProgress(progress, currentName) {
    void setEnrichProgress({
      status: "in_progress",
      enrichedCount: progress.enrichedCount,
      totalConnections: progress.totalConnections,
      currentIndex: progress.currentIndex,
      paused: progress.paused,
      failedCount: progress.failedUrls.length,
      currentName: currentName || "",
    }).catch(() => {});
  }

  // ─── Main Capture Flow ──────────────────────────────────────────────────────

  async function captureConnections(runId, options = {}) {
    LOG("Starting resumable LinkedIn connection import");
    if (!(await getToken())) {
      return { error: "Connect Airtable in the side panel first." };
    }

    const claim = await claimLinkedInCapture(runId);
    if (claim?.error) throw new Error(claim.error);
    if (!claim?.claimed) {
      LOG(`LinkedIn capture ${claim?.runId || "unknown"} is already running in another tab`);
      return { alreadyRunning: true, runId: claim?.runId || null };
    }

    const csrfToken = await extractCsrfToken();
    let interactionSnapshot;
    try {
      interactionSnapshot = await captureInteractionSnapshot(csrfToken);
      LOG(
        `Interaction metadata: ${interactionSnapshot.byMemberId.size} direct conversations ` +
        `indexed from ${interactionSnapshot.conversations} scanned`,
      );
    } catch (error) {
      // Messaging metadata is additive. A rotated query hash, rate limit, or
      // unavailable inbox must not make the user's base network sync fail.
      LOG("Interaction metadata unavailable; continuing network sync:", error?.message || error);
      interactionSnapshot = { byMemberId: new Map(), complete: false, conversations: 0 };
    }
    // The notifications feed isn't read: Airtable has no home for it.
    const notificationSweep = { records: [] };
    let progress = await loadProgress();
    let resumed = Boolean(progress?.importId);
    if (!progress) progress = newProgress(runId);
    if (!progress.clientImportKey) progress.clientImportKey = createRunId();
    progress.runId = runId;
    progress.status = "running";
    // An explicit mode wins (a scheduled run is soft, a user-initiated sync is
    // full — even when it adopts an interrupted run of the other kind); the
    // worker's crash-resume paths pass no mode and keep whatever the
    // checkpoint recorded.
    const wasSoftSync = progress.softSync === true;
    if (options.mode === "soft") progress.softSync = true;
    else if (options.mode === "full") progress.softSync = false;
    // Persist visibility with the run so a worker restart resumes it the way
    // it started, rather than inferring silence from its depth.
    if (options.silent !== undefined) progress.silent = options.silent === true;
    else if (options.mode !== undefined) progress.silent = progress.softSync === true;
    // Only an explicit request sets the cap: resume and retry keep whatever the
    // checkpoint says. An open import sized for a different cap can't finish.
    if (options.sampleLimit !== undefined) {
      const limit = sampleLimitOf({ sampleLimit: options.sampleLimit }) || null;
      if ((progress.sampleLimit || null) !== limit) {
        if (progress.importId) resetImportCheckpoint(progress, { freshWorkspace: true });
        progress.sampleLimit = limit;
      }
    }
    runtimeState.captureSampleLimit = sampleLimitOf(progress);
    if (runtimeState.captureSampleLimit) LOG(`Test sync: capped at ${runtimeState.captureSampleLimit} people`);
    let softSync = progress.softSync === true;
    runtimeState.captureMode = softSync ? "soft" : "full";
    let upgradedFromSoft = wasSoftSync && !softSync;
    if (upgradedFromSoft) upgradeSoftRunToFull(progress);

    async function promoteSoftRunToFullIfRequested() {
      if (!runtimeState.captureUpgradeRequested) return false;
      runtimeState.captureUpgradeRequested = false;
      // A full request can race checkpoint loading, when captureMode is still
      // unknown. Once the checkpoint proves this run is already full, consume
      // the request without leaving the terminal drain spinning forever.
      if (!softSync) return false;
      softSync = false;
      progress.softSync = false;
      runtimeState.captureMode = "full";
      upgradedFromSoft = true;
      upgradeSoftRunToFull(progress);
      await saveProgress(progress);
      return true;
    }

    await promoteSoftRunToFullIfRequested();
    if (softSync) LOG("Running in soft-sync mode: known people are skipped by enrichment");
    await saveProgress(progress);
    // Reassigned if a dead checkpoint is discarded below, which retires any
    // legacy chunk size along with it. Every reader is a closure that only runs
    // after that point.
    let rowsPerChunk = rowsPerChunkFor(progress);
    const profileAdaptive = sanitizeProfileAdaptive(progress.profileAdaptive);
    progress.profileAdaptive = profileAdaptive;

    const inFlight = new Map();

    async function settleOne(ignoreErrors = false) {
      if (inFlight.size === 0) return;
      const outcome = await Promise.race(inFlight.values());
      inFlight.delete(outcome.sequence);
      if (!outcome.ok) {
        if (ignoreErrors) return;
        throw outcome.error;
      }
      const chunk = outcome.response.chunk;
      if (!chunk.replayed) {
        progress.accepted += chunk.accepted || 0;
        progress.failed += chunk.failed || 0;
        progress.uploadedChunks++;
      }
      progress.nextSequence = Math.max(progress.nextSequence, outcome.sequence + 1);
      progress.nextOffset = progress.nextSequence * rowsPerChunk;
      progress.retry = null;
      await saveProgress(progress);
      if (!runtimeState.cancelRequested) {
        const saved = progress.accepted;
        sendProgress(
          stageMessage("saving", { current: saved, total: progress.totalConnections }),
          saved,
          progress.totalConnections,
          "uploading",
          {
            phase: "saving",
            discovered: progress.discovered,
            saved,
            enriched: enrichmentWalked(progress, rowsPerChunk),
          },
        );
      }
    }

    async function settleAll(ignoreErrors = false) {
      while (inFlight.size > 0) await settleOne(ignoreErrors);
    }

    async function enqueueChunk(sequence, rows) {
      while (inFlight.size >= MAX_UPLOAD_CONCURRENCY) await settleOne();
      const promise = sendImportRequest("PEOPLE_IMPORT_PUT_CHUNK", {
        importId: progress.importId,
        sequence,
        rows,
        sourceCursor: {
          mode: "linkedin_network_connections",
          syncMode: softSync ? "soft" : "full",
          runId,
          nextSequence: sequence + 1,
          nextOffset: (sequence + 1) * rowsPerChunk,
          rowsPerChunk,
          totalConnections: progress.totalConnections,
        },
      }, 3).then(
        (response) => ({ ok: true, sequence, response }),
        (error) => ({ ok: false, sequence, error }),
      );
      inFlight.set(sequence, promise);
    }

    async function statusForImport() {
      return sendImportRequest("PEOPLE_IMPORT_STATUS", { importId: progress.importId }, 4);
    }

    /**
     * Open the server-side import this attempt will upload into.
     *
     * The 409 branch is the safety net under the run-scoped key. A create that
     * reached the server but whose response did not reach us leaves the key
     * spent with no importId on the checkpoint to show for it; a checkpoint
     * written by a build that scoped its key to the checkpoint rather than to
     * the run then replays that key forever, and the server rejects it the
     * moment any material parameter has moved — expectedRows above all, since
     * LinkedIn's connection count drifts between attempts. That conflict is not
     * a failure, it only means this key is spent, so retire it and open a new
     * import rather than failing every sync from here on.
     *
     * Only the key is retired: the chunk plan just computed from LinkedIn is
     * still correct and must survive, which is why this is deliberately not
     * resetImportCheckpoint().
     */
    async function openImport() {
      const send = () => {
        const clientImportKey = peopleImportKeyForRun(progress.clientImportKey, runId);
        return sendImportRequest("PEOPLE_IMPORT_CREATE", {
          input: {
            source: "linkedin",
            ...(Number.isInteger(progress.expectedRows) ? { expectedRows: progress.expectedRows } : {}),
            // Omitted rather than sent as null when there is nothing to derive
            // a key from: the server takes it as optional, and an explicit null
            // fails its schema outright.
            ...(clientImportKey ? { clientImportKey } : {}),
            sourceCursor: {
              mode: "linkedin_network_connections",
              syncMode: softSync ? "soft" : "full",
              runId,
              nextSequence: 0,
              nextOffset: 0,
              rowsPerChunk,
              totalConnections: progress.totalConnections,
            },
          },
        }, 2);
      };
      try {
        return await send();
      } catch (error) {
        if (error?.status !== 409) throw error;
        LOG("Stored import key is spent on an earlier import; opening a new one");
        progress.clientImportKey = createRunId();
        await saveProgress(progress);
        // A cancel can land while the conflict is being resolved. Without this
        // the recovery opens an import server-side for a sync that is over.
        assertNotCanceled();
        return await send();
      }
    }

    function assertNotCanceled() {
      if (runtimeState.cancelRequested) throw new Error("Sync canceled");
    }

    async function acknowledgeComplete(importRecord) {
      assertNotCanceled();
      // A manual request can land while the final import request is in flight.
      // Drain until both the reveal and the resulting full-enrichment queue are
      // stable, then close the in-place upgrade window synchronously. A later
      // request is queued as a fresh full run by revealCapture().
      while (true) {
        await drainPendingEnrichment();
        await runtimeState.captureRevealPromise?.catch(() => {});
        if (!runtimeState.captureUpgradeRequested) break;
      }
      runtimeState.captureAcceptingUpgrade = false;
      const accepted = importRecord.accepted || 0;
      const failed = importRecord.failed || 0;
      const expected = progress.totalConnections || accepted + failed;
      // Distinguish two very different outcomes:
      //  • Rows are MISSING (accepted + failed < expected): chunks did not all
      //    arrive — a transient upload gap worth retrying as a fresh import.
      //  • Every connection is ACCOUNTED FOR but some rows failed validation
      //    (failed > 0, e.g. restricted "LinkedIn Member" profiles that expose
      //    no /in/ URL or member ID): that is a permanent, per-row data
      //    condition. Retrying re-fetches the same unresolvable rows forever, so
      //    it must NOT block the capture — the sync genuinely completed.
      if (accepted + failed < expected) {
        // Completed imports are immutable, so the next attempt starts fresh.
        resetImportCheckpoint(progress);
        throw new Error(
          `LinkedIn returned ${expected.toLocaleString()} connections, but only ${(accepted + failed).toLocaleString()} were received (${(expected - accepted - failed).toLocaleString()} missing). Retry the sync to capture every connection.`
        );
      }
      const skippedWarning = failed > 0
        ? `${accepted.toLocaleString()} of ${expected.toLocaleString()} connections captured. ${failed.toLocaleString()} could not be captured because LinkedIn exposes no resolvable profile for them (typically restricted members); this is expected and does not need a retry.`
        : null;
      if (skippedWarning) LOG(skippedWarning);
      const summary = {
        importId: progress.importId,
        total: accepted + failed,
        accepted,
        failed,
        warning: skippedWarning,
        totalChunks: importRecord.chunks || progress.totalChunks || 0,
        resumed,
        runId,
        sample: sampleLimitOf(progress) > 0,
        completedAt: importRecord.completedAt || new Date().toISOString(),
      };
      const terminalIsSilent = runtimeState.captureSilent || runtimeState.captureRestartRequested;
      const response = await reportImportCompleted(summary, { silent: terminalIsSilent });
      if (response?.error) throw new ImportOperationError(response);
      assertNotCanceled();
      if (response?.ignored) throw new Error(`Completion acknowledgment ignored: ${response.ignored}`);
      if (terminalIsSilent) {
        await recordSoftSyncRun({
          completed: true,
          runId,
          captured: summary.total,
          promotedToFull: runtimeState.captureRestartRequested,
        }).catch(() => {});
      }
      progress.status = "complete";
      progress.completedAt = summary.completedAt;
      await saveProgress(progress);
      assertNotCanceled();
      await clearProgress();
      assertNotCanceled();

      // The import is acknowledged and durable at this point, so everything
      // below is strictly additive: it recomputes warmth from the interaction
      // metadata just written and lands the notification sweep as signals. A
      // failure here costs one cycle of freshness and never the sync.
      try {
        const ingest = await uploadNetworkSignals({
          notifications: notificationSweep.records,
          refreshWarmth: true,
        });
        const unmapped = ingest?.notifications?.unmapped;
        if (unmapped && Object.keys(unmapped).length > 0) {
          // Reported rather than swallowed: the notification type allowlist was
          // built from a small live sample, and these are the tokens it did not
          // recognise. This log is how that list gets extended from real data.
          LOG("Unrecognised notification types:", JSON.stringify(unmapped));
        }
        LOG(
          `Signals: ${ingest?.notifications?.signals ?? 0} from notifications, `
          + `${ingest?.profileSignals?.signals ?? 0} from profile changes, `
          + `warmth recomputed for ${ingest?.warmth?.people ?? 0} people`,
        );
        if (
          !resumed
          && summary.total > 0
          && ingest?.warmth
          && interactionSnapshot.reciprocityLedger
          && interactionSnapshot.reciprocityLedgerUpdates
          && interactionSnapshot.reciprocityPersistedKeys instanceof Set
        ) {
          const persistedUpdates = Object.fromEntries(
            Object.entries(interactionSnapshot.reciprocityLedgerUpdates)
              .filter(([key]) => interactionSnapshot.reciprocityPersistedKeys.has(key)),
          );
          if (Object.keys(persistedUpdates).length > 0) {
            await writeReciprocityLedger({
              ...interactionSnapshot.reciprocityLedger,
              ...persistedUpdates,
            });
          }
        }
      } catch (error) {
        LOG("Signal ingest unavailable; network sync already complete:", error?.message || error);
      }

      return { captured: summary.total, importId: summary.importId, resumed };
    }

    function markEnrichmentPending(sequence) {
      if (!progress.pendingEnrichmentSequences.includes(sequence)) {
        progress.pendingEnrichmentSequences.push(sequence);
        progress.pendingEnrichmentSequences.sort((left, right) => left - right);
      }
    }

    /**
     * The rows the base pass already read, kept so the enrichment pass does not
     * page LinkedIn a second time for the same people.
     *
     * Enrichment works from connection rows, and the base pass has just held
     * every one of them; without this the run pages the whole connection list
     * twice, once to upload it and once to enrich it. A capture of 3,000 spends
     * thirty extra page requests on people it is already holding.
     *
     * Bounded, because enrichment is deliberately drained after the base pass,
     * so this holds a network at once. Past the cap the remembering simply
     * stops and those sequences re-fetch exactly as before: a slower correct
     * answer rather than a worker that runs out of memory. Nothing here is
     * durable either — a worker that restarts re-fetches, which is the path a
     * resume has always taken.
     */
    /**
     * Whether the base pass is still paging LinkedIn, and how far it is durable.
     *
     * The enrichment drain used to start only once the base pass had finished,
     * which kept a promise worth keeping — profile throttling can never stop
     * the rest of the user's network from being captured — by the blunt method
     * of never overlapping them at all. The two talk to different endpoints and
     * want different things, so they now run side by side, and the promise is
     * kept by the join instead: the base pass never awaits the drain until it
     * has finished paging, so nothing the profile pace does can stall a page.
     *
     * `baseSettledThrough` is what makes that safe on the EarthOS side. Enriched
     * rows upsert the same people the base chunk carries, and two writes for one
     * person racing each other is the identity-conflict shape behind the Sep 5
     * captures. Every sequence below this one has been acknowledged by the
     * server, so enriching it is a second write to a finished first one rather
     * than a race with a live one.
     */
    let baseCapturePaging = false;
    let baseSettledThrough = 0;

    const REMEMBERED_ROW_LIMIT = 25_000;
    const rememberedRows = new Map();
    let rememberedRowCount = 0;

    function rememberRowsFor(sequence, rows) {
      if (!Array.isArray(rows) || rememberedRows.has(sequence)) return;
      if (rememberedRowCount + rows.length > REMEMBERED_ROW_LIMIT) return;
      rememberedRows.set(sequence, rows);
      rememberedRowCount += rows.length;
    }

    function forgetRowsFor(sequence) {
      const rows = rememberedRows.get(sequence);
      if (!rows) return;
      rememberedRows.delete(sequence);
      rememberedRowCount -= rows.length;
    }

    /**
     * Soft sync: ask the backend which of this page's people already exist and
     * remember the keys of the new ones, so the enrichment pass (which
     * re-fetches the page) can skip everyone else. Must run BEFORE the page is
     * uploaded — after the upsert every row exists by definition. On any
     * failure the whole page is treated as new: enriching a known person is
     * merely wasted work, while skipping a new one loses data.
     *
     * Retries live in one place only. The durable upload operations retry at
     * both layers because dropping a chunk loses captured data, but this check
     * is advisory: giving up just enriches the page anyway. api-client already
     * spends 3 attempts here with backoff and Retry-After handling, so this
     * layer takes a single pass instead of multiplying into 9 requests per
     * chunk against a backend that is already failing.
     */
    async function filterSoftSyncNewRows(rows, sequence) {
      try {
        const response = await sendImportRequest("SOFT_SYNC_CHECK", {
          rows: rows.map((row) => ({
            externalId: row.externalId || null,
            memberId: row.memberId || null,
            linkedinUrl: row.linkedinUrl || null,
            name: row.name || null,
            headline: row.bio || null,
          })),
        }, 1);
        const known = Array.isArray(response?.known) ? response.known : null;
        if (!known || known.length !== rows.length) return rows;
        const fresh = rows.filter((_, index) => known[index] !== true);
        progress.softSyncNewKeys[String(sequence)] = fresh.map(softRowKey);
        LOG(`Soft sync: ${fresh.length} of ${rows.length} people in chunk ${sequence} are new`);
        return fresh;
      } catch (error) {
        LOG("Soft-sync check unavailable; enriching the full chunk:", error?.message || error);
        delete progress.softSyncNewKeys[String(sequence)];
        return rows;
      }
    }

    /**
     * The run has one `retry` slot and, while both passes are live, two phases
     * that could describe it. The base pass wins: it owns the run's forward
     * progress, and where enrichment got to is recoverable from
     * `enrichmentBatchCursors` and `pendingEnrichmentSequences`, which are the
     * durable facts. `retry` is a breadcrumb, and two writers would leave one
     * that describes neither.
     */
    function setEnrichmentRetry(value) {
      if (baseCapturePaging) return;
      progress.retry = value;
    }

    /** Likewise the phase message: while base is paging, its own messages run. */
    function sendEnrichmentProgress(...args) {
      if (baseCapturePaging) return;
      sendProgress(...args);
    }

    async function enrichAndUploadSequence(sequence, sourceRows = null) {
      assertNotCanceled();
      /**
       * Whether a soft run was promoted to a full one underneath this pass.
       *
       * Promotion re-queues every uploaded page, clears the batch cursors and
       * bumps the generation, because a soft pass enriched only the people the
       * backend did not already know and the cursors index that filtered list.
       * The base pass can now promote while this one is mid-sequence, and a
       * cursor written afterwards would tell the new generation to skip exactly
       * the people soft mode filtered out. So a superseded pass stops recording
       * where it got to and leaves the sequence queued: its uploads already
       * happened under the old generation's keys and are no less durable for
       * it, and the page is enriched again in full under the new ones.
       */
      const generation = Number(progress.enrichmentGeneration) || 0;
      const superseded = () => (Number(progress.enrichmentGeneration) || 0) !== generation;
      let rows = sourceRows;
      if (!rows) {
        const block = await fetchConnectionBlock(
          sequence,
          progress.totalConnections,
          csrfToken,
          progress,
        );
        rows = block.rows;
      }
      rows = rowsWithInteractionSnapshot(rows, interactionSnapshot);
      if (softSync) {
        // Only the people the pre-upload check flagged as new get the
        // expensive per-profile pass. A missing entry means the check failed
        // (or predates this run's checkpoint format) — enrich everyone.
        const newKeys = progress.softSyncNewKeys[String(sequence)];
        if (Array.isArray(newKeys)) {
          const allowed = new Set(newKeys);
          rows = rows.filter((row) => allowed.has(softRowKey(row)));
        }
      }
      if (!rows || rows.length === 0) {
        if (!superseded()) {
          progress.pendingEnrichmentSequences = progress.pendingEnrichmentSequences
            .filter((pendingSequence) => pendingSequence !== sequence);
          delete progress.enrichmentBatchCursors[String(sequence)];
          delete progress.softSyncNewKeys[String(sequence)];
        }
        await saveProgress(progress);
        return;
      }

      const sequenceKey = String(sequence);
      const totalBatches = Math.ceil(rows.length / ENRICH_UPLOAD_BATCH_SIZE);
      const savedCursor = Math.min(
        totalBatches,
        Math.max(0, Number(progress.enrichmentBatchCursors[sequenceKey]) || 0),
      );

      // The upload of the batch just enriched, left in the air while the next
      // batch is fetched.
      //
      // Uploading 25 rows is four sequential round trips to EarthOS — create,
      // chunk, complete, status — and not one of them says anything to
      // LinkedIn, so the run used to spend all of it with no profile request
      // outstanding. At 150ms of server latency that was a tenth of the whole
      // capture; on Sep 5, when chunk upload was answering 500s, it was the
      // multiplier that made captures crawl.
      //
      // Exactly one upload is in the air at a time. enrichmentBatchCursors
      // holds a single number per sequence meaning "every batch below this is
      // durable", so it can only advance in order and a second concurrent
      // upload would have nowhere to record itself. Depth one is also all the
      // overlap worth having: fetching 25 profiles takes far longer than the
      // upload it now hides behind.
      let inFlightUpload = null;

      /**
       * Send batch `batchIndex` and return without waiting for it.
       *
       * The checkpoint moves inside the task, on the server's answer, rather
       * than at the join below — so the window in which a dead worker replays
       * an already-uploaded batch stays exactly as narrow as it was, instead of
       * widening to cover the next batch's fetching.
       */
      function startUpload(batchIndex, enrichment) {
        const task = (async () => {
          await sendImportRequest("ENRICHMENT_BATCH", {
            data: enrichment.rows,
            // Run-scoped for the same reason the create key is (see openImport):
            // the rows behind one (sequence, batchIndex) are re-collected from
            // LinkedIn on every attempt, so a key shared across attempts is
            // eventually presented with a different expectedRows and rejected.
            // Inside one attempt the key is unchanged, which is what the
            // transport retry above needs it for.
            clientImportKey: peopleImportKeyForRun(
              enrichmentBatchKey(progress, sequence, batchIndex),
              runId,
            ),
          }, 4);

          if (!superseded()) progress.enrichmentBatchCursors[sequenceKey] = batchIndex + 1;
          // Keyed by sequence and batch, so a re-enriched page overwrites its
          // own outcome rather than counting those people twice.
          progress.enrichmentBatchOutcomes[`${sequence}:${batchIndex}`] = {
            enriched: enrichment.enrichedCount,
            unavailable: enrichment.unavailableCount,
          };
          progress.profileAdaptive = profileAdaptive;
          // Only this task's own phase is ours to clear: the enrichment running
          // alongside owns whatever it has written since.
          if (!baseCapturePaging && progress.retry?.phase === "enrichment_upload") {
            progress.retry = null;
          }
          await saveProgress(progress);
          const walked = enrichmentWalked(progress, rowsPerChunk);
          sendEnrichmentProgress(
            stageMessage("enriching", {
              current: walked,
              total: progress.totalConnections,
              soft: softSync,
              updated: totalEnriched(progress),
              // The last person in the batch just uploaded — the most recent
              // one this pass is known to have finished.
              who: lastRowName(enrichment.rows),
            }),
            walked,
            progress.totalConnections,
            "uploading",
            {
              phase: "enriching",
              discovered: progress.discovered,
              saved: progress.accepted,
              enriched: walked,
            },
          );
        })();
        // Nothing awaits this until the next batch is enriched, and an upload
        // that fails before then would be an unhandled rejection meanwhile.
        task.catch(() => {});
        inFlightUpload = task;
      }

      /** Join the outstanding upload, letting a failed one end the sequence. */
      async function settleUpload() {
        const task = inFlightUpload;
        if (!task) return;
        inFlightUpload = null;
        await task;
      }

      try {
        for (let batchIndex = savedCursor; batchIndex < totalBatches; batchIndex++) {
          assertNotCanceled();
          const batchStart = batchIndex * ENRICH_UPLOAD_BATCH_SIZE;
          const batchEnd = Math.min(batchStart + ENRICH_UPLOAD_BATCH_SIZE, rows.length);
          const batchRows = rows.slice(batchStart, batchEnd);

          setEnrichmentRetry({ phase: "enrich", attempt: 0, lastError: null, nextRetryAt: null });
          await saveProgress(progress);
          const enrichment = await enrichConnectionBlock(
            batchRows,
            csrfToken,
            sequence * rowsPerChunk + batchStart,
            progress.totalConnections,
            profileAdaptive,
            async (adaptive) => {
              progress.profileAdaptive = adaptive;
              setEnrichmentRetry({
                phase: "enrich_cooldown",
                attempt: adaptive.throttleStreak,
                lastError: "LinkedIn rate limit",
                nextRetryAt: new Date(adaptive.cooldownUntil).toISOString(),
              });
              await saveProgress(progress);
              Object.assign(adaptive, progress.profileAdaptive);
              progress.profileAdaptive = adaptive;
            },
          );

          // The previous batch's upload had this batch's whole fetch to land in.
          // Joining it here keeps a failure attributable to the batch that
          // produced it, and keeps uploads in the order the checkpoint needs.
          await settleUpload();
          assertNotCanceled();

          setEnrichmentRetry({
            phase: "enrichment_upload",
            attempt: 0,
            lastError: null,
            nextRetryAt: null,
          });
          await saveProgress(progress);
          startUpload(batchIndex, enrichment);
        }
        await settleUpload();
      } finally {
        // A throw on the fetching side leaves an upload in the air. Let it
        // finish writing its checkpoint before the caller retries the sequence,
        // so the retry sees the batch it already landed.
        if (inFlightUpload) await Promise.allSettled([inFlightUpload]);
      }

      if (!superseded()) {
        progress.pendingEnrichmentSequences = progress.pendingEnrichmentSequences
          .filter((pendingSequence) => pendingSequence !== sequence);
        delete progress.enrichmentBatchCursors[sequenceKey];
        delete progress.softSyncNewKeys[sequenceKey];
      }
      progress.profileAdaptive = profileAdaptive;
      setEnrichmentRetry(null);
      await saveProgress(progress);
    }

    /**
     * The first queued sequence the drain is allowed to touch.
     *
     * Nothing at or above `baseSettledThrough` is safe to enrich while the base
     * pass is still running: its chunk is either in the air or not yet sent,
     * and enriched rows for the same people would race it. Once the base pass
     * is done the whole queue is fair game.
     */
    function nextDrainableSequence() {
      for (const sequence of progress.pendingEnrichmentSequences) {
        if (!baseCapturePaging || sequence < baseSettledThrough) return sequence;
      }
      return null;
    }

    async function drainPendingEnrichment() {
      // Read the queue dynamically: promoting a live soft run re-adds every
      // uploaded sequence, including one that just finished its soft subset.
      while (true) {
        await promoteSoftRunToFullIfRequested();
        const pendingSequence = nextDrainableSequence();
        if (!Number.isInteger(pendingSequence)) {
          // Nothing ready. While the base pass is still paging there is more
          // coming, so wait for it rather than declaring the queue drained.
          if (!baseCapturePaging) return;
          await sleep(DRAIN_IDLE_POLL_MS);
          assertNotCanceled();
          continue;
        }
        assertNotCanceled();
        const walkedSoFar = enrichmentWalked(progress, rowsPerChunk);
        sendEnrichmentProgress(
          stageMessage("enriching", {
            current: walkedSoFar,
            total: progress.totalConnections,
            soft: softSync,
            updated: totalEnriched(progress),
          }),
          walkedSoFar,
          progress.totalConnections,
          "uploading",
          {
            phase: "enriching",
            discovered: progress.discovered,
            saved: progress.accepted,
            enriched: walkedSoFar,
          },
        );
        await enrichAndUploadSequence(
          pendingSequence,
          rememberedRows.get(pendingSequence) || null,
        );
        // Only once the sequence is off the queue: a throw, or a promotion that
        // superseded the pass, leaves it there to be done again, and doing it
        // again should not have to page LinkedIn for rows already in hand.
        if (!progress.pendingEnrichmentSequences.includes(pendingSequence)) {
          forgetRowsFor(pendingSequence);
        }
      }
    }

    let prefetchedFirstBlock = null;
    let enrichmentDrain = null;
    try {
      let resumedStatus = null;
      // Two ways a stored import can be unusable, both answered by starting
      // over rather than by failing, and both checked before anything resumes
      // into it.

      // It has proved it cannot finish (see the backstop above).
      if (retireImportIfRepeatedlyFailing(progress)) {
        rowsPerChunk = rowsPerChunkFor(progress);
        resumed = false;
        await saveProgress(progress);
      }
      // It no longer exists. Deleting the account and signing back in with the
      // same login rebuilds the same workspace id with none of the old rows, so
      // every resume would 404 against it forever.
      if (progress.importId) {
        try {
          resumedStatus = await statusForImport();
        } catch (error) {
          if (error?.status !== 404) throw error;
          LOG("Stored import no longer exists on the server; capturing from scratch");
          resetImportCheckpoint(progress, { freshWorkspace: true });
          rowsPerChunk = rowsPerChunkFor(progress);
          resumed = false;
          await saveProgress(progress);
        }
      }
      if (!progress.importId) {
        sendProgress(stageMessage("starting"));
        const firstBlock = await fetchConnectionBlock(0, 0, csrfToken, progress);
        const firstPage = {
          total: firstBlock.reportedTotal,
          rawCount: firstBlock.rawCount,
          connections: firstBlock.rows,
        };
        if (firstPage.total !== null) {
          if (firstPage.rawCount > firstPage.total) {
            throw new Error(
              `LinkedIn returned ${firstPage.rawCount} raw connections but reported a total of ${firstPage.total}`,
            );
          }
          if (firstPage.total > 0 && firstPage.rawCount === 0) {
            throw new Error(`LinkedIn reported ${firstPage.total} connections but returned an empty first page`);
          }
          progress.totalConnections = firstPage.total;
          progress.expectedRows = firstPage.total;
          progress.totalChunks = Math.ceil(firstPage.total / rowsPerChunk);
        } else if (firstPage.rawCount < CONNECTIONS_PER_PAGE) {
          progress.totalConnections = firstPage.rawCount;
          progress.expectedRows = firstPage.rawCount;
          progress.totalChunks = Math.ceil(firstPage.rawCount / rowsPerChunk);
        } else {
          progress.totalConnections = 0;
          progress.expectedRows = null;
          progress.totalChunks = null;
        }
        if (rowsPerChunk === CONNECTIONS_PER_PAGE) {
          const reachesKnownEnd = Number.isInteger(progress.expectedRows)
            && firstPage.rawCount >= progress.expectedRows;
          prefetchedFirstBlock = {
            rows: firstPage.connections,
            endOffset: firstPage.rawCount < CONNECTIONS_PER_PAGE || reachesKnownEnd
              ? Math.min(firstPage.rawCount, progress.expectedRows ?? firstPage.rawCount)
              : null,
          };
        }
        const created = await openImport();
        progress.importId = created.import.id;
        await saveProgress(progress);
      }

      let status = resumedStatus ?? await statusForImport();
      assertNotCanceled();
      if (upgradedFromSoft) {
        // The server can be one acknowledged chunk ahead of the checkpoint if
        // the worker died after the PUT response but before chrome.storage was
        // updated. Re-queue every sequence the server reports, not only the
        // checkpoint's nextSequence, or that last soft-scoped page stays soft.
        const pending = new Set(progress.pendingEnrichmentSequences);
        const contiguous = Math.max(0, Number(status.nextExpectedSequence) || 0);
        for (let sequence = 0; sequence < contiguous; sequence++) pending.add(sequence);
        for (const sequence of Array.isArray(status.receivedSequences) ? status.receivedSequences : []) {
          if (Number.isInteger(sequence) && sequence >= 0) pending.add(sequence);
        }
        progress.pendingEnrichmentSequences = [...pending].sort((left, right) => left - right);
        progress.nextSequence = Math.max(Number(progress.nextSequence) || 0, contiguous);
        progress.nextOffset = progress.nextSequence * rowsPerChunk;
        await saveProgress(progress);
      }
      progress.accepted = status.import.accepted || 0;
      progress.failed = status.import.failed || 0;
      progress.uploadedChunks = status.import.chunks || 0;

      if (progress.totalChunks === 0) {
        assertNotCanceled();
        const completed = await sendImportRequest("PEOPLE_IMPORT_COMPLETE", {
          importId: progress.importId,
          sourceCursor: {
            mode: "linkedin_network_connections",
            syncMode: softSync ? "soft" : "full",
            runId,
            totalConnections: 0,
            totalChunks: 0,
            rowsPerChunk,
          },
        }, 4);
        assertNotCanceled();
        return acknowledgeComplete(completed.import);
      }

      async function uploadMissing(currentStatus) {
        let received = new Set(currentStatus.receivedSequences || []);
        let sequence = currentStatus.nextExpectedSequence || 0;
        let uploadsSinceStatus = 0;
        const rebaseFromStatus = (nextStatus) => {
          currentStatus = nextStatus;
          received = new Set(nextStatus.receivedSequences || []);
          sequence = Math.max(sequence, nextStatus.nextExpectedSequence || 0);
          uploadsSinceStatus = 0;
        };
        while (progress.totalChunks === null || sequence < progress.totalChunks) {
          assertNotCanceled();
          // Every sequence below this one is acknowledged server-side, either
          // by a previous run or by the settleAll at the foot of this loop.
          baseSettledThrough = Math.max(baseSettledThrough, sequence);
          await promoteSoftRunToFullIfRequested();
          if (received.has(sequence)) {
            sequence++;
            continue;
          }
          if (Number.isInteger(currentStatus.sequenceWindow?.end)
              && sequence > currentStatus.sequenceWindow.end) {
            await settleAll();
            assertNotCanceled();
            rebaseFromStatus(await statusForImport());
            assertNotCanceled();
            continue;
          }

          progress.retry = { phase: "fetch", attempt: 0, lastError: null, nextRetryAt: null };
          await saveProgress(progress);
          sendProgress(
            stageMessage("capturing", {
              current: progress.discovered,
              total: progress.totalConnections,
            }),
            progress.accepted,
            progress.totalConnections,
            "in_progress",
            {
              phase: "capturing",
              discovered: progress.discovered,
              saved: progress.accepted,
              enriched: enrichmentWalked(progress, rowsPerChunk),
            },
          );
          const block = sequence === 0 && prefetchedFirstBlock
            ? prefetchedFirstBlock
            : await fetchConnectionBlock(sequence, progress.totalConnections, csrfToken, progress);
          if (sequence === 0) prefetchedFirstBlock = null;
          if (block.endOffset !== null) {
            if (Number.isInteger(progress.expectedRows) && block.endOffset !== progress.expectedRows) {
              const drift = `LinkedIn ended at ${block.endOffset} rows, but the import expects ${progress.expectedRows}`;
              // expectedRows is fixed when the import is opened and immutable
              // server-side, while the connection count behind it keeps moving:
              // accept an invitation mid-sync and a resumed import can never
              // satisfy its own completion check again. Nothing about a later
              // attempt changes that, so condemn it here instead of failing the
              // same way forever. A first-attempt mismatch is a different
              // animal — expectedRows was read minutes ago by this same run, so
              // LinkedIn disagrees with itself and a new import inherits the
              // same disagreement. Let the backstop judge that one.
              if (resumed) condemnImport(progress, drift);
              await saveProgress(progress);
              throw new Error(drift);
            }
            if (!Number.isInteger(progress.expectedRows)) {
              progress.totalConnections = block.endOffset;
              progress.totalChunks = Math.ceil(block.endOffset / rowsPerChunk);
            }
          }
          if (block.rows.length === 0) break;
          progress.discovered = Math.max(
            progress.discovered,
            sequence * rowsPerChunk + block.rows.length,
          );

          // Make the base page visible immediately and queue the same 100 people
          // for progressive enrichment after the full base network is durable.
          // An interrupted sequence resumes under stable idempotency keys.
          // Soft sync narrows that queue first: only people the backend does
          // not already know get enriched, and a page with no one new skips
          // the enrichment queue entirely. The base upload below still carries
          // every row so conversation metadata is refreshed for everyone.
          let enrichableCount = block.rows.length;
          if (softSync) {
            const freshRows = await filterSoftSyncNewRows(block.rows, sequence);
            // A manual sync may have landed while the existence check was in
            // flight. Promote before deciding the queue so this page is not
            // accidentally left with soft scope.
            await promoteSoftRunToFullIfRequested();
            enrichableCount = softSync ? freshRows.length : block.rows.length;
          }
          if (enrichableCount > 0) {
            markEnrichmentPending(sequence);
            rememberRowsFor(sequence, block.rows);
          }
          progress.retry = { phase: "base_upload", attempt: 0, lastError: null, nextRetryAt: null };
          await saveProgress(progress);
          await enqueueChunk(sequence, rowsWithInteractionSnapshot(block.rows, interactionSnapshot));
          await settleAll();
          assertNotCanceled();
          await promoteSoftRunToFullIfRequested();
          sequence++;
          uploadsSinceStatus++;
          if (uploadsSinceStatus >= 50) {
            await settleAll();
            assertNotCanceled();
            rebaseFromStatus(await statusForImport());
            assertNotCanceled();
          }
          await sleep(PAGE_DELAY_MS[0] + Math.random() * (PAGE_DELAY_MS[1] - PAGE_DELAY_MS[0]));
        }
        await settleAll();
        assertNotCanceled();
      }

      baseCapturePaging = true;
      enrichmentDrain = drainPendingEnrichment();
      // Nothing awaits this until the base pass is done, and a failure before
      // then would be an unhandled rejection meanwhile.
      enrichmentDrain.catch(() => {});
      try {
        await uploadMissing(status);
        assertNotCanceled();
        await promoteSoftRunToFullIfRequested();
        status = await statusForImport();
        assertNotCanceled();
        if (status.nextExpectedSequence !== progress.totalChunks) {
          await uploadMissing(status);
          assertNotCanceled();
          status = await statusForImport();
          assertNotCanceled();
        }
        if (status.nextExpectedSequence !== progress.totalChunks) {
          throw new Error(`Import has a gap at chunk ${status.nextExpectedSequence}`);
        }
      } finally {
        // Whether the base pass finished or threw, the drain must stop waiting
        // for sequences that are never coming.
        baseCapturePaging = false;
      }

      // The bar was the base pass's until now; the profiles still to enrich
      // take it over, so a LinkedIn cooldown here reads as enriching, not "0 left".
      if (enrichmentDrain) {
        const walked = enrichmentWalked(progress, rowsPerChunk);
        if (walked < progress.totalConnections) {
          sendEnrichmentProgress(
            stageMessage("enriching", { current: walked, total: progress.totalConnections, soft: softSync, updated: totalEnriched(progress) }),
            walked,
            progress.totalConnections,
            "uploading",
            { phase: "enriching", discovered: progress.discovered, saved: progress.accepted, enriched: walked },
          );
        }
      }

      // Base capture is complete and visible in EarthOS. Joining the drain only
      // here is what keeps the old promise: until this line the two ran side by
      // side and nothing about the profile pace could hold a page back.
      await enrichmentDrain;
      enrichmentDrain = null;

      if (status.import.status === "complete") return acknowledgeComplete(status.import);

      let completed;
      try {
        assertNotCanceled();
        completed = await sendImportRequest("PEOPLE_IMPORT_COMPLETE", {
          importId: progress.importId,
          sourceCursor: {
            mode: "linkedin_network_connections",
            syncMode: softSync ? "soft" : "full",
            runId,
            totalConnections: progress.totalConnections,
            totalChunks: progress.totalChunks,
            nextSequence: progress.totalChunks,
            rowsPerChunk,
          },
        }, 4);
        assertNotCanceled();
      } catch (error) {
        if (error.status !== 409) throw error;
        const afterConflict = await statusForImport();
        assertNotCanceled();
        if (afterConflict.import.status === "complete") return acknowledgeComplete(afterConflict.import);
        if (afterConflict.nextExpectedSequence < progress.totalChunks) {
          await uploadMissing(afterConflict);
          assertNotCanceled();
          completed = await sendImportRequest("PEOPLE_IMPORT_COMPLETE", {
            importId: progress.importId,
            sourceCursor: {
              mode: "linkedin_network_connections",
              syncMode: softSync ? "soft" : "full",
              runId,
              totalConnections: progress.totalConnections,
              totalChunks: progress.totalChunks,
              rowsPerChunk,
            },
          }, 4);
          assertNotCanceled();
        } else {
          throw error;
        }
      }
      return acknowledgeComplete(completed.import);
    } catch (error) {
      baseCapturePaging = false;
      // The drain may still be mid-sequence. Let it finish writing its own
      // checkpoint before this failure overwrites the run's.
      if (enrichmentDrain) await Promise.allSettled([enrichmentDrain]);
      await settleAll(true);
      progress.status = runtimeState.cancelRequested ? "canceled" : "error";
      if (!runtimeState.cancelRequested) recordImportFailure(progress, error);
      progress.retry = {
        phase: runtimeState.cancelRequested ? "canceled" : (progress.retry?.phase || "unknown"),
        attempt: (progress.retry?.attempt || 0) + 1,
        lastError: error?.message || String(error),
        nextRetryAt: null,
      };
      await saveProgress(progress);
      if (runtimeState.cancelRequested) return { canceled: true, captured: progress.accepted, rejected: progress.failed };
      if (isAuthError(error)) return { error: error.message, captured: progress.accepted, rejected: progress.failed };
      throw error;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** How many people the profile pass has actually written this run. */
  function totalEnriched(progress) {
    return Object.values(progress.enrichmentBatchOutcomes || {})
      .reduce((sum, outcome) => sum + (Number(outcome?.enriched) || 0), 0);
  }

  /** The name of the last person in a batch, for "who is it on right now". */
  function lastRowName(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return "";
    const row = rows[rows.length - 1];
    return String(row?.name || "").trim();
  }

  // Stable identity for one captured row within a run, used by soft sync to
  // carry "these people are new" across the base-upload → enrichment gap
  // (the enrichment pass re-fetches the page, so object identity won't do).
  /**
   * Re-point a soft run's checkpoint at a full one, in place.
   *
   * A soft run leaves two things behind that a full run cannot read as-is.
   * Pages where everyone was already known never entered the enrichment queue,
   * and pages that were partially new were queued with only the new people in
   * them — but the base chunks for both are already durable server-side, so the
   * upload loop skips those sequences and would never revisit them. And the
   * per-sequence batch cursors index the soft-filtered row arrays, not the full
   * pages; replaying one against an unfiltered page silently skips whole
   * batches of people. So: re-queue every page this run has uploaded, drop the
   * cursors, drop the skip lists, and bump the generation so the re-uploads get
   * idempotency keys the backend has not already marked complete.
   *
   * The reverse switch (a scheduled run adopting an interrupted full one) needs
   * none of this: it inherits no skip lists, so it enriches everyone, and its
   * cursors already index full pages.
   */
  function upgradeSoftRunToFull(progress) {
    const uploaded = Math.max(0, Number(progress.nextSequence) || 0);
    const pending = new Set(
      Array.isArray(progress.pendingEnrichmentSequences) ? progress.pendingEnrichmentSequences : [],
    );
    for (let sequence = 0; sequence < uploaded; sequence++) pending.add(sequence);
    progress.pendingEnrichmentSequences = [...pending].sort((left, right) => left - right);
    progress.enrichmentBatchCursors = {};
    progress.softSyncNewKeys = {};
    progress.enrichmentGeneration = Math.max(0, Number(progress.enrichmentGeneration) || 0) + 1;
    LOG(
      `Upgrading soft sync to a full sync: re-queued ${progress.pendingEnrichmentSequences.length} `
      + `page(s) for enrichment (generation ${progress.enrichmentGeneration})`,
    );
  }

  /**
   * Idempotency key for one enrichment batch. Generation 0 keeps the original
   * key shape, so a run interrupted before this existed resumes under exactly
   * the keys its earlier batches already used.
   */
  function enrichmentBatchKey(progress, sequence, batchIndex) {
    const generation = Math.max(0, Number(progress.enrichmentGeneration) || 0);
    const key = `linkedin-progressive-${progress.clientImportKey}-${sequence}-${batchIndex}`;
    return generation > 0 ? `${key}-g${generation}` : key;
  }

  function softRowKey(row) {
    const key = row?.linkedinUrl
      || row?.externalId
      || (row?.memberId ? `member_${row.memberId}` : "")
      || `${row?.name || ""}|${row?.bio || ""}`;
    return String(key).trim().toLowerCase();
  }

  function sendProgress(message, current = 0, total = 0, status = "in_progress", metrics = {}) {
    if (runtimeState.captureSilent) return;

    // Where this run has got to, kept for the retry and cooldown messages: they
    // are raised deep inside the fetch helpers, which hold no run state, and
    // must still be able to publish the run's percentage. Recorded as the
    // *displayed* numerator — the phase's own count, not the upload cursor —
    // so a pause quotes the same percentage as the bar behind it.
    const shown = metrics.phase === "capturing" ? metrics.discovered
      : metrics.phase === "enriching" ? metrics.enriched
        : metrics.phase === "saving" ? metrics.saved
          : current;
    if (Number(total) > 0 || Number(shown) > 0) {
      runtimeState.syncCounts = {
        phase: metrics.phase || runtimeState.syncCounts.phase,
        current: Math.max(0, Number(shown) || 0),
        total: Math.max(0, Number(total) || 0),
      };
    }
    if (!runtimeState.captureRunning && runtimeState.enrichmentRunning) {
      void mergeEnrichProgress({
        status: "in_progress",
        message: message || "Adding profile details",
      }).catch(() => {});
      return;
    }
    // A pause message (rate limit, offline, cooldown) carries no phase of its
    // own: it keeps the phase and counts of the bar behind it.
    if (metrics.phase) {
      runtimeState.lastMetrics = { metrics, current, total };
    } else if (status === "in_progress" && runtimeState.lastMetrics) {
      ({ metrics, current, total } = runtimeState.lastMetrics);
    }
    void reportCaptureProgress({
      site: "linkedin",
      status,
      message,
      current: current || 0,
      total: total || 0,
      phase: metrics.phase || (status === "uploading" ? "saving" : "capturing"),
      discovered: Math.max(0, Number(metrics.discovered) || 0),
      saved: Math.max(0, Number(metrics.saved) || 0),
      enriched: Math.max(0, Number(metrics.enriched) || 0),
      runId: runtimeState.captureRunId,
    }).catch(() => {});
  }

  function sleep(ms) {
    // Cancel-aware: poll the cancel flag every 250ms so long backoffs unblock fast.
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (runtimeState.cancelRequested || Date.now() - start >= ms) return resolve();
        setTimeout(tick, Math.min(250, ms - (Date.now() - start)));
      };
      tick();
    });
  }

  return {
    startCapture,
    startEnrichmentRun,
    pauseEnrichment,
    resumeEnrichment,
    cancelAll,
    isCaptureRunning,
    waitForStop,
    isStopping: () => runtimeState.cancelRequested,
    isEnrichmentRunning,
    currentRunId,
    revealCapture,
    isSoftCheckpoint,
    isSilentCheckpoint,
    isSampleRun: () => runtimeState.captureRunning && runtimeState.captureSampleLimit > 0,
    onSettled,
  };
})();

export const startCapture = (runId, options) => engine.startCapture(runId, options);
export const startEnrichmentRun = (connections) => engine.startEnrichmentRun(connections);
export const pauseEnrichment = () => engine.pauseEnrichment();
export const resumeEnrichment = () => engine.resumeEnrichment();
export const cancelLinkedInWork = () => engine.cancelAll();
export const isCaptureRunning = () => engine.isCaptureRunning();
export const waitForCaptureStop = () => engine.waitForStop();
export const isCaptureStopping = () => engine.isCaptureRunning() && engine.isStopping();
export const isEnrichmentRunning = () => engine.isEnrichmentRunning();
export const currentCaptureRunId = () => engine.currentRunId();
export const revealScheduledCapture = (requestedMode) => engine.revealCapture(requestedMode);
export const isSoftSyncCheckpoint = () => engine.isSoftCheckpoint();
export const isSilentCaptureCheckpoint = () => engine.isSilentCheckpoint();
export const isSampleCaptureRunning = () => engine.isSampleRun();
export const onCaptureSettled = (hook) => engine.onSettled(hook);
