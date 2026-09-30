/**
 * Soft sync: the quiet recurring LinkedIn refresh.
 *
 * Two things have to hold and neither is visible at runtime, because the whole
 * feature is designed to be unnoticeable:
 *
 *   1. The schedule matches the user's preference, and re-arming it on a
 *      worker restart must not keep pushing the next run out. Service workers
 *      restart far more often than a soft-sync period, so a blind
 *      chrome.alarms.create on every boot would mean the run never fires.
 *   2. A run only skips enrichment for people EarthOS already has. The check
 *      has to happen before the page is uploaded — after the upsert everyone
 *      exists — and any failure has to fall back to enriching, since enriching
 *      a known person is wasted work while skipping a new one loses data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_SOFT_SYNC_PREFS,
  normalizeSoftSyncPrefs,
  softSyncFirstDelayMinutes,
  softSyncPeriodMinutes,
} from "../lib/soft-sync-prefs.js";
import { bootWorker } from "./helpers/worker-harness.mjs";
import { airtableConfig } from "./helpers/fake-airtable.mjs";

const CAPTURE_SOURCE = readFileSync(
  new URL("../background/linkedin-capture.js", import.meta.url),
  "utf8",
);
const SOFT_SYNC_SOURCE = readFileSync(
  new URL("../background/soft-sync.js", import.meta.url),
  "utf8",
);
const SERVICE_WORKER_SOURCE = readFileSync(
  new URL("../background/service-worker.js", import.meta.url),
  "utf8",
);
const CAPTURE_STATE_SOURCE = readFileSync(
  new URL("../background/capture-state.js", import.meta.url),
  "utf8",
);

/** Give the shim browser a finished Airtable setup, the way the panel leaves it. */
function signIn(store) {
  store.set("airtable_config", airtableConfig());
}

test("soft sync ships on, hourly", () => {
  // Default-on is bounded by hasCompletedInitialSync rather than by the
  // preference: the schedule only ever refreshes a network the user already
  // imported, and never runs the first import unattended.
  assert.deepEqual({ ...DEFAULT_SOFT_SYNC_PREFS }, { enabled: true, timesPerDay: 24 });
  assert.equal(softSyncPeriodMinutes(DEFAULT_SOFT_SYNC_PREFS), 60);
});

test("a malformed or out-of-range preference can never arm a bad alarm", () => {
  // Missing, wrong-typed, and fractional values all fall back to the default
  // rather than producing NaN or a zero-minute period.
  for (const raw of [undefined, null, "4", {}, { timesPerDay: "many" }, { timesPerDay: 2.5 }]) {
    assert.equal(normalizeSoftSyncPrefs(raw).timesPerDay, 24, `bad input: ${JSON.stringify(raw)}`);
  }
  assert.equal(normalizeSoftSyncPrefs({ timesPerDay: 0 }).timesPerDay, 1);
  assert.equal(normalizeSoftSyncPrefs({ timesPerDay: -5 }).timesPerDay, 1);
  assert.equal(normalizeSoftSyncPrefs({ timesPerDay: 5000 }).timesPerDay, 24);
  // Only an explicit false disables it, so a malformed record falls back to the
  // documented default of on rather than silently leaving a network to go stale.
  assert.equal(normalizeSoftSyncPrefs({}).enabled, true);
  assert.equal(normalizeSoftSyncPrefs({ enabled: false }).enabled, false);
  assert.equal(normalizeSoftSyncPrefs({ enabled: "yes" }).enabled, true);
  assert.equal(normalizeSoftSyncPrefs(undefined).enabled, true);
  assert.equal(normalizeSoftSyncPrefs({ enabled: true }).enabled, true);

  assert.equal(softSyncPeriodMinutes({ timesPerDay: 1 }), 1440);
  assert.equal(softSyncPeriodMinutes({ timesPerDay: 2 }), 720);
  assert.equal(softSyncPeriodMinutes({ timesPerDay: 8 }), 180);
  assert.equal(softSyncPeriodMinutes({ timesPerDay: 24 }), 60);
});

