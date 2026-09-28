/**
 * The words a running sync uses, in one place.
 *
 * A sync used to narrate itself in the units its own loops happen to use:
 * "Loading contacts 200–300..." is a row-offset window into a paged API, and
 * the enrichment pass printed that same window clamped to the end of the
 * network, so an account with exactly 200 connections watched it count
 * "Enriching contacts 200–200...". Two numbers, neither of them the one the
 * person watching wants — how much of their sync is left — and the panel's own
 * bar underneath them counting something else again.
 *
 * So every user-visible sentence about a live run is built here, from the
 * stage it is in, the person it is on, and that stage's own numerator and
 * denominator — and it always ends with what is still to go. The extension
 * panel and the capture engine import this directly.
 *
 * The web app deliberately reads differently: frontend/lib/capture-readout.ts
 * turns the same record into one weighted "Sync progress 44%", because a pill
 * in a sidebar has room for a number and not for a sentence.
 */

/** A count, grouped for reading: 1240 → "1,240". */
export function formatCount(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString();
}

/**
 * How many units of this stage are still to do, or null when nobody has said
 * how many there are. Zero is a real answer — "none left" — and must never be
 * confused with an unknown total, which is why this is null and not 0.
 */
export function remainingCount(current, total) {
  const totalValue = Math.max(0, Math.round(Number(total) || 0));
  if (totalValue <= 0) return null;
  const currentValue = Math.max(0, Math.round(Number(current) || 0));
  return Math.max(0, totalValue - Math.min(currentValue, totalValue));
}

/** 0–100, or null for a stage that reports no total — a sweep, not a fill. */
export function percentComplete(current, total) {
  const totalValue = Math.max(0, Math.round(Number(total) || 0));
  if (totalValue <= 0) return null;
  const currentValue = Math.max(0, Math.round(Number(current) || 0));
  return Math.max(0, Math.min(100, Math.round((Math.min(currentValue, totalValue) / totalValue) * 100)));
}

/** "1,240 of 3,000", or "1,240 so far" while the total is unknown. */
export function positionPhrase(current, total) {
  const remaining = remainingCount(current, total);
  if (remaining === null) return `${formatCount(current)} so far`;
  const totalValue = Math.max(0, Math.round(Number(total) || 0));
  const currentValue = Math.min(Math.max(0, Math.round(Number(current) || 0)), totalValue);
  return `${formatCount(currentValue)} of ${formatCount(totalValue)}`;
}

/**
 * The line above the bar in the panel: "76% · 64 left".
 *
 * The sentence above it already says where the stage is in words, so this adds
 * the fraction of the bar the eye cannot measure — and repeats the remainder,
 * which is the number people are actually waiting on.
 */
export function progressLabel(current, total) {
  const remaining = remainingCount(current, total);
  // Nothing counted and no total: a stage that has only just been entered has
  // nothing true to put here, and "0 of 0" is not nothing — it reads as done.
  if (remaining === null && !(Number(current) > 0)) return "";
  if (remaining === null) return `${formatCount(current)} so far · total unknown`;
  return `${percentComplete(current, total)}% · ${formatCount(remaining)} left`;
}

/** "45s", "2 min" — a wait, at the precision a person actually reads. */
export function formatWait(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (value < 60) return `${value}s`;
  // Nearest minute: 61s reads "1 min", not "2 min". Never "0 min".
  return `${Math.max(1, Math.round(value / 60))} min`;
}

/**
 * The stage name, in the words both surfaces use.
 *
 * Short enough for the panel's uppercase status line, specific enough that
 * nobody has to guess which of a sync's three passes is running.
 */
export function stageHeadline(phase, site = "LinkedIn") {
  switch (phase) {
    case "starting": return `Starting ${site} sync`;
    case "capturing": return `Reading ${site} connections`;
    case "saving": return "Saving contacts";
    case "enriching": return "Adding profile details";
    case "complete": return "Sync complete";
    case "error": return "Sync failed";
    case "canceled": return "Sync stopped";
    default: return `Syncing ${site}`;
  }
}

/**
 * The sentence the panel shows under the stage name, and the one the app shows
 * on hover: where this stage is, and what is still ahead of it.
 *
 * `updated` is the number of people the profile pass actually wrote, which is
 * a different question from how far through the list it is — a soft sync walks
 * every contact and updates only the ones that changed, and reporting only the
 * second number is what made a soft sync look like it had barely started.
 */
