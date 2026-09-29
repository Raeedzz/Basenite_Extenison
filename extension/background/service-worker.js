/**
 * Background service worker: owns the LinkedIn engines and routes the side
 * panel's commands. Everything captured is written into Airtable through
 * lib/api-client.js (see lib/airtable-sink.js).
 *
 * No LinkedIn tab is opened. The capture and graph engines
 * (linkedin-capture.js, linkedin-graph.js) run inside this worker and reach
 * Voyager directly with cookies from the jar — see lib/linkedin-session.js.
 *
 * Long runs survive worker termination: the engine checkpoints every block to
 * chrome.storage, a keep-alive alarm holds the worker up while a run is live,
 * and a resume alarm restarts an interrupted run from its last durable
 * sequence.
 */

import {
  ApiError,
  captureProfiles,
  getToken,
  resetImportLedger,
} from "../lib/api-client.js";
import {
  AirtableError,
  createField,
  listBases,
  listRecords,
  listTables,
  whoami,
} from "../lib/airtable-client.js";
import {
  canMap, isWritable, newFieldSpec, offerNewMappings, seenMappings, SOURCE_FIELD_BY_KEY, suggestMapping, suggestStampValue,
} from "../lib/airtable-fields.js";
import {
  linkedReady,
  offerNewPeopleLinks,
  PEOPLE_LINKS,
  peopleTableMismatch,
  pruneLinked,
  suggestLinked,
  suggestPeopleTable,
} from "../lib/airtable-linked.js";
import { interactionEntry, interactionTables, logInteraction } from "../lib/airtable-interactions.js";
import {
  clearConfig,
  configProblem,
  findPersonRecord,
  forgetTableState,
  indexedPeopleCount,
  LAST_WRITE_KEY,
  readConfig,
  refreshSchema,
  resetTableState,
  savedSetupFor,
  summarizeTables,
  writeConfig,
} from "../lib/airtable-sink.js";
import {
  assertLinkedInSession,
  LINKEDIN_ORIGIN,
  LinkedInSessionError,
  readLinkedInSessionState,
} from "../lib/linkedin-session.js";
// Classic script: assigns globalThis.EarthOSLinkedInMessagingProtocol, which
// the capture engine reads for privacy-minimizing messenger metadata helpers.
// It stays a classic script because the unit tests load it into a vm context.
import "../lib/linkedin-messaging-protocol.js";
import {
  getCaptureStatus,
  LINKEDIN_CAPTURE_LOCK_MAX_AGE_MS,
  readCaptureProgress,
  readLinkedInCaptureLock,
  releaseLinkedInCapture,
  setCompanyProgress,
  setEnrichProgress,
  setMutualProgress,
  touchLinkedInCapture,
  updateProgress,
} from "./capture-state.js";
import {
  cancelLinkedInWork,
  currentCaptureRunId,
  isCaptureRunning,
  isEnrichmentRunning,
  isSampleCaptureRunning,
  isSilentCaptureCheckpoint,
  isSoftSyncCheckpoint,
  onCaptureSettled,
  pauseEnrichment,
  resumeEnrichment,
  revealScheduledCapture,
  startCapture,
  isCaptureStopping,
  waitForCaptureStop,
  startEnrichmentRun,
} from "./linkedin-capture.js";
import { setCompanyDetailsProvider, setLinkedProgressHook } from "../lib/airtable-linked-sync.js";
import { readMutualPrefs } from "../lib/mutual-prefs.js";
import {
  cancelCompanyCapture,
  captureCompany,
  fetchCompanyDetails,
  isCompanyCaptureRunning,
  enrichProfileUrls,
  findBridges,
  findPeople,
  isGraphTaskRunning,
  onGraphTaskSettled,
} from "./linkedin-graph.js";
import {
  BULK_JOB_KEY,
  cancelBulkEnrich,
  isBulkEnrichRunning,
  onBulkEnrichSettled,
  readBulkJob,
  resumeBulkEnrich,
  startBulkEnrich,
  TABLE_MAX_URLS,
} from "./bulk-enrich.js";
import {
  armSessionWatchdog,
  reportLinkedInAuthFailure,
  runSessionHealthCheck,
  SESSION_WATCHDOG_ALARM,
} from "./session-health.js";
import {
  armSoftSyncAlarm,
  ensureSoftSyncAlarm,
  hasCompletedInitialSync,
  readSoftSyncPrefs,
  recordSoftSyncRun,
  SOFT_SYNC_ALARM,
  writeSoftSyncPrefs,
} from "./soft-sync.js";

const LOG_LEVEL = "info"; // "debug" for development
const LOG = (...args) => console.log("[EarthOS:Heart:BG]", ...args);
const DEBUG = (...args) => LOG_LEVEL === "debug" && console.log("[EarthOS:Heart:BG]", ...args);
const ERR = (...args) => console.error("[EarthOS:Heart:BG]", ...args);

// The Companies table's About, website, and sector come from LinkedIn's
// company page, asked for once per company.
setCompanyDetailsProvider(fetchCompanyDetails);

// Company lookups run inside a profile write, where no count moves. Say what's
// happening on whichever progress record is live, so it doesn't read as stuck.
let lastLookupNote = 0;
setLinkedProgressHook(async ({ done, total, name }) => {
  if (done < total && Date.now() - lastLookupNote < 600) return;
  lastLookupNote = Date.now();
  const message = `Looking up companies on LinkedIn · ${done} of ${total}${name ? ` · ${name}` : ""}`;
  const live = ["starting", "in_progress", "scraping_profiles", "uploading"];
  const capture = await readCaptureProgress();
  if (capture && live.includes(capture.status) && capture.runId && capture.runId === currentCaptureRunId()) {
    await updateProgress({ ...capture, message });
    return;
  }
  const { enrich_progress: enrich, company_progress: company } =
    await chrome.storage.local.get(["enrich_progress", "company_progress"]);
  if (enrich?.status === "in_progress") await setEnrichProgress({ ...enrich, message });
  else if (company?.status === "in_progress") await setCompanyProgress({ ...company, message });
});

// ─── Side Panel: open on extension icon click ────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Voyager request shaping ─────────────────────────────────────────────────
//
// A request issued by the worker carries no Referer, where the same request
// from the page carried the connections URL. Restore it for our own requests
// only: the rule is scoped to tabIds [-1], which matches requests that belong
// to no tab — i.e. ours — so the user's own LinkedIn browsing is untouched.
// Session-scoped because tab conditions are not allowed in static rulesets.

const VOYAGER_REFERER_RULE_ID = 1;

async function installVoyagerRequestRules() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [VOYAGER_REFERER_RULE_ID],
      addRules: [{
        id: VOYAGER_REFERER_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{
            header: "referer",
            operation: "set",
            value: `${LINKEDIN_ORIGIN}/mynetwork/invite-connect/connections/`,
          }],
        },
        condition: {
          urlFilter: `|${LINKEDIN_ORIGIN}/voyager/`,
          resourceTypes: ["xmlhttprequest"],
          tabIds: [-1],
          // Only this extension's own requests: not linkedin.com's service
          // worker, which also makes tab-less requests.
          initiatorDomains: [chrome.runtime.id],
        },
      }],
    });
    DEBUG("Voyager referer rule installed");
  } catch (error) {
    // Best effort. Voyager accepts the requests without it; this only narrows
    // the gap between a worker request and a page request.
    DEBUG("Voyager referer rule unavailable:", error?.message || error);
  }
}

// ─── Run lifecycle: keep-alive, resume, health ───────────────────────────────

const KEEPALIVE_ALARM = "keepalive";
const LINKEDIN_RESUME_ALARM = "earthos-linkedin-resume";
// An interrupted run older than this is not resumed on its own — the user's
// intent has gone stale and a silent overnight sync would be a surprise.
const RESUME_MAX_LOCK_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * A service worker is terminated after ~30s idle. An alarm firing resets that
 * timer, so a live run keeps the worker up; the resume alarm is the fallback
 * for when it is killed anyway (crash, memory pressure, browser restart).
 * Both are armed only while work is in flight.
 */
async function armRunAlarms() {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  await chrome.alarms.create(LINKEDIN_RESUME_ALARM, { periodInMinutes: 1 });
}

async function disarmRunAlarms() {
  await chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
  await chrome.alarms.clear(LINKEDIN_RESUME_ALARM).catch(() => {});
}

