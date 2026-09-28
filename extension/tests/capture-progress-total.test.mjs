/**
 * The denominator the extension is allowed to publish.
 *
 * `progressFor` in the popup already draws an unknown total honestly — the
 * indeterminate sweep, and a caption with no fraction after it. What defeated
 * it was the write side: a total of 0 means "LinkedIn did not say how many
 * connections there are", and raising it to the count so far turned that into
 * a total equal to its own numerator. The popup then faithfully drew a full
 * bar reading "Capturing LinkedIn · 1,000 of 1,000" over a run whose own
 * detail line said it was loading contacts 1,000-1,100.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chromeShim } from "./helpers/worker-harness.mjs";

/** capture-state.js reads chrome and fetch off the global, so install both. */
async function loadCaptureState() {
  const { chrome, store } = chromeShim();
  globalThis.chrome = chrome;
  globalThis.fetch = async () => { throw new Error("offline in tests"); };
  // A fresh module registry per test: the module holds run tombstones and a
  // backend-report throttle in closure state.
  const module = await import(`../background/capture-state.js?t=${Math.random()}`);
  return { module, store };
}

/** The payload the capture engine sends while LinkedIn reports no total. */
function capturing(overrides = {}) {
  return {
    site: "linkedin",
    status: "in_progress",
    phase: "capturing",
    runId: "run-1",
    current: 1000,
    total: 0,
    discovered: 1000,
    saved: 1000,
    enriched: 0,
    message: "Loading contacts 1,000-1,100...",
    ...overrides,
  };
}

test("an unknown total is stored as unknown, not as the count so far", async () => {
  const { module, store } = await loadCaptureState();
  await module.reportCaptureProgress(capturing());

  const progress = store.get("capture_progress");
  assert.equal(progress.total, 0, "a total of 0 must survive as 0");
  assert.equal(progress.discovered, 1000);
  assert.equal(progress.saved, 1000);
});

test("a reported total is kept, and is never left behind its own count", async () => {
  const { module, store } = await loadCaptureState();
  await module.reportCaptureProgress(capturing({ total: 1367, current: 400, saved: 400, discovered: 400 }));
  assert.equal(store.get("capture_progress").total, 1367);

  await module.reportCaptureProgress(capturing({ total: 900, current: 1000 }));
  assert.equal(store.get("capture_progress").total, 1367, "a total never shrinks mid-run");
});

test("a message that omits the total cannot undo a determinate bar", async () => {
  const { module, store } = await loadCaptureState();
  await module.reportCaptureProgress(capturing({ total: 1367, current: 400, saved: 400, discovered: 400 }));
  await module.reportCaptureProgress(capturing({ total: 0, current: 500, saved: 500, discovered: 500 }));

  assert.equal(store.get("capture_progress").total, 1367);
});