export function stageMessage(phase, {
  current = 0,
  total = 0,
  site = "LinkedIn",
  soft = false,
  updated = null,
  who = "",
} = {}) {
  const remaining = remainingCount(current, total);
  const toGo = remaining === null ? "" : ` · ${formatCount(remaining)} to go`;
  const position = positionPhrase(current, total);
  switch (phase) {
    case "starting":
      return `Asking ${site} how many connections you have…`;
    case "capturing":
      return remaining === null
        ? `Read ${formatCount(current)} connections so far · ${site} has not said how many there are`
        : `Read ${position} connections${toGo}`;
    case "saving":
      return remaining === null
        ? `Saved ${formatCount(current)} contacts so far`
        : `Saved ${position} contacts${toGo}`;
    case "enriching": {
      const written = Number.isFinite(Number(updated))
        ? ` · ${formatCount(updated)} updated`
        : "";
      // The person the pass is on. "Who is it actually syncing right now" is
      // the question a profile walk raises and a count alone cannot answer —
      // it is also the proof it is moving when the count sits still through a
      // batch.
      //
      // A name takes the room the verb was using: the panel clamps this to two
      // lines at 230px, and "Marcus Lindqvist · Checked 1,240 of 1,367 contacts
      // for changes · 127 to go · 12 updated" loses its tail there. The stage
      // name directly above already says what is being done, so with a name in
      // front the sentence keeps only what that headline cannot say.
      const name = String(who || "").trim();
      if (name) {
        // The rewrite count belongs to a soft sync, where "walked" and
        // "changed" are different numbers; a full run rewrites everyone it
        // walks, so printing it there is the same number twice.
        const rewrites = soft ? written : "";
        return remaining === null
          ? `${name} · ${formatCount(current)} so far${rewrites}`
          : `${name} · ${position}${toGo}${rewrites}`;
      }
      if (soft) {
        return remaining === null
          ? `Checked ${formatCount(current)} contacts for changes${written}`
          : `Checked ${position} contacts for changes${toGo}${written}`;
      }
      return remaining === null
        ? `Added full profiles for ${formatCount(current)} contacts`
        : `Full profiles for ${position} contacts${toGo}`;
    }
    case "complete":
      return `Synced ${formatCount(total || current)} contacts`;
    default:
      return "";
  }
}

/**
 * A pause, said plainly: why it stopped, when it picks back up, and how much
 * is still to come. A wait that names no end and no remainder is the single
 * most alarming thing a sync can print, and it prints them often — LinkedIn
 * paces every large capture.
 */
export function waitMessage(reason, { seconds = 0, current = 0, total = 0 } = {}) {
  const remaining = remainingCount(current, total);
  const left = remaining === null ? "" : ` · ${formatCount(remaining)} left`;
  const wait = formatWait(seconds);
  switch (reason) {
    case "rate_limited":
      return `Paused ${wait} — LinkedIn asked us to slow down${left}`;
    case "offline":
      return `Connection lost — retrying in ${wait}${left}`;
    case "cooldown":
    default:
      return `Paused ${wait} — pacing requests to stay under LinkedIn's limits${left}`;
  }
}

/** "just now", "6 min ago", "2 hours ago", "3 days ago". */
export function relativeTime(timestamp, now = Date.now()) {
  const at = Number(timestamp) || 0;
  if (at <= 0) return "";
  const elapsed = Math.max(0, now - at);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}


/**
 * How long a scheduled run's "started" record still means "running". A run
 * whose worker died leaves one standing, and the resume path takes six hours
 * to give up on such a run, so this waits exactly as long rather than
 * inventing its own idea of abandoned.
 */
const AUTO_SYNC_RUNNING_MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * The schedule's own last word, for the two things a "last sync" time cannot
 * say: a run walking right now — a scheduled sync publishes no progress, so
 * the panel sits on "Ready to sync" while it works — and one that ended badly,
 * since a run the user never asked for deliberately raises no banner.
 *
 * Everything else the status record holds is left out on purpose. A tick
 * skipped because a sync was already running resolves itself two hours later,
 * and the ones that do not (signed out of either service, a browser that has
 * never synced) are already said louder elsewhere in the panel.
 */
function autoSyncPhrase(status, { lastSyncAt = 0, now = Date.now() } = {}) {
  const at = Number(status?.at) || 0;
  // Older than the sync named beside it: that time already accounts for this.
  if (!at || at <= lastSyncAt) return "";
  if (status.started) {
    return now - at < AUTO_SYNC_RUNNING_MAX_AGE_MS ? "Auto-sync running" : "";
  }
  if (status.failed) return `Auto-sync failed ${relativeTime(at, now)}`;
  return "";
}

/**
 * The panel's idle line: when this network last synced, whose doing that was,
 * and what the schedule is up to now.
 *
 * Authorship is the point. A scheduled run writes the same `capture_results` a
 * manual one does, so "Last sync 20 min ago" reads identically whether the
 * background sync is working or has not fired in a week — which is exactly the
 * question the line is asked, and the only way to answer it was to open the
 * service worker console.
 */
export function syncHistoryDetail({
  lastSyncAt = 0,
  scheduled = false,
  status = null,
  prefs = null,
  now = Date.now(),
} = {}) {
  const when = lastSyncAt
    ? `${scheduled ? "Last auto-sync" : "Last sync"} ${relativeTime(lastSyncAt, now)}`
    : "Never synced";
  // What the schedule is doing and how often it is meant to: the same subject,
  // and the panel clamps this to two lines at 230px. The more specific wins.
  const schedule = autoSyncPhrase(status, { lastSyncAt, now })
    || (prefs ? scheduleLabel(prefs) : "");
  return [when, schedule].filter(Boolean).join(" · ");
}

/**
 * What the schedule is doing, for the panel's idle line. "Is the background
 * sync actually running?" is otherwise only answerable by reading extension
 * storage, which is not a thing to ask of anyone.
 */
export function scheduleLabel({ enabled = true, timesPerDay = 24 } = {}) {
  if (!enabled) return "Auto-sync off";
  const times = Math.max(1, Math.round(Number(timesPerDay) || 0));
  if (times === 1) return "Auto-syncs daily";
  if (times >= 24) return "Auto-syncs hourly";
  const hours = Math.round(24 / times);
  return hours <= 1 ? "Auto-syncs hourly" : `Auto-syncs every ${hours}h`;
}