test("re-arming an unchanged schedule leaves the pending run alone", () => {
  // chrome.alarms.create resets the countdown for an existing name, so the
  // period is compared before touching it.
  assert.match(
    SOFT_SYNC_SOURCE,
    /const existing = await chrome\.alarms\.get\(SOFT_SYNC_ALARM\)[\s\S]{0,120}if \(existing\?\.periodInMinutes === periodInMinutes\) return/,
  );
  // Disabling clears the alarm rather than leaving it firing into a no-op.
  assert.match(SOFT_SYNC_SOURCE, /if \(!normalized\.enabled\)[\s\S]{0,120}chrome\.alarms\.clear\(SOFT_SYNC_ALARM\)/);
});

test("a restart keeps the cadence of the last sync instead of starting the countdown over", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const minutesAgo = (minutes) => now - minutes * 60_000;
  // Never synced: a full period (the run is skipped until the first sync anyway).
  assert.equal(softSyncFirstDelayMinutes(60, NaN, now), 60);
  // Synced 20 minutes ago, hourly: the next run is 40 minutes out, not 60.
  assert.equal(softSyncFirstDelayMinutes(60, minutesAgo(20), now), 40);
  // Overdue (Chrome was closed): catch up soon, but not the moment it opens.
  assert.equal(softSyncFirstDelayMinutes(60, minutesAgo(300), now), 10);
  assert.equal(softSyncFirstDelayMinutes(60, minutesAgo(55), now), 10);
  // Just synced: a full period. A clock that says the sync is in the future: a full period.
  assert.equal(softSyncFirstDelayMinutes(60, now, now), 60);
  assert.equal(softSyncFirstDelayMinutes(60, now + 3_600_000, now), 60);
  // A period shorter than the catch-up never waits longer than the period.
  assert.equal(softSyncFirstDelayMinutes(5, minutesAgo(300), now), 5);
});

test("after a restart cleared the alarm, an overdue schedule is armed to catch up", async () => {
  const lastSync = new Date(Date.now() - 5 * 3_600_000).toISOString();
  const { calls, restore } = await bootWorker({ storage: {
    earthos_soft_sync_prefs: { enabled: true, timesPerDay: 24 },
    capture_results: { site: "linkedin", total: 3, completedAt: lastSync },
    earthos_initial_sync_done: lastSync,
  } });
  try {
    const armed = calls.filter(([name, [alarm]]) => name === "alarms.create" && alarm === "earthos-soft-sync");
    assert.equal(armed.length, 1);
    assert.deepEqual(armed[0][1][1], { periodInMinutes: 60, delayInMinutes: 10 });
  } finally {
    restore();
  }
});