// The alarms serve every long LinkedIn run — capture, enrichment, mutual
// finding, company capture — so they only come down once *all* of them have
// settled. Anything less either leaks a permanent keep-alive (armed for a
// graph run that never disarms) or strips it from a run still in flight.
function linkedInBusy() {
  return isCaptureRunning() || isEnrichmentRunning() || isGraphTaskRunning() || isBulkEnrichRunning();
}

async function maybeDisarmRunAlarms() {
  if (linkedInBusy()) return;
  // A failed run waiting for its retry needs the alarm that will fire it.
  if (await hasPendingCaptureRetry()) return;
  await disarmRunAlarms();
}

// ─── Retrying a failed sync ──────────────────────────────────────────────────
//
// A sync that dies on something transient — a dropped connection, a LinkedIn
// throttle that outlasts the engine's own backoff, an Airtable 5xx — used to
// end there: an error record, a banner that clears itself after a few seconds,
// and a network that stays half-imported until the user notices and presses
// Sync again. The checkpoint is durable and the import is resumable, so the
// honest behaviour is to pick it back up. Bounded, because a failure that is
// really about the user's account (signed out of either service) will not fix
// itself, and retrying it forever is just noise in their extension log.

const CAPTURE_RETRY_KEY = "earthos_capture_retry";
const CAPTURE_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 5 * 60_000];
// A retry that cannot start — Airtable not set up, signed out of LinkedIn —
// waits for the prerequisite rather than burning an attempt, but not forever.
const CAPTURE_RETRY_WINDOW_MS = 30 * 60_000;
// How long a failure keeps its retry budget. The three attempts belong to one
// episode: while it lasts, a run that keeps failing cannot re-arm itself three
// at a time, and once it lapses a new failure gets its own three rather than
// inheriting a spent count. Nothing but a successful visible sync used to clear
// that count, so a browser that once ran out of attempts never retried again.
const CAPTURE_RETRY_EPISODE_MS = 6 * 60 * 60_000;

async function readCaptureRetry() {
  const stored = await chrome.storage.local.get(CAPTURE_RETRY_KEY);
  return stored[CAPTURE_RETRY_KEY] || null;
}

async function hasPendingCaptureRetry() {
  const retry = await readCaptureRetry().catch(() => null);
  return Boolean(retry?.nextAt) && Date.now() < Number(retry.expiresAt || 0);
}

/**
 * Called after every capture settles. A run that ended in an error schedules
 * its own next attempt; anything else (complete, canceled, or a run the user
 * restarted by hand) retires the schedule.
 *
 * The settled hook also fires for standalone enrichment, and silent scheduled
 * syncs intentionally leave the visible progress record untouched. The settled
 * identity is therefore required; global progress alone can be stale.
 */
async function scheduleCaptureRetryIfFailed(settled) {
  if (settled?.kind !== "capture" || settled.silent) return;
  const progress = await readCaptureProgress();
  const previous = await readCaptureRetry();
  if (!progress?.runId || progress.runId !== settled.runId) return;
  if (progress?.status !== "error") {
    if (previous) await chrome.storage.local.remove(CAPTURE_RETRY_KEY);
    return;
  }
  // Which failure this one belongs to. A record from an episode that has run
  // its course is bookkeeping about a different afternoon, and reading its
  // spent attempts as this failure's is what left a browser with no retries at
  // all until the user happened to run a sync that succeeded.
  const startedAt = Number(previous?.episodeAt) || 0;
  const sameEpisode = startedAt > 0 && Date.now() - startedAt < CAPTURE_RETRY_EPISODE_MS;
  const episodeAt = sameEpisode ? startedAt : Date.now();
  const attempts = sameEpisode ? Number(previous?.attempts) || 0 : 0;
  if (attempts >= CAPTURE_RETRY_DELAYS_MS.length) {
    // Out of attempts: leave the error standing and let the alarms come down.
    // The record stays until the episode lapses, so a run that keeps failing
    // cannot hand itself a fresh budget on every settle.
    await chrome.storage.local.set({
      [CAPTURE_RETRY_KEY]: { attempts, nextAt: null, episodeAt },
    });
    return;
  }
  const delay = CAPTURE_RETRY_DELAYS_MS[attempts];
  const nextAt = Date.now() + delay;
  await chrome.storage.local.set({
    [CAPTURE_RETRY_KEY]: {
      attempts: attempts + 1,
      nextAt,
      expiresAt: nextAt + CAPTURE_RETRY_WINDOW_MS,
      episodeAt,
      mode: settled.mode === "soft" ? "soft" : "full",
      lastError: progress.message || null,
    },
  });
  LOG(`Sync failed; retrying in ${Math.round(delay / 1000)}s (attempt ${attempts + 1} of ${CAPTURE_RETRY_DELAYS_MS.length})`);
}

/**
 * Start a scheduled retry if one is due and can actually run. Resumes from the
 * engine's checkpoint, so it continues the same import rather than re-uploading
 * the network from the beginning.
 */
async function runDueCaptureRetry() {
  if (linkedInBusy()) return false;
  const retry = await readCaptureRetry();
  if (!retry?.nextAt) return false;
  if (Date.now() >= Number(retry.expiresAt || 0)) {
    await chrome.storage.local.remove(CAPTURE_RETRY_KEY);
    return false;
  }
  if (Date.now() < Number(retry.nextAt)) return false;
  // Prerequisites are waited for, not spent: an attempt only counts once the
  // sync actually gets to run.
  if (!(await getToken())) return false;
  try {
    await assertLinkedInSession();
  } catch {
    return false;
  }
  LOG(`Retrying the interrupted sync (attempt ${retry.attempts})`);
  // Keep nextAt due until the run settles. In-memory running state prevents a
  // duplicate while this worker lives; if Chrome kills it between this line
  // and the new capture lock, the still-due record is what makes the next
  // worker try again instead of losing the retry forever.
  await startLinkedInCapture(crypto.randomUUID(), {
    mode: retry.mode === "soft" ? "soft" : "full",
    silent: false,
  });
  return true;
}

onCaptureSettled(async (settled) => {
  // A scheduled sync that finished: the panel shows it as the last auto-sync.
  if (settled?.kind === "capture" && settled.silent && settled.runId) {
    const { capture_results: results } = await chrome.storage.local.get("capture_results").catch(() => ({}));
    if (results?.runId === settled.runId) await recordSoftSyncRun({ completed: true, runId: settled.runId });
  }
  await scheduleCaptureRetryIfFailed(settled).catch((error) => {
    ERR("Could not schedule a sync retry:", error?.message || error);
  });
  await maybeDisarmRunAlarms();
});
onGraphTaskSettled(maybeDisarmRunAlarms);
onBulkEnrichSettled(maybeDisarmRunAlarms);

/** A bulk enrich this worker was killed in the middle of picks up at its next batch. */
async function resumeInterruptedBulkEnrich() {
  if (isBulkEnrichRunning()) return true;
  if (isCaptureRunning() || isEnrichmentRunning() || isGraphTaskRunning()) return false;
  const lock = await readLinkedInCaptureLock();
  if (lock?.runId && Date.now() - Number(lock.updatedAt || 0) < LINKEDIN_CAPTURE_LOCK_MAX_AGE_MS) return false;
  const job = await readBulkJob().catch(() => null);
  if (job?.status !== "running") return false;
  // Can't continue right now: park it as stopped, so the panel offers Resume
  // instead of spinning on a run nothing is doing.
  const pause = async (message) => {
    await chrome.storage.local.set({ [BULK_JOB_KEY]: { ...job, status: "error", error: message } });
    await setEnrichProgress({ status: "error", message, bulk: true });
    return false;
  };
  if (!(await getToken())) return pause("Airtable isn't set up, so the bulk enrich stopped. Fix setup, then resume.");
  try {
    await assertLinkedInSession();
  } catch (error) {
    return pause(`${error.message} Then resume the bulk enrich.`);
  }
  await armRunAlarms();
  const result = await resumeBulkEnrich();
  if (result?.started) LOG("Resumed an interrupted bulk enrich");
  return Boolean(result?.started);
}

/**
 * Restart a run this worker was killed in the middle of.
 *
 * The capture lock doubles as a heartbeat: the engine touches it on every
 * import call. A lock with no in-memory run behind it means the worker died,
 * and the engine's own checkpoints let it pick up at the last durable
 * sequence rather than re-uploading the whole network.
 */
