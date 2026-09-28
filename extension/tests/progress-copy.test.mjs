/**
 * What a running sync is allowed to say about itself.
 *
 * The sync used to narrate itself in the units its own loops use: the base pass
 * printed "Loading contacts 200–300..." (a row-offset window into a paged API,
 * unclamped, so it overshot the end of a smaller network), while the enrichment
 * pass printed the same window clamped — "Enriching contacts 200–200..." on an
 * account with exactly 200 connections. Meanwhile the bar above them counted
 * something else again. None of the three numbers was the one the person
 * watching wanted: how much is left.
 *
 * So the rules under test are: every stage says where it is against its own
 * total, always names what is still to go, and says plainly when LinkedIn has
 * not told us the total rather than inventing one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatWait,
  percentComplete,
  progressLabel,
  relativeTime,
  remainingCount,
  scheduleLabel,
  stageHeadline,
  stageMessage,
  syncHistoryDetail,
  waitMessage,
} from "../lib/progress-copy.js";
import { enrichmentWalked } from "../lib/enrichment-progress.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(HERE, relative), "utf8");

test("every stage reports its position and what is left of it", () => {
  assert.equal(
    stageMessage("capturing", { current: 200, total: 264 }),
    "Read 200 of 264 connections · 64 to go",
  );
  assert.equal(
    stageMessage("saving", { current: 200, total: 264 }),
    "Saved 200 of 264 contacts · 64 to go",
  );
  assert.equal(
    stageMessage("enriching", { current: 200, total: 264 }),
    "Full profiles for 200 of 264 contacts · 64 to go",
  );
  assert.equal(progressLabel(200, 264), "76% · 64 left");
});

test("no stage narrates row offsets, the window that read 200–200", () => {
  for (const phase of ["starting", "capturing", "saving", "enriching"]) {
    const message = stageMessage(phase, { current: 200, total: 264 });
    assert.doesNotMatch(message, /\d+\s*[–-]\s*\d+/, `${phase} still prints an offset range`);
  }
});

test("an unknown total is said out loud, never filled in", () => {
  assert.equal(remainingCount(1000, 0), null, "0 means nobody has said how many there are");
  assert.equal(percentComplete(1000, 0), null, "and there is no percentage to draw");
  assert.equal(
    stageMessage("capturing", { current: 1000, total: 0 }),
    "Read 1,000 connections so far · LinkedIn has not said how many there are",
  );
  assert.equal(progressLabel(1000, 0), "1,000 so far · total unknown");
});

test("a stage nobody has counted yet labels nothing rather than 0 of 0", () => {
  assert.equal(progressLabel(0, 0), "", "'0 of 0' reads as finished");
});

test("a count can never overshoot the total it is counting toward", () => {
  assert.equal(remainingCount(1400, 1367), 0, "past the total is none left, not negative");
  assert.equal(progressLabel(1400, 1367), "100% · 0 left");
  assert.equal(percentComplete(1400, 1367), 100);
});

test("the profile pass names the person it is on, and where that leaves it", () => {
  // "Which of my 1,367 contacts is it actually doing right now" is the question
  // a profile walk raises, and a count on its own cannot answer it — nor show
  // that anything is moving while the count sits still through a batch.
  assert.equal(
    stageMessage("enriching", { current: 204, total: 264, who: "Jane Okonkwo" }),
    "Jane Okonkwo · 204 of 264 · 60 to go",
  );
  // Two lines at 230px is roughly 70 characters; a name plus a soft sync's
  // rewrite count has to fit inside them or the panel eats the end of it.
  assert.ok(
    stageMessage("enriching", {
      current: 1240, total: 1367, soft: true, updated: 12, who: "Marcus Lindqvist",
    }).length <= 70,
    "the profile line no longer fits the panel's two lines",
  );
  assert.equal(
    stageMessage("enriching", { current: 204, total: 264, who: "  " }),
    "Full profiles for 204 of 264 contacts · 60 to go",
    "no name is silence, not an empty separator",
  );
});

test("a soft sync counts the walk, and reports the rewrites separately", () => {
  // The number that matters to the person watching is how far through their
  // network the pass is; the twelve people it found worth rewriting is a fact
  // about their network, not about how long this will take.
  assert.equal(
    stageMessage("enriching", { current: 200, total: 264, soft: true, updated: 12 }),
    "Checked 200 of 264 contacts for changes · 64 to go · 12 updated",
  );
});

test("a pause says why, for how long, and how much is still coming", () => {
  assert.equal(
    waitMessage("rate_limited", { seconds: 45, current: 200, total: 264 }),
    "Paused 45s — LinkedIn asked us to slow down · 64 left",
  );
  assert.equal(
    waitMessage("offline", { seconds: 5, current: 200, total: 264 }),
    "Connection lost — retrying in 5s · 64 left",
  );
  assert.match(waitMessage("cooldown", { seconds: 120 }), /^Paused 2 min — /);
  assert.equal(formatWait(0.5), "1s");
});

test("the panel's idle line answers when it last synced and whether it will again", () => {
  assert.equal(relativeTime(Date.now() - 90 * 60_000), "1 hour ago");
  assert.equal(relativeTime(Date.now() - 30_000), "just now");
  assert.equal(relativeTime(0), "", "never synced has no time to name");
  assert.equal(scheduleLabel({ enabled: true, timesPerDay: 12 }), "Auto-syncs every 2h");
  assert.equal(scheduleLabel({ enabled: true, timesPerDay: 1 }), "Auto-syncs daily");
  assert.equal(scheduleLabel({ enabled: false, timesPerDay: 12 }), "Auto-sync off");
});

test("the idle line says whose sync the last one was", () => {
  // The whole question this line is asked: is the background sync actually
  // running? A scheduled run writes the same capture_results a manual one
  // does, so a time on its own reads identically whether the schedule fired an
  // hour ago or has not fired in a week.
  const now = Date.now();
  const anHourAgo = now - 60 * 60_000;
  assert.equal(
    syncHistoryDetail({ lastSyncAt: anHourAgo, prefs: { enabled: true, timesPerDay: 12 }, now }),
    "Last sync 1 hour ago · Auto-syncs every 2h",
  );
  assert.equal(
    syncHistoryDetail({
      lastSyncAt: anHourAgo,
      scheduled: true,
      prefs: { enabled: true, timesPerDay: 12 },
      now,
    }),
    "Last auto-sync 1 hour ago · Auto-syncs every 2h",
  );
  assert.equal(
    syncHistoryDetail({ prefs: { enabled: false, timesPerDay: 12 }, now }),
    "Never synced · Auto-sync off",
  );
});

test("a scheduled run that is walking right now says so", () => {
  // It publishes no progress by design, so the panel sits on "Ready to sync"
  // while it works — which is the state that reads most like nothing happening.
  const now = Date.now();
  const prefs = { enabled: true, timesPerDay: 12 };
  const lastSyncAt = now - 3 * 60 * 60_000;
  assert.equal(
    syncHistoryDetail({ lastSyncAt, prefs, now, status: { started: true, at: now - 60_000 } }),
    "Last sync 3 hours ago · Auto-sync running",
  );
  // A run whose worker died leaves "started" standing. The resume path takes
  // six hours to give up on such a run; past that this stops claiming it.
  assert.equal(
    syncHistoryDetail({ lastSyncAt, prefs, now, status: { started: true, at: now - 7 * 60 * 60_000 } }),
    "Last sync 3 hours ago · Auto-syncs every 2h",
  );
  // A failure the user never sees a banner for — a scheduled run raises none.
  assert.equal(
    syncHistoryDetail({ lastSyncAt, prefs, now, status: { failed: "LinkedIn said no", at: now - 30 * 60_000 } }),
    "Last sync 3 hours ago · Auto-sync failed 30 min ago",
  );
});

test("a skipped tick and a finished one leave the cadence standing", () => {
  // Only two states earn the space: running now, and failed. A tick skipped
  // because something else was syncing resolves itself two hours later, and a
  // completed one is already the time on the left.
  const now = Date.now();
  const prefs = { enabled: true, timesPerDay: 12 };
  const lastSyncAt = now - 20 * 60_000;
  for (const status of [
    { skipped: "busy", at: now - 60_000 },
    { skipped: "no_initial_sync", at: now - 60_000 },
    { completed: true, captured: 1204, at: lastSyncAt + 40 },
  ]) {
    assert.equal(
      syncHistoryDetail({ lastSyncAt, scheduled: true, prefs, now, status }),
      "Last auto-sync 20 min ago · Auto-syncs every 2h",
      `${JSON.stringify(status)} should not take the line`,
    );
  }
});

test("the idle line fits the two lines the panel gives it", () => {
  // 230px clamped to two lines is roughly 70 characters, and this line is
  // assembled from three independently plausible phrases.
  const now = Date.now();
  const longest = syncHistoryDetail({
    lastSyncAt: now - 3 * 24 * 60 * 60_000,
    scheduled: true,
    prefs: { enabled: true, timesPerDay: 1 },
    status: { failed: "whatever", at: now - 3 * 60 * 60_000 },
    now,
  });
  assert.ok(longest.length <= 70, `the idle line no longer fits: ${longest}`);
});

// ─── The enrichment stage's numerator ────────────────────────────────────────

const checkpoint = (overrides = {}) => ({
  totalConnections: 264,
  nextSequence: 3,
  pendingEnrichmentSequences: [],
  enrichmentBatchOutcomes: {},
  ...overrides,
});

test("a page that has left the queue counts as walked, however little it wrote", () => {
  // A soft sync's all-known pages never enter the queue at all. Counting only
  // what was rewritten is what showed a nearly finished pass as barely started.
  assert.equal(enrichmentWalked(checkpoint(), 100), 264, "three pages, clamped to the network");
  assert.equal(
    enrichmentWalked(checkpoint({ nextSequence: 2 }), 100),
    200,
    "pages not yet uploaded have not been walked",
  );
});

test("the page in flight moves the count by its own batches", () => {
  const progress = checkpoint({
    nextSequence: 3,
    pendingEnrichmentSequences: [2],
    enrichmentBatchOutcomes: {
      "0:0": { enriched: 40, unavailable: 0 },
      "2:0": { enriched: 18, unavailable: 2 },
    },
  });
  assert.equal(
    enrichmentWalked(progress, 100),
    220,
    "two settled pages plus the twenty people the third has been through",
  );
});

test("an unknown total leaves the walk uncapped rather than inventing an end", () => {
  assert.equal(enrichmentWalked(checkpoint({ totalConnections: 0 }), 100), 300);
});

// ─── Two surfaces, two readings, on purpose ──────────────────────────────────

test("the capture engine builds every user-facing sentence from this module", () => {
  const engine = read("../background/linkedin-capture.js");
  // The old messages were assembled inline from loop counters, which is how two
  // passes over the same run came to describe it with different arithmetic.
  assert.doesNotMatch(
    engine,
    /sendProgress\(\s*`[^`]*\$\{[^}]*rowsPerChunk/,
    "a progress message is being built from row offsets again",
  );
  assert.match(engine, /stageMessage\("capturing"/);
  assert.match(engine, /who: lastRowName\(/, "the profile pass stopped naming who it is on");
  assert.match(engine, /stageMessage\("saving"/);
  assert.match(engine, /stageMessage\("enriching"/);
  assert.match(engine, /waitMessage\("cooldown"/);
});