test("a scheduled run never competes with work already in flight", () => {
  // The whole function, not a fixed slice of it: a comment added to one guard
  // used to push the last line of the function out of the window under test.
  const wholeFunction = SERVICE_WORKER_SOURCE.slice(
    SERVICE_WORKER_SOURCE.indexOf("async function runScheduledSoftSync"),
  );
  const scheduled = wholeFunction.slice(0, wholeFunction.indexOf("\n}\n") + 2);
  for (const guard of [
    /if \(!prefs\.enabled\) return/,
    /await hasPendingCaptureRetry\(\)/,
    /if \(linkedInBusy\(\)\)/,
    /readLinkedInCaptureLock\(\)/,
    /await getToken\(\)/,
    /assertLinkedInSession\(\)/,
  ]) {
    assert.match(scheduled, guard);
  }
  // The run itself goes through the same capture entry point as a manual sync,
  // in soft mode — and silently, which is now stated rather than inferred from
  // the depth, because a soft sync the user requested is not silent.
  assert.match(scheduled, /startLinkedInCapture\(runId, \{ mode: "soft", silent: true, sampleLimit: null \}\)/);
  // "Busy" covers every kind of LinkedIn work, bulk enrich and a search being captured included.
  assert.match(
    SERVICE_WORKER_SOURCE,
    /function linkedInBusy\(\) \{\s*return isCaptureRunning\(\) \|\| isEnrichmentRunning\(\) \|\| isGraphTaskRunning\(\) \|\| isBulkEnrichRunning\(\) \|\| searchCapturing;/,
  );
});

test("capture retry bookkeeping is scoped to the exact visible run", () => {
  const retry = SERVICE_WORKER_SOURCE.slice(
    SERVICE_WORKER_SOURCE.indexOf("async function scheduleCaptureRetryIfFailed"),
  ).slice(0, 1800);
  assert.match(retry, /settled\?\.kind !== "capture" \|\| settled\.silent/);
  assert.match(retry, /progress\.runId !== settled\.runId/);
  assert.match(retry, /mode: settled\.mode === "soft" \? "soft" : "full"/);
  assert.match(CAPTURE_SOURCE, /settledHook\(settledRun\)/);
  assert.match(CAPTURE_SOURCE, /settledHook\(\{ kind: "enrichment" \}\)/);
  const runDue = SERVICE_WORKER_SOURCE.slice(
    SERVICE_WORKER_SOURCE.indexOf("async function runDueCaptureRetry"),
  ).slice(0, 1800);
  assert.ok(
    !runDue.includes("nextAt: null"),
    "a worker death before capture start would strand a retry marked inactive",
  );
});

test("a requested sync is visible, defaults to full, and never downgrades an adopted run", () => {
  // The queue (and the app) may ask for either depth; an absent mode is the
  // full re-walk every existing caller has always got.
  assert.match(
    SERVICE_WORKER_SOURCE,
    /async function handleStartCapture\(site, \{ force = false, mode = "full", sampleLimit = null \} = \{\}\)/,
  );
  // A requested run always publishes progress, whatever its depth.
  assert.match(SERVICE_WORKER_SOURCE, /startLinkedInCapture\(crypto\.randomUUID\(\), \{ mode, silent: false, sampleLimit \}\)/);
  // Adopting an interrupted run: a full request upgrades it, a soft request
  // names no mode at all so it cannot strip enrichment off a live full run.
  assert.match(
    SERVICE_WORKER_SOURCE,
    /startLinkedInCapture\(lock\.runId, \{\s*\n\s*\.\.\.\(mode === "full" \? \{ mode: "full" \} : \{\}\),\s*\n\s*silent: false,\s*\n\s*sampleLimit,\s*\n\s*\}\)/,
  );
  assert.match(
    CAPTURE_SOURCE,
    /requestedMode === "full" && runtimeState\.captureMode !== "full"[\s\S]{0,180}captureUpgradeRequested = true/,
  );
  const reveal = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("async function revealCapture"),
  ).slice(0, 1800);
  const visibleRecordAt = reveal.indexOf("await updateProgress");
  const reportingEnabledAt = reveal.indexOf("runtimeState.captureSilent = false");
  assert.ok(visibleRecordAt > 0, "promoted soft sync never creates a visible progress record");
  assert.ok(
    reportingEnabledAt > visibleRecordAt,
    "promoted soft sync can publish before it owns the visible progress record",
  );
  assert.match(SERVICE_WORKER_SOURCE, /if \(await revealScheduledCapture\(mode\)\)/);
  assert.match(CAPTURE_SOURCE, /async function promoteSoftRunToFullIfRequested/);
  assert.match(
    CAPTURE_SOURCE,
    /captureUpgradeRequested = false;[\s\S]{0,300}softSync = false;[\s\S]{0,160}upgradeSoftRunToFull\(progress\)/,
  );
  assert.match(CAPTURE_SOURCE, /while \(true\) \{\s*\n\s*await promoteSoftRunToFullIfRequested\(\)/);
  // Once terminal persistence begins, an in-place upgrade is no longer safe.
  // A request in that window must queue a fresh full run instead of being
  // acknowledged against the soft result.
  assert.match(CAPTURE_SOURCE, /captureAcceptingUpgrade: false/);
  assert.match(CAPTURE_SOURCE, /captureRestartRequested = true/);
  assert.match(
    CAPTURE_SOURCE,
    /if \(restartFullCapture\)[\s\S]{0,700}startCapture\(restartRunId, \{ mode: "full", sampleLimit: null \}\)/,
  );
  const acknowledge = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("async function acknowledgeComplete"),
  ).slice(0, 3600);
  assert.match(acknowledge, /await drainPendingEnrichment\(\)/);
  assert.ok(
    acknowledge.indexOf("runtimeState.captureAcceptingUpgrade = false")
      > acknowledge.indexOf("await drainPendingEnrichment()"),
    "the terminal path closed promotion before draining the final manual request",
  );
});

