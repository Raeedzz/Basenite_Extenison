/**
 * Boot the real service worker under a chrome shim.
 */

export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

/** The only sender the worker takes commands from: its own side panel. */
export const PANEL_SENDER = {
  id: EXTENSION_ID,
  url: `chrome-extension://${EXTENSION_ID}/popup/popup.html`,
};

export function chromeShim() {
  const calls = [];
  const store = new Map();
  /**
   * Every value ever written, in order, per key.
   *
   * `store` only ever holds the latest one, which makes a test that polls it a
   * race against the worker: by the time the poll is scheduled the checkpoint
   * it wanted to read may have been written over twice. A test about what the
   * worker wrote FIRST reads this instead.
   */
  const writes = new Map();
  const record = (name) => (...args) => { calls.push([name, args]); return Promise.resolve(); };

  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      getManifest: () => ({ version: "2.0.0" }),
      getURL: (path) => `chrome-extension://${EXTENSION_ID}/${path}`,
      onMessage: { addListener: record("onMessage") },
      onStartup: { addListener: record("onStartup") },
      onInstalled: { addListener: record("onInstalled") },
    },
    storage: {
      local: {
        async get(keys) {
          // null reads everything, as in Chrome.
          if (keys === null) return Object.fromEntries(store);
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map((key) => [key, store.get(key)]));
        },
        async set(next) {
          for (const [key, value] of Object.entries(next)) {
            store.set(key, value);
            if (!writes.has(key)) writes.set(key, []);
            writes.get(key).push(value);
          }
        },
        async remove(keys) { for (const key of [].concat(keys)) store.delete(key); },
      },
      onChanged: { addListener: record("storageChanged") },
    },
    alarms: {
      create: record("alarms.create"),
      clear: async () => true,
      get: async () => null,
      onAlarm: { addListener: record("onAlarm") },
    },
    tabs: { query: async () => [], create: record("tabs.create"), onUpdated: { addListener: record("tabs.onUpdated") } },
    sidePanel: { setPanelBehavior: async () => {} },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    // No LinkedIn cookies: the shim browser is signed out. bootWorker({ cookies })
    // hands a signed-in jar to the tests that need one.
    cookies: { get: async () => null },
    notifications: { create: async () => "id" },
    declarativeNetRequest: { updateSessionRules: record("dnr.updateSessionRules") },
  };
  return { chrome, calls, store, writes };
}

/**
 * Boot the service worker against a shim browser.
 *
 * `storage` seeds chrome.storage.local *before* the worker's top-level code
 * runs, which is the only way to exercise the boot path of anything that reads
 * a stored preference on spin-up (soft sync arms its alarm there).
 */
/**
 * The boot before this one, kept so it can be stopped before the next starts.
 *
 * A capture outlives the test that started it: the run loop is a chain of
 * awaits, and the worker reads `chrome` off the global every time it touches
 * storage. `restore()` puts the global back but does not end the run — so the
 * moment the next test boots, the old run's checkpoints land in the NEW test's
 * storage. That is how a test about a throttle from moments ago came to read
 * the reset pace of the hour-old one before it: the two runs share a runId and
 * an importId, and the checkpoints are indistinguishable.
 */
let lastBoot = null;

async function stopLastBoot() {
  const previous = lastBoot;
  lastBoot = null;
  if (!previous) return;
  // Cancelled under its own globals, so the cancel reaches the run's own
  // storage and fetches rather than whatever is installed now.
  const priorChrome = globalThis.chrome;
  const priorFetch = globalThis.fetch;
  globalThis.chrome = previous.chrome;
  globalThis.fetch = previous.fetch;
  try {
    await previous.send({ type: "CANCEL_SYNC" });
  } catch {
    // A worker that never started a run has nothing to cancel.
  }
  // The engine module is shared between boots here, unlike a real killed
  // worker: wait for the stopped run to actually end, or the next boot sees it
  // still "running" and declines to resume.
  const { waitForCaptureStop } = await import("../../background/linkedin-capture.js");
  await waitForCaptureStop();
  // Cancelling sets a flag; the loop notices it at its next await, and the
  // unwinding itself writes. The globals go back only once that has actually
  // finished — first the run's own checkpoint says it is over, then a stretch
  // of silence long enough to cover the pace it was running at. A late write
  // after the swap is the leak this exists to prevent, so the waits are
  // generous: this runs once per boot, not once per assertion.
  await settle(() => STOPPED.has(previous.store.get("earthos_li_progress")?.status), 2_000);
  let quiet = 0;
  let written = countWrites(previous.writes);
  for (let tick = 0; tick < 100 && quiet < 12; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const now = countWrites(previous.writes);
    quiet = now === written ? quiet + 1 : 0;
    written = now;
  }
  globalThis.chrome = priorChrome;
  globalThis.fetch = priorFetch;
}

/** Checkpoint states that mean no loop is still running behind them. */
const STOPPED = new Set([undefined, "canceled", "complete", "completed", "failed", "idle"]);

async function settle(done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function countWrites(writes) {
  let total = 0;
  for (const values of writes.values()) total += values.length;
  return total;
}

export async function bootWorker({ fetch: fetchImpl, storage, cookies } = {}) {
  await stopLastBoot();
  const { chrome, calls, store, writes } = chromeShim();
  if (cookies) Object.assign(chrome.cookies, cookies);
  for (const [key, value] of Object.entries(storage || {})) store.set(key, value);
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.chrome = chrome;
  globalThis.fetch = fetchImpl || (async () => new Response("{}", {
    status: 200, headers: { "content-type": "application/json" },
  }));

  await import(`../../background/service-worker.js?boot=${Math.random()}`);
  // Let the top-level bootstrap promises settle.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const listener = calls.find(([name]) => name === "onMessage")?.[1][0];
  const send = (message, sender = PANEL_SENDER) => new Promise((resolve) => {
    // A listener that answers synchronously returns false; one that answers
    // later returns true. Either way the reply arrives through the callback.
    listener(message, sender, resolve);
  });
  // Alarms are how the worker wakes itself: the run keep-alive, the resume
  // tick, the soft-sync schedule. Firing one by hand is the only way to test
  // what the browser would do to a worker that was torn down mid-run.
  const alarmListener = calls.find(([name]) => name === "onAlarm")?.[1][0];
  const fireAlarm = (name) => alarmListener?.({ name });
  const restore = () => {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  };
  lastBoot = { chrome, fetch: globalThis.fetch, send, writes, store };
  return { chrome, calls, store, writes, send, fireAlarm, restore };
}