async function resumeInterruptedCapture(reason) {
  if (isCaptureRunning()) return { resumed: false, running: true };
  // A bulk enrich owns LinkedIn right now; the capture waits for the next tick.
  if (isBulkEnrichRunning()) return { resumed: false, running: true };
  const lock = await readLinkedInCaptureLock();
  if (!lock?.runId) return { resumed: false };

  const progress = await readCaptureProgress();
  const terminal = progress?.runId === lock.runId
    && ["complete", "error", "canceled"].includes(progress?.status);
  if (terminal) {
    // Killed between "complete" and its cleanup: the finished import's
    // checkpoint would make the next Sync acknowledge it instead of reading
    // LinkedIn again. A stopped or failed run keeps its checkpoint to resume.
    if (progress.status === "complete") {
      const { earthos_li_progress: left } = await chrome.storage.local.get("earthos_li_progress").catch(() => ({}));
      if (left && (!left.runId || left.runId === lock.runId)) await chrome.storage.local.remove("earthos_li_progress");
    }
    await releaseLinkedInCapture(lock.runId);
    return { resumed: false, reason: "terminal" };
  }
  // A lock with no checkpoint behind it belongs to a run that had already
  // finished its import (the checkpoint is cleared just before the lock is
  // released). Relaunching it would start a new, visible, full-depth walk.
  const checkpoint = await chrome.storage.local.get("earthos_li_progress").catch(() => ({}));
  if (!checkpoint?.earthos_li_progress) {
    await releaseLinkedInCapture(lock.runId);
    return { resumed: false, reason: "finished" };
  }
  // A scheduled run stays invisible across a worker death too: it resumes in
  // soft mode, and its failures go to the soft-sync status record instead of
  // raising a banner for a sync the user never started.
  const soft = await isSoftSyncCheckpoint();
  // Soft no longer implies invisible: a soft sync the user asked for reports
  // like any other run, and only a scheduled one stays quiet across a restart.
  const silent = await isSilentCaptureCheckpoint();
  if (Date.now() - Number(lock.updatedAt || 0) > RESUME_MAX_LOCK_AGE_MS) {
    LOG(`Abandoning stale capture ${lock.runId} (older than 6h)`);
    await releaseLinkedInCapture(lock.runId);
    if (silent) {
      await recordSoftSyncRun({ failed: "stale", runId: lock.runId });
    } else {
      await updateProgress({
        site: "linkedin",
        status: "error",
        message: "The sync was interrupted and is too old to resume automatically. Start it again.",
        runId: lock.runId,
      });
    }
    return { resumed: false, reason: "stale" };
  }

  // Storage still describes a live run, so the alarms that hold the worker up
  // and retry this resume belong armed before anything below gives up for now.
  await armRunAlarms();
  if (!(await getToken())) return { resumed: false, reason: "unauthenticated" };
  try {
    await assertLinkedInSession();
  } catch (error) {
    // Do not burn the run: leave the lock, surface why, and let the next
    // resume tick pick it up once the user signs back into LinkedIn.
    if (silent) {
      await recordSoftSyncRun({ failed: error.message, runId: lock.runId });
    } else {
      await updateProgress({
        site: "linkedin",
        status: "error",
        message: error.message,
        runId: lock.runId,
      });
    }
    // The health record is reported either way — a broken LinkedIn session is
    // worth telling the user about however it was discovered.
    await reportLinkedInAuthFailure();
    return { resumed: false, reason: "linkedin_signed_out" };
  }

  LOG(`Resuming interrupted LinkedIn capture ${lock.runId} (${reason})`);
  await armRunAlarms();
  return { resumed: true, ...startCapture(lock.runId, { ...(soft ? { mode: "soft" } : {}), silent }) };
}

/**
 * Three things race to resume the same run: worker spin-up, the resume alarm,
 * and (through a sync request) the app tab the user just refreshed. Each of
 * them awaits a LinkedIn session probe before deciding, so without this they
 * open three probes and three chances to disagree. One attempt is enough, and
 * the later callers want its answer.
 */
let resumeInFlight = null;

function resumeInterruptedCaptureOnce(reason) {
  if (resumeInFlight) return resumeInFlight;
  const attempt = resumeInterruptedCapture(reason).finally(() => {
    if (resumeInFlight === attempt) resumeInFlight = null;
  });
  resumeInFlight = attempt;
  return attempt;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Receiving the event resets the idle timer that would otherwise tear the
    // worker down mid-run. It is also the run's heartbeat: the capture lock's
    // `updatedAt` is what separates "a worker is alive and still on this run"
    // from "this run was abandoned", and it used to be touched only by
    // published progress. A run that goes quiet without dying — a scheduled
    // soft sync, which publishes nothing at all, or a ten-minute LinkedIn
    // rate-limit cooldown — then aged into looking abandoned, and the next
    // sync request opened a second import instead of adopting this one.
    const runId = currentCaptureRunId();
    if (runId && isCaptureRunning()) void touchLinkedInCapture(runId).catch(() => {});
    return;
  }
  if (alarm.name === LINKEDIN_RESUME_ALARM) {
    void resumeInterruptedCaptureOnce("resume alarm")
      .then(async (result) => {
        // The alarm survives a worker death, but mutual/company runs do not —
        // they have no checkpoint to resume from. If the alarm woke us and
        // there is nothing resumable behind it, settle any orphaned graph
        // progress and stand the alarms down instead of ticking forever.
        const waitingOnUser = ["unauthenticated", "linkedin_signed_out"].includes(result?.reason);
        if (!result?.resumed && !result?.running && !waitingOnUser) {
          // Nothing to adopt. A run that ended in a failure still has a
          // resumable checkpoint behind it, so a scheduled retry gets its turn
          // before the alarms come down. So does an interrupted bulk enrich.
          if (await runDueCaptureRetry()) return;
          if (await resumeInterruptedBulkEnrich()) return;
          await reconcileOrphanedGraphRuns();
          await maybeDisarmRunAlarms();
        }
      })
      .catch((error) => {
        ERR("Capture resume failed:", error?.message || error);
      });
    return;
  }
  if (alarm.name === SESSION_WATCHDOG_ALARM) {
    void runSessionHealthCheck({ reason: "watchdog" }).catch((error) => {
      ERR("Session watchdog failed:", error?.message || error);
    });
    // Piggyback on the watchdog cadence to restore the soft-sync alarm after
    // an extension update cleared it.
    void ensureSoftSyncAlarm().catch(() => {});
    return;
  }
  if (alarm.name === SOFT_SYNC_ALARM) {
    void runScheduledSoftSync().catch((error) => {
      ERR("Scheduled soft sync failed:", error?.message || error);
    });
  }
});

// ─── Soft sync: quiet scheduled runs ─────────────────────────────────────────

/**
 * One scheduled soft-sync tick. Every guard skips silently: this fires up to
 * several times a day in the background, and anything worth telling the user
 * about (signed out of LinkedIn, Airtable not set up) is already surfaced by
 * the session watchdog. The run itself is a normal capture in soft mode —
 * conversation metadata is refreshed for everyone, while people who already
 * have an Airtable row are skipped by the enrichment pass — and it reports
 * nothing while it runs, including on failure. Outcomes land in the soft-sync
 * status record instead.
 */
async function runScheduledSoftSync() {
  const prefs = await readSoftSyncPrefs();
  await repairPeopleTable("scheduled sync").catch(() => {});
  if (!prefs.enabled) return;
  if (await hasPendingCaptureRetry()) {
    // The failed visible run owns the resumable checkpoint until its retry
    // succeeds or expires. Starting a scheduled walk here would replace that
    // checkpoint and turn "resume" into "start over".
    //
    // Ownership ends with the window, which is why this asks whether an attempt
    // is still coming rather than whether the run ever failed: a spent retry
    // leaves { attempts, nextAt: null } behind, and reading that tombstone as
    // ownership retired the schedule for good — for exactly the user relying
    // on it, whose sync had failed and so never refreshed itself again.
    await recordSoftSyncRun({ skipped: "capture_retry" });
    return;
  }
  if (linkedInBusy()) {
    await recordSoftSyncRun({ skipped: "busy" });
    return;
  }
  const lock = await readLinkedInCaptureLock();
  if (lock?.runId && Date.now() - Number(lock.updatedAt || 0) < LINKEDIN_CAPTURE_LOCK_MAX_AGE_MS) {
    // A live run elsewhere (or one the resume alarm is about to pick up)
    // outranks a scheduled refresh.
    await recordSoftSyncRun({ skipped: "capture_lock" });
    return;
  }
  if (!(await getToken())) {
    await recordSoftSyncRun({ skipped: "unauthenticated" });
    return;
  }
  if (!(await hasCompletedInitialSync())) {
    // Soft sync refreshes a network; it does not build one. On a browser that
    // has never finished a sync nothing is known yet, so this would walk every
    // page and enrich every profile — making the user's *first* import the
    // unattended one. That first run stays theirs to start.
    await recordSoftSyncRun({ skipped: "no_initial_sync" });
    return;
  }
  try {
    await assertLinkedInSession();
  } catch {
    await recordSoftSyncRun({ skipped: "linkedin_signed_out" });
    return;
  }
  await refreshSchemaQuietly();
  const runId = crypto.randomUUID();
  LOG(`Starting scheduled soft sync ${runId}`);
  await recordSoftSyncRun({ started: true, runId });
  await startLinkedInCapture(runId, { mode: "soft", silent: true, sampleLimit: null });
}