test("the known-person check runs before the page is uploaded, and fails open", () => {
  const filter = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("async function filterSoftSyncNewRows"),
  ).slice(0, 1600);
  // Sends the fields the backend matches on: identity plus name + headline.
  for (const field of [/externalId:/, /memberId:/, /linkedinUrl:/, /name:/, /headline:/]) {
    assert.match(filter, field);
  }
  // A failed or mismatched response enriches the whole page rather than
  // silently skipping people who may be new.
  assert.match(filter, /if \(!known \|\| known\.length !== rows\.length\) return rows/);
  assert.match(filter, /catch \(error\)[\s\S]{0,200}return rows/);

  // The check is invoked from the upload loop before enqueueChunk, and the
  // base row still goes up for everyone so conversation metadata refreshes.
  const uploadLoop = CAPTURE_SOURCE.slice(CAPTURE_SOURCE.indexOf("async function uploadMissing"));
  const checkAt = uploadLoop.indexOf("filterSoftSyncNewRows(block.rows, sequence)");
  const uploadAt = uploadLoop.indexOf("await enqueueChunk(sequence,");
  assert.ok(checkAt > 0 && uploadAt > checkAt, "the soft-sync check must precede the chunk upload");
  assert.match(
    uploadLoop.slice(uploadAt, uploadAt + 200),
    /enqueueChunk\(sequence, rowsWithInteractionSnapshot\(block\.rows, interactionSnapshot\)\)/,
  );
  // A page where everyone is already known skips the enrichment queue.
  assert.match(uploadLoop, /if \(enrichableCount > 0\) \{\s*\n\s*markEnrichmentPending\(sequence\);/);
});

test("the known-person check takes a single pass at the engine layer", () => {
  // Airtable's client already retries rate limits and 5xx; nesting a second
  // budget on an advisory check would multiply requests against a failing API
  // only to fall back to the enrichment it would have done anyway.
  const filter = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("async function filterSoftSyncNewRows"),
  ).slice(0, 1600);
  assert.match(filter, /sendImportRequest\("SOFT_SYNC_CHECK",[\s\S]{0,400}\}, 1\)/);
});

/** Soft sync is opt-in, so a scheduled run only happens on an opted-in browser. */
const OPTED_IN = { earthos_soft_sync_prefs: { enabled: true, timesPerDay: 4 } };

