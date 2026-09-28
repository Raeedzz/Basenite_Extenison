/**
 * Connection health: never let a background sync fail quietly.
 *
 * Two things have to hold for a sync to land anywhere:
 *
 *   1. Airtable is connected, with a table and a LinkedIn URL column mapped.
 *   2. The browser holds a LinkedIn session. No tab is opened, so a signed-out
 *      LinkedIn produces no visible symptom until a sync fails.
 *
 * The watchdog probes both and publishes one `earthos_connection_health`
 * record the side panel reads. Transitions into a bad state raise a badge and
 * a single notification — once per transition, never on every check.
 */

import { configProblem, readConfig } from "../lib/airtable-sink.js";
import {
  probeLinkedInSession,
  readLinkedInSessionState,
} from "../lib/linkedin-session.js";

const LOG = (...args) => console.log("[EarthOS:Heart:BG]", ...args);
const ERR = (...args) => console.error("[EarthOS:Heart:BG]", ...args);

export const SESSION_WATCHDOG_ALARM = "earthos-session-watchdog";
export const CONNECTION_HEALTH_KEY = "earthos_connection_health";

const WATCHDOG_PERIOD_MINUTES = 30;
// LinkedIn is only re-probed this often outside of an explicit request; the
// probe is a real request to Voyager and should stay rare.
const LINKEDIN_PROBE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * `soon` (browser start, install) also checks a minute from now. Any other
 * worker start only makes sure the alarm exists: re-creating it there would
 * push it a minute out on every wake, and the worker would never rest.
 */
export async function armSessionWatchdog({ soon = false } = {}) {
  if (!chrome.alarms?.create) return;
  if (!soon && await chrome.alarms.get?.(SESSION_WATCHDOG_ALARM)) return;
  await chrome.alarms.create(SESSION_WATCHDOG_ALARM, {
    periodInMinutes: WATCHDOG_PERIOD_MINUTES,
    // Fire soon after a worker start too, so a session broken while the browser
    // was closed is reported without waiting out a full period.
    delayInMinutes: 1,
  });
}

export async function readConnectionHealth() {
  const stored = await chrome.storage.local.get(CONNECTION_HEALTH_KEY);
  return stored[CONNECTION_HEALTH_KEY] || null;
}

function describeAirtable(config) {
  const problem = configProblem(config);
  return problem ? { state: "disconnected", message: problem } : { state: "ok", message: null };
}

function describeLinkedIn(state) {
  if (state?.connected === true) return { state: "ok", message: null };
  if (state?.connected === false) {
    if (state.reason === "rate_limited") {
      return {
        state: "degraded",
        message: "LinkedIn is rate limiting this browser. Syncs will resume automatically.",
      };
    }
    if (state.reason === "missing_permission") {
      return {
        state: "disconnected",
        message: "The extension needs to be reloaded to read your LinkedIn session.",
      };
    }
    return {
      state: "disconnected",
      message: "You're signed out of LinkedIn. Open linkedin.com and sign in — syncs can't run without it.",
    };
  }
  // null / unknown: never reported as a failure.
  return { state: "unknown", message: null };
}

async function setBadge(health) {
  if (!chrome.action?.setBadgeText) return;
  const bad = health.state === "disconnected";
  const warn = health.state === "degraded";
  try {
    await chrome.action.setBadgeText({ text: bad ? "!" : warn ? "•" : "" });
    if (bad || warn) {
      await chrome.action.setBadgeBackgroundColor({ color: bad ? "#dc2626" : "#d97706" });
    }
    await chrome.action.setTitle({
      title: health.message ? `Basanite Capital — ${health.message}` : "Basanite Capital",
    });
  } catch (error) {
    // Badge failures are cosmetic; never let them break a health check.
  }
}

async function notifyOnce(key, title, message) {
  if (!chrome.notifications?.create) return false;
  try {
    await chrome.notifications.create(`earthos-health-${key}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title,
      message,
      priority: 2,
    });
    return true;
  } catch (error) {
    ERR("Health notification failed:", error?.message || error);
    return false;
  }
}

/**
 * Run one health pass.
 *
 * `probeLinkedIn` forces a live Voyager call; otherwise a recent cached result
 * is reused. Returns the published health record.
 */
export async function runSessionHealthCheck({ reason = "watchdog", probeLinkedIn = false } = {}) {
  const config = await readConfig();
  const airtable = describeAirtable(config);

  let linkedinState = await readLinkedInSessionState();
  const stale = !linkedinState.checkedAt
    || Date.now() - linkedinState.checkedAt > LINKEDIN_PROBE_MAX_AGE_MS;
  // Probing LinkedIn only matters once there is somewhere to sync into.
  if (airtable.state === "ok" && (probeLinkedIn || stale)) {
    linkedinState = await probeLinkedInSession().catch(() => linkedinState);
  }
  const linkedin = describeLinkedIn(linkedinState);

  const worst = airtable.state !== "ok" ? airtable : linkedin;
  const health = {
    state: worst.state === "unknown" ? "ok" : worst.state,
    message: worst.message,
    airtable: { ...airtable, connected: airtable.state === "ok" },
    linkedin: { ...linkedin, connected: linkedinState.connected ?? null, reason: linkedinState.reason || null },
    checkedAt: Date.now(),
    reason,
  };

  const previous = await readConnectionHealth();
  await chrome.storage.local.set({ [CONNECTION_HEALTH_KEY]: health });
  await setBadge(health);

  // Only LinkedIn sign-outs notify: an unconfigured Airtable is the panel's
  // first screen, not news.
  const transitioned = previous?.state !== health.state;
  if (transitioned && health.message && health.state === "disconnected" && airtable.state === "ok") {
    await notifyOnce(health.state, "LinkedIn sync is paused", health.message);
    LOG(`Connection health: ${previous?.state || "unknown"} → ${health.state} (${health.message})`);
  } else if (transitioned) {
    LOG(`Connection health: ${previous?.state || "unknown"} → ${health.state}`);
  }

  return health;
}

/**
 * Called when a LinkedIn flow fails with an auth-shaped error, so the failure
 * is reflected in the health record immediately instead of at the next
 * scheduled check.
 */
export async function reportLinkedInAuthFailure() {
  await probeLinkedInSession().catch(() => null);
  return runSessionHealthCheck({ reason: "linkedin_auth_failure" });
}
