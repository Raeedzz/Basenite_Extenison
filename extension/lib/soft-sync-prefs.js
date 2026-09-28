/**
 * Soft-sync preference normalization, kept pure so the schedule math is unit
 * testable. The preference lives in chrome.storage (set from the side panel)
 * and passes through this normalizer so a malformed record can never arm a
 * bad alarm.
 */

export const SOFT_SYNC_DEFAULT_TIMES_PER_DAY = 12;
export const SOFT_SYNC_MIN_TIMES_PER_DAY = 1;
export const SOFT_SYNC_MAX_TIMES_PER_DAY = 24;

/**
 * On by default, twelve times a day, and switchable off at any time.
 *
 * Keeping a network warm is a freshness problem: warmth is derived from how
 * relationship state *changes* between observations, and a signal like a job
 * change is only worth acting on for a couple of weeks. A sync that runs a few
 * times a day sees those changes while they are still current; one that runs
 * when the user remembers to press a button does not, and the daily nudges are
 * only as good as the freshness underneath them. Twelve runs a day is a
 * two-hourly cadence — enough that nothing is stale, cheap enough that each run
 * finds almost nothing to do, because unchanged people cost no Airtable writes.
 *
 * Two guarantees make default-on defensible, and both are load-bearing:
 *
 *  • It never runs in a browser that has not already completed a sync the user
 *    started themselves (hasCompletedInitialSync in background/soft-sync.js).
 *    So the unattended path only ever *refreshes* a network the user chose to
 *    import; it never performs the first import.
 *  • Turning it off in the side panel clears the alarm immediately.
 *
 * A malformed or absent record therefore reads as *enabled*, matching the
 * documented default.
 */
export const DEFAULT_SOFT_SYNC_PREFS = Object.freeze({
  enabled: true,
  timesPerDay: SOFT_SYNC_DEFAULT_TIMES_PER_DAY,
});

export function normalizeSoftSyncPrefs(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const times = Number(source.timesPerDay);
  return {
    // `!== false`: only an explicit opt-out disarms the schedule. Anything
    // missing or malformed falls back to the documented default of on.
    enabled: source.enabled !== false,
    timesPerDay: Number.isInteger(times)
      ? Math.max(SOFT_SYNC_MIN_TIMES_PER_DAY, Math.min(SOFT_SYNC_MAX_TIMES_PER_DAY, times))
      : SOFT_SYNC_DEFAULT_TIMES_PER_DAY,
  };
}

/** Alarm period for a normalized preference record, in whole minutes. */
export function softSyncPeriodMinutes(prefs) {
  const { timesPerDay } = normalizeSoftSyncPrefs(prefs);
  return Math.max(1, Math.round((24 * 60) / timesPerDay));
}