test("a scheduled run on a signed-out browser stays quiet", async () => {
  const { calls, store, restore } = await bootWorker({ storage: OPTED_IN });
  try {
    const fire = calls.find(([name]) => name === "onAlarm")[1][0];
    await fire({ name: "earthos-soft-sync" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Airtable not set up: the run is abandoned before any LinkedIn traffic,
    // and — unlike a user-initiated sync — without an error the user never
    // asked to see.
    assert.equal(store.get("earthos_soft_sync_status").skipped, "unauthenticated");
    assert.equal(store.get("capture_progress"), undefined);
  } finally {
    restore();
  }
});

test("a pending visible retry owns its checkpoint ahead of the schedule", async () => {
  const checkpointRecord = { version: 2, importId: "retry-import", marker: "keep-me" };
  const storage = {
    ...OPTED_IN,
    earthos_capture_retry: {
      attempts: 1,
      nextAt: Date.now() + 60_000,
      expiresAt: Date.now() + 10 * 60_000,
      mode: "full",
    },
    earthos_li_progress: checkpointRecord,
  };
  const { fireAlarm, store, restore } = await bootWorker({ storage });
  try {
    fireAlarm("earthos-soft-sync");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(store.get("earthos_soft_sync_status").skipped, "capture_retry");
    assert.deepEqual(store.get("earthos_li_progress"), checkpointRecord);
  } finally {
    restore();
  }
});

test("a spent retry hands the schedule back instead of retiring it", async () => {
  // scheduleCaptureRetryIfFailed leaves { attempts, nextAt: null } behind once
  // the last attempt is used, and only a later visible sync that succeeds ever
  // clears it. A guard that asked whether the run had *ever* failed therefore
  // read that tombstone as "a retry is still coming" for good: every scheduled
  // run after a sync that failed three times skipped, so the schedule died for
  // precisely the user who needed it — the one whose sync did not finish.
  const storage = {
    ...OPTED_IN,
    earthos_capture_retry: { attempts: 3, nextAt: null, mode: "full" },
    capture_results: { site: "linkedin", total: 1200, completedAt: new Date().toISOString() },
  };
  const { fireAlarm, store, restore } = await bootWorker({ storage });
  try {
    signIn(store);
    fireAlarm("earthos-soft-sync");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Past the retry guard, stopping at LinkedIn: the shim browser has no
    // LinkedIn cookies, which is the last guard before any traffic.
    assert.equal(store.get("earthos_soft_sync_status").skipped, "linkedin_signed_out");
  } finally {
    restore();
  }
});

test("a retry whose window has closed no longer owns the checkpoint", async () => {
  // Same shape, one step earlier: attempts are left, but the half-hour window
  // in which they could have run has passed. Nothing will pick that checkpoint
  // up on its own, so holding the schedule off for it waits forever.
  const storage = {
    ...OPTED_IN,
    earthos_capture_retry: {
      attempts: 1,
      nextAt: Date.now() - 60 * 60_000,
      expiresAt: Date.now() - 30 * 60_000,
      mode: "full",
    },
    capture_results: { site: "linkedin", total: 1200, completedAt: new Date().toISOString() },
  };
  const { fireAlarm, store, restore } = await bootWorker({ storage });
  try {
    signIn(store);
    fireAlarm("earthos-soft-sync");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(store.get("earthos_soft_sync_status").skipped, "linkedin_signed_out");
  } finally {
    restore();
  }
});

test("changing the preference in the panel re-arms the schedule immediately", async () => {
  const { calls, store, send, restore } = await bootWorker();
  try {
    const before = calls.filter(([name]) => name === "alarms.create").length;
    const response = await send({ type: "SET_SOFT_SYNC_PREFS", prefs: { enabled: true, timesPerDay: 2 } });
    assert.deepEqual(response.prefs, { enabled: true, timesPerDay: 2 });
    assert.equal(store.get("earthos_soft_sync_prefs").timesPerDay, 2);

    const armed = calls.filter(([name]) => name === "alarms.create").slice(before);
    assert.deepEqual(armed.map(([, args]) => args[0]), ["earthos-soft-sync"]);
    assert.equal(armed[0][1][1].periodInMinutes, 720);
  } finally {
    restore();
  }
});

test("an untrusted page cannot change the soft-sync schedule", async () => {
  const { send, store, restore } = await bootWorker();
  try {
    const evil = { url: "https://evil.example/x", tab: { id: 1, url: "https://evil.example/x" } };
    const response = await send(
      { type: "SET_SOFT_SYNC_PREFS", prefs: { enabled: false, timesPerDay: 24 } },
      evil,
    );
    assert.match(response.error, /outside the extension/i);
    assert.equal(store.get("earthos_soft_sync_prefs"), undefined);
  } finally {
    restore();
  }
});

test("a browser that has never synced is left alone", async () => {
  const { calls, store, restore } = await bootWorker({ storage: OPTED_IN });
  try {
    signIn(store);
    const fire = calls.find(([name]) => name === "onAlarm")[1][0];
    await fire({ name: "earthos-soft-sync" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Nothing is known yet, so a soft sync here would not be a refresh — it
    // would run the user's entire first import unattended.
    assert.equal(store.get("earthos_soft_sync_status").skipped, "no_initial_sync");
    assert.equal(store.get("capture_progress"), undefined);

    // A capture from another network does not count as the first LinkedIn sync.
    store.set("capture_results", {
      site: "twitter",
      total: 1200,
      completedAt: new Date().toISOString(),
    });
    await fire({ name: "earthos-soft-sync" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(store.get("earthos_soft_sync_status").skipped, "no_initial_sync");

    // A successfully completed zero-contact LinkedIn import does count. The
    // schedule proceeds and stops at the next guard, LinkedIn, because the shim
    // browser has no LinkedIn cookies.
    store.set("capture_results", {
      site: "linkedin",
      total: 0,
      completedAt: new Date().toISOString(),
    });
    await fire({ name: "earthos-soft-sync" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(store.get("earthos_soft_sync_status").skipped, "linkedin_signed_out");
  } finally {
    restore();
  }
});

test("a scheduled run reports nothing to the app, including when it fails", () => {
  // The user did not ask for this sync. A progress bar they cannot explain, or
  // an error banner they cannot act on, is the whole thing the feature is
  // trying not to be.
  // Silence is now the caller's explicit choice, with soft as the fallback so
  // every pre-existing path keeps its behavior.
  assert.match(
    SERVICE_WORKER_SOURCE,
    /const silent = options\.silent === undefined \? options\.mode === "soft" : options\.silent === true;/,
  );
  assert.match(SERVICE_WORKER_SOURCE, /if \(silent\) await recordSoftSyncRun\(\{ failed: result\.error, runId \}\)/);
  assert.match(CAPTURE_SOURCE, /function sendProgress[\s\S]{0,120}if \(runtimeState\.captureSilent\) return/);
  assert.match(
    CAPTURE_SOURCE,
    /async function reportAsyncCaptureError[\s\S]{0,600}if \(runtimeState\.captureSilent\)[\s\S]{0,200}recordSoftSyncRun\(\{ failed: message, runId \}\)/,
  );
  // A sync the user starts on top of a live soft run makes it visible rather
  // than acknowledging a run with no progress behind it.
  assert.match(SERVICE_WORKER_SOURCE, /if \(await revealScheduledCapture\(mode\)\)/);

  // Completion still has to be recorded. Both guards in reportImportCompleted
  // read the visible progress record, which for a silent run belongs to some
  // earlier run — left alone they read every completion as superseded and fail
  // the run at the finish line.
  assert.match(
    CAPTURE_SOURCE,
    /const terminalIsSilent = runtimeState\.captureSilent \|\| runtimeState\.captureRestartRequested[\s\S]{0,120}reportImportCompleted\(summary, \{ silent: terminalIsSilent \}\)/,
  );
  const completed = CAPTURE_STATE_SOURCE.slice(
    CAPTURE_STATE_SOURCE.indexOf("export async function reportImportCompleted"),
  ).slice(0, 1400);
  assert.match(completed, /const currentProgress = silent \? null : await readCaptureProgress\(\)/);
  assert.match(completed, /if \(!silent\)[\s\S]{0,320}ignored: "superseded"/);
  // capture_results is written either way: a soft sync is a real sync, and it
  // is what "last synced" and the initial-sync gate read.
  assert.match(completed, /await chrome\.storage\.local\.set\(\{\s*capture_results: compact,[\s\S]{0,300}\}\);\s*\n\s*if \(!silent\)/);
  assert.match(CAPTURE_SOURCE, /recordSoftSyncRun\(\{[\s\S]{0,180}completed: true/);

  // A worker death mid-run must not turn a scheduled run into a visible one.
  // The whole function, up to the next top-level declaration.
  const resumeStart = SERVICE_WORKER_SOURCE.indexOf("async function resumeInterruptedCapture");
  const resume = SERVICE_WORKER_SOURCE.slice(resumeStart, SERVICE_WORKER_SOURCE.indexOf("\n}\n", resumeStart) + 2);
  assert.match(resume, /const soft = await isSoftSyncCheckpoint\(\)/);
  // Depth and visibility resume independently: the run keeps the depth its
  // checkpoint recorded, and stays quiet only if it started quiet. A soft sync
  // the user asked for must not be silenced by a worker restart.
  assert.match(resume, /const silent = await isSilentCaptureCheckpoint\(\)/);
  assert.match(
    resume,
    /startCapture\(lock\.runId, \{ \.\.\.\(soft \? \{ mode: "soft" \} : \{\}\), silent \}\)/,
  );
  assert.equal((resume.match(/if \(silent\) \{\s*\n\s*await recordSoftSyncRun/g) || []).length, 2);
});

test("a requested soft sync is visible, unlike the scheduled one it shares a depth with", () => {
  // The distinction has to survive both a worker restart and an old
  // checkpoint, so it is persisted with the run and defaults to the prior rule.
  assert.match(CAPTURE_SOURCE, /silent: progress\.silent === true,/);
  assert.match(
    CAPTURE_SOURCE,
    /progress\.silent = progress\.silent === undefined\s*\n\s*\? progress\.softSync === true\s*\n\s*: progress\.silent === true;/,
  );
  assert.match(
    CAPTURE_SOURCE,
    /runtimeState\.captureSilent = options\.silent === undefined\s*\n\s*\? options\.mode === "soft"\s*\n\s*: options\.silent === true;/,
  );
  const checkpoint = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("async function isSilentCheckpoint"),
  ).slice(0, 500);
  assert.match(checkpoint, /record\?\.silent === undefined \? record\?\.softSync === true : record\.silent === true/);

  // Joining a scheduled soft run must change visibility, not depth. The old
  // reveal path promoted every user request to full, including mode=soft.
  const reveal = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("async function revealCapture"),
  ).slice(0, 1800);
  assert.match(reveal, /requestedMode === "full"/);
  assert.ok(
    !/requestedMode === "soft"[\s\S]{0,120}captureUpgradeRequested = true/.test(reveal),
    "a requested soft sync must not promote a scheduled soft run to full",
  );
});

test("a full request upgrades an already-visible soft task instead of only acknowledging it", () => {
  const reveal = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("async function revealCapture"),
  ).slice(0, 1800);
  // The depth request is handled before the visibility early-return, so the
  // durable task pump cannot mark a full request complete against a live soft
  // walk that was already visible.
  assert.ok(
    reveal.indexOf('requestedMode === "full"') < reveal.indexOf("if (!runtimeState.captureSilent) return true"),
  );
  assert.match(reveal, /captureMode !== "full"/);
  assert.match(CAPTURE_SOURCE, /runtimeState\.captureMode = softSync \? "soft" : "full"/);
  assert.match(CAPTURE_SOURCE, /runtimeState\.captureMode = "full"/);
});

test("upgrading a soft run to a full one re-queues what soft mode skipped", () => {
  const upgrade = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("function upgradeSoftRunToFull"),
  ).slice(0, 900);
  // Pages whose people were all known never entered the enrichment queue, and
  // their base chunks are already durable — so the upload loop skips those
  // sequences and nothing would ever revisit them.
  assert.match(upgrade, /for \(let sequence = 0; sequence < uploaded; sequence\+\+\) pending\.add\(sequence\)/);
  // Batch cursors index the soft-filtered arrays; replaying one against a full
  // page skips whole batches of people.
  assert.match(upgrade, /progress\.enrichmentBatchCursors = \{\}/);
  assert.match(upgrade, /progress\.softSyncNewKeys = \{\}/);
  // Re-queued pages need idempotency keys the backend has not already
  // completed, or uploadEnrichmentBatch replays them and uploads nothing.
  assert.match(upgrade, /progress\.enrichmentGeneration = .*\+ 1/);
  assert.match(
    CAPTURE_SOURCE,
    /clientImportKey: peopleImportKeyForRun\(\s*\n\s*enrichmentBatchKey\(progress, sequence, batchIndex\),\s*\n\s*runId,\s*\n\s*\)/,
  );
  assert.match(CAPTURE_SOURCE, /let upgradedFromSoft = wasSoftSync && !softSync/);
  assert.match(CAPTURE_SOURCE, /if \(upgradedFromSoft\) upgradeSoftRunToFull\(progress\)/);
  assert.match(CAPTURE_SOURCE, /for \(const sequence of Array\.isArray\(status\.receivedSequences\)/);
  assert.match(CAPTURE_SOURCE, /promoteSoftRunToFullIfRequested/);
  // Generation 0 keeps the original key shape so a run interrupted before this
  // existed resumes under exactly the keys its earlier batches used.
  assert.match(CAPTURE_SOURCE, /return generation > 0 \? `\$\{key\}-g\$\{generation\}` : key/);
  // The generation has to survive the checkpoint whitelist, or every restart
  // resets it and the re-uploads go back to being deduplicated as replays.
  const saveProgress = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("async function saveProgress"),
  ).slice(0, 4000);
  assert.match(saveProgress, /enrichmentGeneration:/);
});

test("the new-person set survives a worker restart mid-run", () => {
  // The enrichment pass re-fetches the page, so the decision has to be carried
  // by durable keys rather than object identity.
  assert.match(CAPTURE_SOURCE, /softSyncNewKeys: \{\}/);
  assert.match(CAPTURE_SOURCE, /function softRowKey\(row\)/);
  // saveProgress whitelists every persisted field; both soft-sync keys are in it.
  const saveProgress = CAPTURE_SOURCE.slice(
    CAPTURE_SOURCE.indexOf("async function saveProgress"),
  ).slice(0, 4000);
  assert.match(saveProgress, /softSync: progress\.softSync === true/);
  assert.match(saveProgress, /softSyncNewKeys: Object\.fromEntries/);
});