/**
 * Mutual-finding and company-capture runs live only in worker memory. When the
 * worker dies mid-run (crash, update, browser restart) their storage progress
 * stays "in_progress" forever and the side panel spins with no way out. A
 * fresh worker has no such run by definition, so settle the stale entries.
 */
/**
 * Re-read the base's tables and columns, as Reload columns does, so a table
 * or column added in Airtable (Interactions, Notes) shows up without it.
 * Skipped while a run is writing; a failure keeps the last schema.
 */
async function refreshSchemaQuietly() {
  if (linkedInBusy()) return;
  const config = await readConfig().catch(() => ({}));
  if (!config.token || !config.baseId || !config.tableId) return;
  await refreshSchema(config).catch((error) => LOG(`Schema refresh skipped: ${error?.message || error}`));
}

async function reconcileOrphanedGraphRuns() {
  if (isGraphTaskRunning()) return;
  const { mutual_progress: mutual, company_progress: company } =
    await chrome.storage.local.get(["mutual_progress", "company_progress"]);
  if (mutual?.status === "in_progress" || mutual?.status === "uploading") {
    await setMutualProgress({ status: "error", message: "Mutual finding was interrupted. Start it again." });
  }
  if (company?.status === "in_progress") {
    await setCompanyProgress({
      status: "error",
      message: "Company capture was interrupted. Start it again.",
      requestId: company.requestId ?? null,
    });
  }
}

/**
 * The alarm that fires a pending retry, put back after anything that clears
 * alarms wholesale — an extension update does exactly that. The retry record
 * outlives the alarm, so without this the failed sync waits on a tick that is
 * never coming and quietly expires instead of being retried.
 */
async function reviveRunAlarmsForPendingRetry() {
  if (await hasPendingCaptureRetry()) await armRunAlarms();
}

async function bootstrap(reason) {
  await installVoyagerRequestRules();
  await armSessionWatchdog({ soon: true });
  await reviveRunAlarmsForPendingRetry().catch(() => undefined);
  await repairPeopleTable(reason).catch(() => undefined);
  await ensureSyncUser().catch(() => undefined);
  // Pick up column changes, and any new link kinds, when the extension (re)loads.
  await readConfig()
    .then((config) => (config.token && config.baseId && config.tableId ? refreshSchema(config) : null))
    .catch(() => undefined);
  await runSessionHealthCheck({ reason }).catch(() => undefined);
  await ensureSoftSyncAlarm().catch(() => undefined);
  await reconcileOrphanedGraphRuns().catch(() => undefined);
  await resumeInterruptedCaptureOnce(reason).catch(() => undefined);
  await resumeInterruptedBulkEnrich().catch(() => undefined);
}

chrome.runtime.onStartup.addListener(() => {
  void bootstrap("browser startup");
});
chrome.runtime.onInstalled.addListener(() => {
  void bootstrap("install or update");
});
// A worker that spins up for any other reason (a message, an alarm) still
// needs its session rules and watchdog in place.
void installVoyagerRequestRules();
void armSessionWatchdog();
void reviveRunAlarmsForPendingRetry().catch(() => {});
// Arm from local prefs only — no network on plain worker spin-up. The alarm
// is left untouched when its period already matches, so this never defers a
// pending run.
void readSoftSyncPrefs().then(armSoftSyncAlarm).catch(() => {});
// A run this worker was killed in the middle of restarts here too, not only on
// browser start and update. Whatever woke the worker — an alarm, the side
// panel — is a chance to
// pick the sync back up immediately instead of waiting on the resume alarm,
// which is a full minute away at best and gone entirely if it was ever
// cleared. It is the same guarded call the alarm makes: a live run, a
// finished one, and a lock older than six hours all decline it.
void resumeInterruptedCaptureOnce("worker spin-up").catch((error) => {
  ERR("Capture resume on spin-up failed:", error?.message || error);
});
void resumeInterruptedBulkEnrich().catch(() => {});
void repairPeopleTable("worker spin-up").catch(() => {});

// ─── Message Handler ─────────────────────────────────────────────────────────

/** Only the extension's own pages (the side panel) command it. */
function isExtensionPage(sender) {
  return sender?.id === chrome.runtime.id
    && typeof sender.url === "string"
    && sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionPage(sender)) {
    sendResponse({ error: "Rejected message from outside the extension" });
    return false;
  }
  DEBUG("Message received:", message?.type);
  handleMessage(message || {})
    .then((result) => sendResponse(result))
    .catch((err) => {
      ERR("Error handling", message?.type, ":", err?.message || err);
      sendResponse(serializeMessageError(err));
    });
  return true; // keep channel open for async response
});

