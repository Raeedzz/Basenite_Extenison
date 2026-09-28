/**
 * Soft sync: a quiet, recurring LinkedIn sync that keeps the Airtable table
 * fresh without the cost of a full re-enrichment.
 *
 * Each run re-walks the connection list and messaging metadata exactly like a
 * manual sync, so new connections and conversation activity reach Airtable —
 * but people who already have a row are skipped by the per-profile enrichment
 * pass (the expensive part). Only genuinely new connections get the full
 * profile capture. Cells whose value did not change cost no Airtable request.
 *
 * A scheduled run is invisible: it publishes no capture progress and raises no
 * error banner, because the user never asked for it. Its outcome — skipped,
 * started, failed — goes to the status record this module owns. It also only
 * runs once the browser has finished a sync at least once, so the very first
 * import of a network is never the unattended one.
 *
 * The schedule is a single chrome.alarms entry, armed while the preference is
 * on and cleared the moment it goes off. The preference (on/off + runs per
 * day) is set in the side panel and lives in chrome.storage.
 */

import {
  DEFAULT_SOFT_SYNC_PREFS,
  normalizeSoftSyncPrefs,
  softSyncFirstDelayMinutes,
  softSyncPeriodMinutes,
} from "../lib/soft-sync-prefs.js";


export const SOFT_SYNC_ALARM = "earthos-soft-sync";
const PREFS_KEY = "earthos_soft_sync_prefs";
const STATUS_KEY = "earthos_soft_sync_status";

export async function readSoftSyncPrefs() {
  const stored = await chrome.storage.local.get(PREFS_KEY);
  return normalizeSoftSyncPrefs(stored[PREFS_KEY] ?? DEFAULT_SOFT_SYNC_PREFS);
}

/**
 * Persist a (partial) preference update and bring the alarm in line with it.
 * Returns the normalized record that was stored.
 */
export async function writeSoftSyncPrefs(patch) {
  const current = await readSoftSyncPrefs();
  const next = normalizeSoftSyncPrefs({ ...current, ...(patch && typeof patch === "object" ? patch : {}) });
  await chrome.storage.local.set({ [PREFS_KEY]: { ...next, updatedAt: Date.now() } });
  await armSoftSyncAlarm(next);
  return next;
}

/**
 * Arm (or clear) the schedule for the given preferences. The alarm is only
 * re-created when its period actually changed: chrome.alarms.create with an
 * existing name resets the countdown, and service workers restart far more
 * often than a soft-sync period, so blind re-arming would keep pushing the
 * next run out indefinitely.
 */
export async function armSoftSyncAlarm(prefs) {
  if (!chrome.alarms?.create) return;
  const normalized = normalizeSoftSyncPrefs(prefs ?? await readSoftSyncPrefs());
  if (!normalized.enabled) {
    await chrome.alarms.clear(SOFT_SYNC_ALARM).catch(() => {});
    return;
  }
  const periodInMinutes = softSyncPeriodMinutes(normalized);
  const existing = await chrome.alarms.get(SOFT_SYNC_ALARM).catch(() => null);
  if (existing?.periodInMinutes === periodInMinutes) return;
  await chrome.alarms.create(SOFT_SYNC_ALARM, {
    periodInMinutes,
    // A period after the last real sync, so a restart (which can clear alarms)
    // doesn't reset the countdown; an overdue one catches up a few minutes in.
    delayInMinutes: softSyncFirstDelayMinutes(periodInMinutes, await lastRealSyncAt()),
  });
}

/** When the last non-test LinkedIn sync finished, manual or scheduled; NaN if never. */
async function lastRealSyncAt() {
  const stored = await chrome.storage.local.get(["capture_results", "earthos_initial_sync_done"]).catch(() => ({}));
  const result = stored?.capture_results;
  const latest = result?.site === "linkedin" && result.sample !== true
    ? Date.parse(result.completedAt) || Number(result.timestamp)
    : NaN;
  const durable = Date.parse(stored?.earthos_initial_sync_done);
  return Math.max(Number.isFinite(latest) ? latest : -Infinity, Number.isFinite(durable) ? durable : -Infinity);
}

/** Make sure the alarm matches the stored preference (extension updates clear alarms). */
export async function ensureSoftSyncAlarm() {
  const prefs = await readSoftSyncPrefs();
  await armSoftSyncAlarm(prefs);
  return prefs;
}

/**
 * Has this browser ever finished a LinkedIn sync?
 *
 * Soft sync is a *refresh*: it assumes a network is already there and only
 * pays for what changed. Left ungated it would instead run the very first
 * import of a user's entire network unattended — every page walked and every
 * profile enriched, since nothing is known yet — hours after install and with
 * nothing on screen to explain the LinkedIn traffic. `capture_results` is
 * written when an import completes, so its absence means the user has never
 * run a sync here and the first one stays theirs to start.
 */
export async function hasCompletedInitialSync() {
  const stored = await chrome.storage.local.get(["capture_results", "earthos_initial_sync_done"]).catch(() => ({}));
  // Once a real sync has finished, a later test sync can't undo that.
  if (stored?.earthos_initial_sync_done) return true;
  const result = stored?.capture_results;
  if (!result || result.site !== "linkedin") return false;
  // A test sync proves the setup, not that the user chose to import their
  // network; the first full walk stays theirs to start.
  if (result.sample === true) return false;
  // A successful zero-contact import still establishes that the user chose to
  // run their first LinkedIn sync. Requiring total > 0 would leave that browser
  // permanently in "no initial sync" even after connections are added later.
  return Boolean(
    result.importId
    || result.completedAt
    || (Number.isFinite(Number(result.timestamp)) && Number(result.timestamp) > 0),
  );
}

/** Record when a scheduled run last started/skipped/failed, for debugging. */
export async function recordSoftSyncRun(outcome) {
  await chrome.storage.local.set({
    [STATUS_KEY]: { ...outcome, at: Date.now() },
  }).catch(() => {});
}
