// Scenario 3b: worker dies at storage-level points: (a) right after the visible "complete" is written,
// (b) mid scheduled soft sync. Fresh worker on the same storage.
import { boot, makeBase, fakeLinkedIn, setupAirtable, runCapture, report, until, sleep, finished, L } from "./lib.mjs";

const variant = process.argv[2] || "complete";
let N = 30;
const at = makeBase();
const li = fakeLinkedIn({ connections: () => N, delayMs: (url, u) => (variant === "silent" && u.searchParams.get("ids") ? 200 : 0) });
const out = [];
const w1 = await boot({ airtable: at, linkedin: li });
const origSet = w1.chrome.storage.local.set;
let killWhen = null;
w1.chrome.storage.local.set = async (next) => {
  await origSet(next);
  if (killWhen?.(next)) w1.kill();
};
try {
  await setupAirtable(w1);
  if (variant === "complete") {
    killWhen = (next) => next.capture_progress?.status === "complete";
    await w1.send({ type: "START_CAPTURE", site: "linkedin", mode: "full" });
  } else {
    await runCapture(w1, { mode: "full" }, "initial full");
    N = 60; // 30 new people for the scheduled run to enrich
    killWhen = (next) => next.earthos_li_progress?.silent && Object.keys(next.earthos_li_progress.enrichmentBatchOutcomes || {}).length >= 1;
    w1.fireAlarm("earthos-soft-sync");
  }
  const snap = await until(() => w1.killed(), "kill", 120_000);
  out.push(`killed: progress=${snap.capture_progress?.status} checkpoint=${JSON.stringify(snap.earthos_li_progress && { status: snap.earthos_li_progress.status, silent: snap.earthos_li_progress.silent, softSync: snap.earthos_li_progress.softSync })} lock=${Boolean(snap.earthos_linkedin_capture_lock)} softStatus=${JSON.stringify(snap.earthos_soft_sync_status)}`);
  at.setPhase("after");
  const w2 = await boot({ airtable: at, linkedin: li, storage: snap });
  await sleep(1500);
  if (variant === "complete") {
    out.push(`fresh worker: lock=${JSON.stringify(w2.store.get("earthos_linkedin_capture_lock"))} checkpoint left=${JSON.stringify(w2.store.get("earthos_li_progress") && (({ status, importId }) => ({ status, importId }))(w2.store.get("earthos_li_progress")))}`);
    // The user presses Sync after adding 5 connections.
    N = 35;
    const before = li.stats.connections;
    const r = await runCapture(w2, { mode: "full" }, "next sync");
    out.push(`next Sync: ${r.done.status} "${r.done.message}" connection pages fetched=${li.stats.connections - before} people=${at.counts().people} (LinkedIn has ${N})`);
  } else {
    const st = await until(() => { const v = w2.store.get("earthos_soft_sync_status"); return v?.completed || v?.failed ? v : null; }, "resumed soft", 120_000).catch(() => null);
    await sleep(300);
    out.push(`resumed scheduled: status=${JSON.stringify(st)} progress=${JSON.stringify(w2.store.get("capture_progress") && (({ status, runId }) => ({ status, runId }))(w2.store.get("capture_progress")))} people=${at.counts().people}`);
    out.push(`  checkpoint=${JSON.stringify(w2.store.get("earthos_li_progress"))} lock=${JSON.stringify(w2.store.get("earthos_linkedin_capture_lock"))}`);
    out.push(`  visible progress writes after resume: ${(w2.writes.get("capture_progress") || []).length}`);
  }
  out.push(`dupes=${JSON.stringify(at.dupes())}`);
  out.push(`VIOLATIONS: ${at.violations.length ? "\n  " + at.violations.join("\n  ") : "none"}`);
} catch (e) {
  out.push(`FAILED: ${e.stack}`);
} finally {
  report(`S3b kill@${variant}`, out);
  setTimeout(() => process.exit(0), 100);
}