function serializeMessageError(error) {
  if (error instanceof ApiError) {
    return { error: error.message, status: error.status, code: error.code, type: error.type || null };
  }
  if (error instanceof LinkedInSessionError) {
    return { error: error.message, code: error.code, stage: "linkedin_session" };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

async function handleMessage(message) {
  switch (message.type) {
    case "START_CAPTURE":
      return handleStartCapture(message.site || "linkedin", {
        mode: message.mode === "soft" ? "soft" : "full",
        sampleLimit: message.sample === true ? TEST_SYNC_LIMIT : null,
      });

    case "GET_CAPTURE_STATUS":
      return getCaptureStatus();

    case "GET_CONNECTION_HEALTH":
      // `probe` forces a live LinkedIn check; the panel uses it on open.
      return runSessionHealthCheck({ reason: "requested", probeLinkedIn: message.probe === true });

    case "GET_LINKEDIN_SESSION":
      return readLinkedInSessionState();

    case "START_ENRICHMENT":
      return handleStartEnrichment(message.connections);

    case "PAUSE_ENRICHMENT":
      return pauseEnrichment();

    case "RESUME_ENRICHMENT":
      return resumeEnrichment();

    case "CANCEL_SYNC":
      return handleCancelSync();

    case "SET_SOFT_SYNC_PREFS": {
      const raw = message.prefs && typeof message.prefs === "object" ? message.prefs : {};
      const prefs = await writeSoftSyncPrefs({
        enabled: raw.enabled === true,
        timesPerDay: Number(raw.timesPerDay),
      });
      return { ok: true, prefs };
    }

    case "START_COMPANY_CAPTURE":
      return handleCompanyCapture(message.company, {
        requestId: typeof message.requestId === "string" ? message.requestId.slice(0, 100) : null,
        keywords: Array.isArray(message.keywords)
          ? message.keywords
            .filter((keyword) => typeof keyword === "string" && keyword.trim())
            .map((keyword) => keyword.trim().slice(0, 80))
            .slice(0, 6)
          : [],
      });

    case "START_MUTUAL_FINDING":
      return handleStartMutualFinding(message.contacts);

    case "SEARCH_LINKEDIN_PEOPLE":
      return handleSearchLinkedInPeople(message.query, message.limit);

    case "CAPTURE_PROFILES":
      return handleCaptureProfiles(message.urls);

    case "LOG_INTERACTION":
      return handleLogInteraction(message);

    case "BULK_ENRICH":
      return handleBulkEnrich(message.urls);

    case "BULK_ENRICH_RESUME":
      return handleBulkEnrich(null);

    case "ENRICH_FROM_TABLE":
      return handleEnrichFromTable(String(message.tableId || ""), String(message.fieldId || ""));

    case "AIRTABLE_GET_CONFIG":
      await repairPeopleTable("panel opened").catch(() => {});
      return publicConfig(await readConfig());

    case "AIRTABLE_SET_SYNC_AS": {
      // For a token a team shares: whose name goes in Known by. Blank clears it.
      const email = typeof message.email === "string" ? message.email.trim() : "";
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("That isn't an email address.");
      return publicConfig(await writeConfig({ syncAsEmail: email || null, knownByBlocked: false }));
    }

    case "AIRTABLE_DISMISS_NOTICE":
      return publicConfig(await writeConfig({ notice: null }));

    case "AIRTABLE_CONNECT":
      return handleAirtableConnect(message.token);

    case "AIRTABLE_LIST_TABLES": {
      const tables = await listTables(await airtableToken(), String(message.baseId || ""));
      return { tables, suggested: suggestPeopleTable(tables)?.id || null };
    }

    case "AIRTABLE_SELECT_TABLE":
      return handleAirtableSelectTable(message);

    case "AIRTABLE_SAVE_MAPPING":
      return handleAirtableSaveMapping(message.mapping, message.stampValue);

    case "AIRTABLE_CREATE_FIELDS":
      return handleAirtableCreateFields(message.keys);

    case "AIRTABLE_SAVE_LINKED":
      return handleAirtableSaveLinked(message.linked);

    case "AIRTABLE_SUGGEST_LINKED":
      return handleAirtableSuggestLinked(typeof message.only === "string" ? message.only : null);

    case "AIRTABLE_REFRESH_SCHEMA": {
      // Reloading columns is also how someone invited since retries Known by.
      const config = await readConfig();
      if (config.knownByBlocked) await writeConfig({ knownByBlocked: false, ...(/Known by/.test(config.notice || "") ? { notice: null } : {}) });
      return afterConfigChange(await refreshSchema(await readConfig()));
    }

    case "AIRTABLE_RESYNC_ALL":
      await assertIdle();
      await resetTableState();
      return publicConfig(await readConfig());

    case "AIRTABLE_DISCONNECT":
      if (linkedInBusy()) {
        await revealHiddenSync();
        return { error: "Stop the running capture first." };
      }
      await clearConfig();
      await resetImportLedger();
      return afterConfigChange({});

    default:
      DEBUG("Unknown message type:", message.type);
      return { error: "Unknown message type" };
  }
}

// ─── Airtable setup ──────────────────────────────────────────────────────────

async function airtableToken() {
  const { token } = await readConfig();
  if (!token) throw new AirtableError("Paste an Airtable personal access token first.", { status: 401 });
  return token;
}

/** Setups saved before Known by existed learn whose token they hold, once. */
async function ensureSyncUser() {
  const config = await readConfig();
  if (!config.token || config.userId) return;
  const me = await whoami(config.token);
  if (me?.id) await writeConfig({ userId: me.id, userEmail: me.email || config.userEmail || null });
}

/**
 * A setup pointing people at the wrong table moves itself to the right one:
 * the table the base's Work history links people in. It keeps (or restores)
 * that table's own mapping, and leaves a notice for the panel.
 */
async function repairPeopleTable(reason) {
  const config = await readConfig();
  if (!config.token || !config.baseId || !config.tableId || !config.baseTables?.length) return false;
  const mismatch = peopleTableMismatch(config.baseTables, config.tableId);
  if (!mismatch || linkedInBusy()) return false;
  LOG(`People table was ${config.tableName}; moving to ${mismatch.name} (${reason})`);
  await handleAirtableSelectTable({ baseId: config.baseId, tableId: mismatch.id });
  await writeConfig({
    notice: `Now writing to ${mismatch.name}, not ${config.tableName}: your ${mismatch.via} table links people in ${mismatch.name}.`,
  });
  return true;
}

/** The config as the panel sees it: never the token itself. */
async function publicConfig(config) {
  const stored = await chrome.storage.local.get(LAST_WRITE_KEY).catch(() => ({}));
  return {
    connected: Boolean(config.token),
    tokenHint: config.token ? `…${config.token.slice(-4)}` : null,
    userEmail: config.userEmail || null,
    userId: config.userId || null,
    syncAsEmail: config.syncAsEmail || null,
    knownByBlocked: Boolean(config.knownByBlocked),
    bases: config.bases || [],
    baseId: config.baseId || null,
    baseName: config.baseName || null,
    tableId: config.tableId || null,
    tableName: config.tableName || null,
    fields: config.fields || [],
    mapping: config.mapping || {},
    stampValue: config.stampValue || null,
    notice: config.notice || null,
    baseTables: config.baseTables || [],
    linked: config.linked || {},
    linkedReady: linkedReady(config.linked),
    // Which table the linked tables expect people in, when it isn't this one.
    peopleMismatch: config.tableId ? peopleTableMismatch(config.baseTables || [], config.tableId) : null,
    problem: configProblem(config),
    indexed: await indexedPeopleCount().catch(() => 0),
    lastWrite: stored[LAST_WRITE_KEY] || null,
  };
}

async function afterConfigChange(config) {
  void runSessionHealthCheck({ reason: "airtable_config" }).catch(() => {});
  return publicConfig(config);
}

/**
 * A scheduled sync runs hidden. When it's what stands in the way, show it —
 * progress and Stop — so "stop it first" names something the user can see.
 */
async function revealHiddenSync() {
  if (isCaptureRunning()) await revealScheduledCapture("soft").catch(() => false);
}

async function assertIdle() {
  if (linkedInBusy()) {
    await revealHiddenSync();
    throw new Error("Stop the running capture before changing where people go.");
  }
}

async function handleAirtableConnect(rawToken) {
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!/^pat[A-Za-z0-9.]{10,}$/.test(token)) {
    throw new AirtableError("That doesn't look like a personal access token (they start with \"pat\").", { status: 400 });
  }
  const me = await whoami(token);
  const bases = (await listBases(token)).map(({ id, name, permissionLevel }) => ({ id, name, permissionLevel }));
  const current = await readConfig();
  const keepTable = current.token && bases.some((base) => base.id === current.baseId);
  if (!keepTable) forgetTableState();
  // Who the token belongs to: "Known by" is set to this user. A new token is a
  // new chance, so a collaborator block from the last one is lifted.
  const identity = { token, userId: me.id || null, userEmail: me.email || null, bases, knownByBlocked: false };
  const config = keepTable
    ? await writeConfig(identity)
    : await writeConfig({
      ...identity,
      baseId: null, baseName: null, tableId: null, tableName: null, fields: [], mapping: {},
    });
  return afterConfigChange(config);
}

async function handleAirtableSelectTable({ baseId, tableId }) {
  await assertIdle();
  const token = await airtableToken();
  const config = await readConfig();
  const base = (config.bases || []).find((candidate) => candidate.id === baseId);
  if (!base) throw new Error("Pick a base the token can see.");
  const tables = await listTables(token, baseId);
  const table = tables.find((candidate) => candidate.id === tableId);
  if (!table) throw new Error("That table isn't in this base.");
  const fields = table.fields.map(({ id, name, type, options }) => ({ id, name, type, options }));
  const sameTable = config.baseId === baseId && config.tableId === tableId;
  if (!sameTable) forgetTableState();
  // A table set up before gets its own mapping back, minus anything that no
  // longer fits; a new one is matched by column name. Either way it stays
  // editable in the panel.
  const saved = sameTable
    ? { mapping: config.mapping, mappingSeen: config.mappingSeen, stampValue: config.stampValue, linked: config.linked, linkedChosen: config.linkedChosen }
    : savedSetupFor(config, baseId, tableId);
  const live = new Map(fields.map((field) => [field.id, field]));
  // A restored mapping also picks up fields it has never been offered.
  const { mapping, mappingSeen } = saved
    ? offerNewMappings(fields, Object.fromEntries(Object.entries(saved.mapping || {}).filter(([key, fieldId]) => canMap(key, live.get(fieldId)))), saved.mappingSeen)
    : (() => {
      const fresh = suggestMapping(fields, {});
      return { mapping: fresh, mappingSeen: seenMappings(fields, fresh) };
    })();
  const chosen = saved?.linkedChosen
    ? pruneLinked(tables, tableId, saved.linked || {})
    : suggestLinked(tables, tableId, saved?.linked || {});
  // A fresh match has seen every link kind; a restored one gets any new kind offered once.
  const { linked, linkedSeen } = offerNewPeopleLinks(tables, tableId, chosen, saved ? saved.linkedSeen : PEOPLE_LINKS.map((link) => link.key));
  const next = await writeConfig({
    baseId,
    baseName: base.name,
    tableId,
    tableName: table.name,
    fields,
    mapping,
    mappingSeen,
    stampValue: null,
    linked,
    linkedSeen,
    linkedChosen: true,
    baseTables: summarizeTables(tables),
    schemaAt: Date.now(),
    // A collaborator block belongs to the base it happened on.
    ...(config.baseId !== baseId ? { knownByBlocked: false, ...(/Known by/.test(config.notice || "") ? { notice: null } : {}) } : {}),
  });
  // The marker's value follows the column the mapping just chose.
  const stampValue = stampValueFor(fields, next.mapping, saved?.stampValue || null);
  return afterConfigChange(stampValue === next.stampValue ? next : await writeConfig({ stampValue }));
}

/** The marker value to keep: the one asked for if it's a real choice, else the suggested one. */
function stampValueFor(fields, mapping, requested) {
  const field = fields.find((candidate) => candidate.id === mapping.createdStamp);
  if (!field) return null;
  const choices = (field.options?.choices || []).map((choice) => choice.name);
  return requested && choices.includes(requested) ? requested : suggestStampValue(field);
}

async function handleAirtableSaveMapping(rawMapping, requestedStamp) {
  await assertIdle();
  const config = await readConfig();
  const fields = new Map((config.fields || []).map((field) => [field.id, field]));
  const mapping = {};
  const used = new Set();
  for (const [key, fieldId] of Object.entries(rawMapping && typeof rawMapping === "object" ? rawMapping : {})) {
    if (!fieldId) continue;
    if (!SOURCE_FIELD_BY_KEY.has(key)) throw new Error(`Unknown capture field "${key}".`);
    const field = fields.get(fieldId);
    if (!isWritable(field)) throw new Error(`"${field?.name || fieldId}" can't be written by the API.`);
    if (used.has(fieldId)) throw new Error(`"${field.name}" is mapped twice.`);
    if (!canMap(key, field)) {
      throw new Error(`"${SOURCE_FIELD_BY_KEY.get(key).label}" can't go in a ${field.type} column.`);
    }
    used.add(fieldId);
    mapping[key] = fieldId;
  }
  const stampValue = stampValueFor(config.fields || [], mapping, requestedStamp ?? config.stampValue);
  // Whatever was left unmapped here with a column to go in, stays unmapped.
  const mappingSeen = seenMappings(config.fields || [], mapping, config.mappingSeen);
  return afterConfigChange(await writeConfig({ mapping, mappingSeen, stampValue }));
}

/**
 * Save the linked-table choices. Anything that can't play its part — a column
 * of the wrong type, a link pointing at another table, a column marked for
 * deletion — is dropped rather than saved.
 */
async function handleAirtableSaveLinked(requested) {
  await assertIdle();
  const config = await readConfig();
  if (!config.tableId) throw new Error("Pick the People table first.");
  const chosen = ["companies", "workHistory", "schools"].map((key) => requested?.[key]?.tableId).filter(Boolean);
  if (chosen.includes(config.tableId)) throw new Error("The People table can't also be a linked table.");
  if (new Set(chosen).size !== chosen.length) throw new Error("Each linked table has to be a different table.");
  const linked = pruneLinked(config.baseTables || [], config.tableId, requested || {});
  forgetTableState();
  return afterConfigChange(await writeConfig({ linked, linkedChosen: true }));
}

/**
 * Fill unset linked tables and columns by name, keeping what's chosen. With
 * `only`, just that part's columns and the People links pointing at it, so a
 * part someone set to None stays None.
 */
async function handleAirtableSuggestLinked(only) {
  await assertIdle();
  const config = await readConfig();
  if (!config.tableId) throw new Error("Pick the People table first.");
  const current = config.linked || {};
  const suggested = suggestLinked(config.baseTables || [], config.tableId, current);
  let linked = suggested;
  if (only) {
    linked = { ...current, peopleLinks: { ...(current.peopleLinks || {}) } };
    if (current[only]?.tableId) linked[only] = suggested[only];
    for (const link of PEOPLE_LINKS) {
      if (link.target === only && !linked.peopleLinks[link.key] && suggested.peopleLinks?.[link.key]) {
        linked.peopleLinks[link.key] = suggested.peopleLinks[link.key];
      }
    }
  }
  forgetTableState();
  return afterConfigChange(await writeConfig({ linked, linkedChosen: true }));
}

/** Make a column for each unmapped capture field, then map it. */
async function handleAirtableCreateFields(keys) {
  await assertIdle();
  const token = await airtableToken();
  let config = await readConfig();
  if (!config.baseId || !config.tableId) throw new Error("Pick a table first.");
  // Columns made by an earlier attempt that stopped partway are in the table now.
  config = await refreshSchema(config);
  const taken = new Set((config.fields || []).map((field) => field.name.toLowerCase()));
  const mapping = { ...(config.mapping || {}) };
  // A marker column needs choices someone decides on; it's never made here.
  const wanted = (Array.isArray(keys) ? keys : [])
    .filter((key) => SOURCE_FIELD_BY_KEY.has(key) && !mapping[key] && !SOURCE_FIELD_BY_KEY.get(key).noCreate);
  try {
    for (const key of wanted) {
      const label = SOURCE_FIELD_BY_KEY.get(key).label;
      let name = label;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${label} ${n}`;
      try {
        const created = await createField(token, config.baseId, config.tableId, newFieldSpec(key, name));
        mapping[key] = created.id;
        taken.add(name.toLowerCase());
      } catch (error) {
        if (error?.status === 403) {
          throw new AirtableError("Creating columns needs the schema.bases:write scope on the token, and creator access to the base.", { status: 403 });
        }
        throw error;
      }
    }
  } finally {
    // Whatever was made stays mapped, even if a later column failed.
    config = await writeConfig({ mapping });
  }
  return afterConfigChange(await refreshSchema(config));
}

// ─── Shared LinkedIn gate ────────────────────────────────────────────────────

/**
 * Hard deadline on a request/response LinkedIn call.
 *
 * This used to wrap chrome.tabs.sendMessage, guarding against a content script
 * that died mid-task and never answered. The engine runs in-process now, but
 * the guarantee still matters: the app is blocked on this reply, and a task
 * that never settles is worse than one that fails. Individual Voyager requests
 * already have a 20s abort, so tripping this means a loop is stuck, not that
 * LinkedIn is slow.
 */
function withDeadline(promise, timeoutMs, timeoutError) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Every LinkedIn entry point runs this first. It replaces what the tab used to
 * prove implicitly by existing: that Airtable is set up and that the
 * browser still holds a LinkedIn session. A failure here is reported to the
 * health record so the user gets one clear reason instead of a stalled task.
 */
async function requireLinkedInAccess() {
  await repairPeopleTable("capture requested").catch((error) => ERR("People table repair failed:", error?.message || error));
  await ensureSyncUser().catch(() => {});
  if (!(await getToken())) {
    return { error: (await readConfig().then(configProblem)) || "Connect Airtable in the side panel first." };
  }
  try {
    await assertLinkedInSession();
    return null;
  } catch (error) {
    void reportLinkedInAuthFailure().catch(() => {});
    return { error: error.message, code: error.code || "signed_out" };
  }
}

// ─── Capture Orchestration ───────────────────────────────────────────────────

// A test sync runs the whole pipeline over only this many connections.
const TEST_SYNC_LIMIT = 10;

async function handleStartCapture(site, { force = false, mode = "full", sampleLimit = null } = {}) {
  LOG(`Starting capture: site=${site}, force=${force}, mode=${mode}${sampleLimit ? `, test of ${sampleLimit}` : ""}`);

  if (site !== "linkedin") return { error: "Only LinkedIn capture is supported." };

  const denied = await requireLinkedInAccess();
  if (denied) {
    await updateProgress({ site, status: "error", message: denied.error });
    return denied;
  }

  if (isBulkEnrichRunning()) {
    return { error: "A bulk enrich is running. Let it finish or stop it first." };
  }

  // Sync pressed right after Stop: let the stopped run finish its last write,
  // then start this one fresh.
  await waitForCaptureStop();
  if (isCaptureStopping()) return { error: "The last sync is still stopping. Try again in a moment." };

  if (isCaptureRunning()) {
    // A test and a real sync can't share one run: joining would either cap
    // the real one or grow the test.
    if (sampleLimit) {
      await revealHiddenSync();
      return { error: "A sync is already running. Stop it before starting a test sync." };
    }
    if (isSampleCaptureRunning()) return { error: "A test sync is running. Let it finish or stop it first." };
    // A scheduled soft sync reports nothing while it runs. If the user asks for
    // a sync on top of one, let it keep the engine — a second import over the
    // same rows is worse — but stop hiding it, so the app tracks a real run
    // instead of an acknowledgement with no progress behind it.
    if (await revealScheduledCapture(mode)) {
      LOG(`Joining the live sync to the user's requested ${mode} sync`);
      return { started: true, alreadyRunning: true, runId: currentCaptureRunId() };
    }
    // The run may have settled while revealCapture awaited its progress write.
    // If so, continue below and start the requested full run normally.
    if (isCaptureRunning()) {
      return { started: true, alreadyRunning: true, runId: currentCaptureRunId() };
    }
  }

  const lock = await readLinkedInCaptureLock();
  const lockFresh = lock?.runId
    && Date.now() - Number(lock.updatedAt || 0) < LINKEDIN_CAPTURE_LOCK_MAX_AGE_MS;
  if (lockFresh && !force) {
    // A fresh lock with nothing running in memory means this worker was
    // restarted under a live run. Continue that run instead of opening a
    // second import over the same rows. A requested FULL sync upgrades an
    // adopted soft run: the checkpoint re-queues every page the soft run
    // already uploaded (see upgradeSoftRunToFull) so the user gets the full
    // enrichment they asked for. A requested soft sync adopts without naming a
    // mode — it must never downgrade an interrupted full run and throw away
    // the enrichment that run was in the middle of doing.
    LOG(`Adopting interrupted capture ${lock.runId} (requested ${mode})`);
    return startLinkedInCapture(lock.runId, {
      ...(mode === "full" ? { mode: "full" } : {}),
      silent: false,
      sampleLimit,
    });
  }
  if (lockFresh && force) {
    LOG(`Force restart — releasing capture lock held by run ${lock.runId}`);
    await releaseLinkedInCapture(lock.runId);
  }

  if (mode === "soft") await refreshSchemaQuietly();
  // Requested, therefore visible — a soft sync the user asked for still gets a
  // progress bar, unlike the scheduled one that shares its depth.
  return startLinkedInCapture(crypto.randomUUID(), { mode, silent: false, sampleLimit });
}

async function startLinkedInCapture(runId, options = {}) {
  // A scheduled run publishes no progress and no errors: the user did not ask
  // for it, so it must not open a progress bar or raise a banner they cannot
  // act on. Its outcome goes to the soft-sync status record instead.
  const silent = options.silent === undefined ? options.mode === "soft" : options.silent === true;
  await armRunAlarms();
  // Start first: when a run is already live (a double click, a retry or the
  // schedule landing at the same moment), a "starting" record under this new
  // id would hide the real run's progress and completion behind it.
  const result = startCapture(runId, options);
  if (!silent && result?.started && !result.alreadyRunning) {
    await updateProgress({
      site: "linkedin",
      status: "starting",
      phase: "starting",
      current: 0,
      total: 0,
      discovered: 0,
      saved: 0,
      enriched: 0,
      message: "Checking your LinkedIn session…",
      runId,
      sample: Boolean(options.sampleLimit),
      // So "Try again" reruns the same kind of sync.
      mode: options.mode ? (options.mode === "soft" ? "soft" : "full") : ((await isSoftSyncCheckpoint()) ? "soft" : "full"),
    });
  }
  if (result?.error) {
    await maybeDisarmRunAlarms();
    if (silent) await recordSoftSyncRun({ failed: result.error, runId });
    else await updateProgress({ site: "linkedin", status: "error", message: result.error, runId });
  }
  return result;
}

async function handleStartEnrichment(connections) {
  if (!Array.isArray(connections) || connections.length === 0) {
    return { error: "No connections to enrich" };
  }
  if (connections.length > 5_000) {
    return { error: "Too many connections to enrich in one request" };
  }
  LOG(`Starting enrichment for ${connections.length} connections`);

  const denied = await requireLinkedInAccess();
  if (denied) {
    await setEnrichProgress({ status: "error", message: denied.error });
    return denied;
  }

  await armRunAlarms();
  const result = startEnrichmentRun(connections);
  if (result?.error) await maybeDisarmRunAlarms();
  return result;
}

async function handleCancelSync() {
  const progressBeforeCancel = await readCaptureProgress();

  // 1) Stop the engines. Both flip a cancel flag their loops check at every
  //    checkpoint, and abort any request already in flight.
  await cancelLinkedInWork().catch((err) => ERR("Cancel failed:", err.message));
  cancelCompanyCapture();
  cancelEpoch++;
  await cancelBulkEnrich().catch(() => {});

  // 2) Wipe SW-side progress state so the panel falls back to the select view.
  try {
    await setEnrichProgress({ status: "canceled" });
    await setMutualProgress({ status: "canceled" });
    await setCompanyProgress({ status: "canceled" });
    await updateProgress({
      site: progressBeforeCancel?.site || "linkedin",
      status: "canceled",
      current: Number(progressBeforeCancel?.current) || 0,
      total: Number(progressBeforeCancel?.total) || 0,
      message: "Capture canceled",
      runId: progressBeforeCancel?.runId || null,
    });
  } catch (err) {
    ERR("CANCEL_SYNC storage clear failed:", err.message);
  }

  // A mutual-finding run has no cancel flag and may still be in flight;
  // leave its keep-alive alone and let the settled hook take the alarms down.
  await maybeDisarmRunAlarms();
  LOG("Sync canceled");
  return { canceled: true };
}

// ─── Company People Capture ──────────────────────────────────────────────────
//
// Given a company name, collect the people (1st/2nd/3rd degree) whose *current*
// company is that company — narrowed to role keywords when given — and enrich
// each into a full profile. The work runs in linkedin-graph.js:
//   1. Resolve the company name → numeric id  (clusters COMPANIES search).
//   2. Page the clusters PEOPLE search filtered to currentCompany, per keyword.
//   3. Enrich every result with the FullProfileWithEntities pass.
// The engine streams company_progress and finishes by uploading through
// capture-results.js, which writes them into Airtable. Cancellation rides
// CANCEL_SYNC.

// Held from the busy check until the engine takes over, so two STARTs landing
// together cannot both pass the check across the awaits in between.
let companyCaptureStarting = false;

async function handleCompanyCapture(company, options = {}) {
  const name = (company || "").trim();
  const requestId = options.requestId ?? null;
  if (name.length < 2) {
    await setCompanyProgress({ status: "error", message: "Enter a company name.", requestId });
    return { error: "Company name too short" };
  }
  // Checked before touching company_progress: the running capture owns it.
  if (companyCaptureStarting || isCompanyCaptureRunning()) {
    return { error: "A company capture is already running.", busy: true };
  }
  companyCaptureStarting = true;
  try {
    LOG(`Company capture: "${name}"`);
    const denied = await requireLinkedInAccess();
    if (denied) {
      await setCompanyProgress({ status: "error", message: denied.error, requestId });
      return denied;
    }

    await setCompanyProgress({ status: "in_progress", current: 0, total: 0, message: "Starting…", requestId });
    try {
      await armRunAlarms();
      return await captureCompany(name, options);
    } catch (err) {
      ERR("Company capture start failed:", err.message);
      await setCompanyProgress({ status: "error", message: err.message, requestId });
      return { error: err.message };
    }
  } finally {
    companyCaptureStarting = false;
  }
}

// ─── Mutual-Connection (Bridge) Finder ───────────────────────────────────────

async function handleStartMutualFinding(contacts) {
  LOG(`[MUTUALS] ${contacts?.length || 0} contact(s)`);

  const denied = await requireLinkedInAccess();
  if (denied) {
    await setMutualProgress({ status: "error", message: denied.error });
    return denied;
  }

  if (!Array.isArray(contacts) || contacts.length === 0) {
    await setMutualProgress({ status: "error", message: "No contacts to process" });
    return { error: "No contacts" };
  }

  const targets = contacts
    .filter((c) => c && c.linkedinUrl)
    .map((c) => ({ linkedinUrl: c.linkedinUrl }));

  if (targets.length === 0) {
    await setMutualProgress({ status: "error", message: "No LinkedIn contacts found" });
    return { error: "No LinkedIn contacts" };
  }

  await setMutualProgress({
    status: "in_progress",
    current: 0,
    total: targets.length,
    message: "Starting mutual finder...",
  });

  try {
    await armRunAlarms();
    const response = await findBridges(targets, { maxBridges: (await readMutualPrefs()).maxPerProfile });
    if (response?.error) {
      await setMutualProgress({ status: "error", message: response.error });
      return { error: response.error };
    }
    return { started: true, count: targets.length };
  } catch (err) {
    ERR("Failed to start mutual finding:", err.message);
    await setMutualProgress({ status: "error", message: err.message });
    return { error: err.message };
  }
}

/**
 * Free-text people search. Unlike the mutual finder this is request/response —
 * the app's search panel waits for the result to render a picker.
 */
async function handleSearchLinkedInPeople(query, limit) {
  const trimmed = (query || "").trim();
  if (trimmed.length < 2) return { error: "Query too short" };

  // Clamp caller-provided limit to LinkedIn's single-page ceiling; fall back
  // to 10 (original mutuals-picker default) when omitted.
  const cappedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(49, Math.floor(limit))) : 10;

  const denied = await requireLinkedInAccess();
  if (denied) return denied;

  try {
    const response = await withDeadline(
      findPeople(trimmed, cappedLimit),
      90_000,
      "LinkedIn search timed out. Try again in a moment.",
    );
    if (response?.error) return { error: response.error };
    return { people: Array.isArray(response?.people) ? response.people : [] };
  } catch (err) {
    ERR("People search failed:", err.message);
    return { error: err.message || "People search failed" };
  }
}

/** Batch-enrich picked LinkedIn profiles for the Add-from-LinkedIn flow. */
async function handleEnrichLinkedInProfiles(urls) {
  const list = Array.isArray(urls) ? urls.filter((u) => typeof u === "string" && u) : [];
  if (list.length === 0) return { error: "No URLs provided" };

  const denied = await requireLinkedInAccess();
  if (denied) return denied;

  try {
    const response = await withDeadline(
      enrichProfileUrls(list),
      150_000,
      "LinkedIn profile enrichment timed out. Try again in a moment.",
    );
    if (response?.error) return { error: response.error };
    return {
      profiles: Array.isArray(response?.profiles) ? response.profiles : [],
      failedUrls: Array.isArray(response?.failedUrls) ? response.failedUrls : [],
    };
  } catch (err) {
    ERR("Profile enrichment failed:", err.message);
    return { error: err.message || "Profile enrichment failed" };
  }
}

// ─── Profile capture ─────────────────────────────────────────────────────────

function safeLinkedInProfileUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "linkedin.com" && !url.hostname.endsWith(".linkedin.com")) return null;
    const match = url.pathname.match(/^\/in\/([^/?#]+)\/?/);
    return match ? `https://www.linkedin.com/in/${match[1]}` : null;
  } catch {
    return null;
  }
}

/** Enrich picked profiles (the open tab, search results) and write them to Airtable. */
async function handleCaptureProfiles(urls) {
  const list = [...new Set((Array.isArray(urls) ? urls : []).map(safeLinkedInProfileUrl).filter(Boolean))];
  if (list.length === 0) return { error: "No LinkedIn profile URLs to capture." };
  if (list.length > 50) return { error: "Capture at most 50 profiles at a time." };
  await armRunAlarms();
  const enriched = await handleEnrichLinkedInProfiles(list);
  if (enriched.error) return enriched;
  if (enriched.profiles.length === 0) {
    return { error: "LinkedIn didn't return any of those profiles.", failedUrls: enriched.failedUrls };
  }
  const tally = await captureProfiles(enriched.profiles);
  return {
    ok: true,
    captured: enriched.profiles.length,
    created: tally.created,
    updated: tally.updated,
    unchanged: tally.unchanged,
    failed: tally.failed + enriched.failedUrls.length,
    failedUrls: enriched.failedUrls,
    warning: tally.errors[0] || null,
    profiles: enriched.profiles.map(({ linkedinUrl, name }) => ({ linkedinUrl, name })),
  };
}

// ─── Log interaction ─────────────────────────────────────────────────────────

/**
 * One Interactions row (and a Notes row for a note) for the open profile. A
 * person not in People yet is added first, the same way Add does it.
 */
async function handleLogInteraction(message) {
  const url = safeLinkedInProfileUrl(message.url);
  if (!url) return { error: "Open a LinkedIn profile first." };
  const config = await readConfig();
  const problem = configProblem(config);
  if (problem) return { error: problem };
  const tables = interactionTables(config.baseTables, config.tableId);
  if (!tables.interactions) return { error: "This base has no Interactions table to log to. Reload columns in Settings." };
  let entry;
  try {
    entry = interactionEntry(message);
  } catch (error) {
    return { error: error.message };
  }
  const noteId = typeof message.noteId === "string" && /^rec[A-Za-z0-9]{14}$/.test(message.noteId) ? message.noteId : null;
  if (entry.note && !noteId && !tables.notes) return { error: "This base has no Notes table for the note. Reload columns in Settings." };
  try {
    let person = await findPersonRecord(url);
    let name = null;
    if (!person) {
      if (linkedInBusy()) return { error: "They aren't in People yet, and a capture is running. Try again when it's done." };
      const added = await handleCaptureProfiles([url]);
      if (added.error) return { error: added.error };
      const profile = added.profiles?.[0];
      name = profile?.name || null;
      person = await findPersonRecord(profile?.linkedinUrl || url);
      if (!person) return { error: added.warning || "Couldn't add them to People." };
    }
    const fallback = typeof message.name === "string" && message.name.trim() ? message.name.trim().slice(0, 200) : "LinkedIn member";
    const result = await logInteraction(config, {
      ...entry, personId: person.id, name: person.name || name || fallback, noteId, retry: message.retry === true,
    });
    return { ok: true, ...result };
  } catch (error) {
    ERR("Log interaction failed:", error?.message || error);
    return { error: error?.message || String(error), noteId: error?.noteId || noteId };
  }
}

// ─── Bulk enrich ─────────────────────────────────────────────────────────────

/** Why a bulk enrich can't start now, or null. */
async function bulkEnrichBlocked() {
  const denied = await requireLinkedInAccess();
  if (denied) return denied;
  const lock = await readLinkedInCaptureLock();
  const lockFresh = lock?.runId && Date.now() - Number(lock.updatedAt || 0) < LINKEDIN_CAPTURE_LOCK_MAX_AGE_MS;
  if (isCaptureRunning() || isEnrichmentRunning() || isGraphTaskRunning() || lockFresh) {
    await revealHiddenSync();
    return { error: "Another capture is running. Let it finish or stop it first." };
  }
  return null;
}

/** Start a bulk enrich over pasted URLs, or resume the stored one when `urls` is null. */
async function handleBulkEnrich(urls, options) {
  const blocked = await bulkEnrichBlocked();
  if (blocked) return blocked;
  await armRunAlarms();
  const result = urls === null ? await resumeBulkEnrich() : await startBulkEnrich(urls, options);
  if (result?.error || result?.resumed === false) await maybeDisarmRunAlarms();
  if (result?.resumed === false) return { error: "There's no stopped bulk enrich to resume." };
  return result;
}

/** Text of any cell that can hold a URL: text, url, button, lookup, rollup. */
function cellText(value) {
  if (Array.isArray(value)) return value.map(cellText).join(" ");
  if (value && typeof value === "object") return String(value.url || "");
  return value == null ? "" : String(value);
}

// Bumped by Stop, so a table still being read doesn't start its enrich afterwards.
let cancelEpoch = 0;

/** Enrich everyone whose LinkedIn URL is in `fieldId` of `tableId`, into People like any other enrich. */
async function handleEnrichFromTable(tableId, fieldId) {
  if (isBulkEnrichRunning()) return { error: "A bulk enrich is already running." };
  const blocked = await bulkEnrichBlocked();
  if (blocked) return blocked;
  const config = await readConfig();
  if (!config.token || !config.baseId) return { error: "Connect Airtable first." };
  const table = (config.baseTables || []).find((candidate) => candidate.id === tableId);
  const field = table?.fields?.find((candidate) => candidate.id === fieldId);
  if (!table || !field) return { error: "That table or column isn't in the base anymore. Reload columns and pick again." };
  const epoch = cancelEpoch;
  const records = await listRecords(config.token, config.baseId, tableId, { fieldIds: [fieldId] });
  if (epoch !== cancelEpoch) return { canceled: true };
  const urls = records.map((record) => cellText(record.fields?.[fieldId])).join("\n");
  LOG(`Enrich from ${table.name}: ${records.length} rows read`);
  return handleBulkEnrich(urls, { source: `Table: ${table.name}`, maxUrls: TABLE_MAX_URLS });
}
