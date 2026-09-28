// Scenario 5: Cancel mid-sync, then start a new Sync.
import { boot, makeBase, fakeLinkedIn, setupAirtable, report, until, sleep, finished, L } from "./lib.mjs";

const when = process.argv[2] || "base";   // base | enrich
const gap = Number(process.env.GAP ?? 0);   // ms between Cancel and Sync
const at = makeBase();
const li = fakeLinkedIn({ connections: 250 });
const out = [];
const w = await boot({ airtable: at, linkedin: li });
try {
  await setupAirtable(w);
  at.setPhase("run1");
  const r1 = await w.send({ type: "START_CAPTURE", site: "linkedin", mode: "full" });
  // Cancel while an Airtable write is in flight.
  await until(() => {
    const cp = w.store.get("earthos_li_progress");
    if (when === "base") return at.writesIn("run1").filter((x) => x.method === "POST" && x.tableId === L.PEOPLE).length >= 3;
    return at.writesIn("run1").filter((x) => x.method === "PATCH" && x.tableId === L.PEOPLE).length >= 2;
  }, "cancel point", 60_000);
  const c = await w.send({ type: "CANCEL_SYNC" });
  out.push(`cancel: ${JSON.stringify(c)} progress=${w.store.get("capture_progress")?.status} counts=${JSON.stringify(at.counts())}`);
  if (gap) await sleep(gap);
  at.setPhase("run2");
  const r2 = await w.send({ type: "START_CAPTURE", site: "linkedin", mode: "full" });
  out.push(`sync after cancel (+${gap}ms): ${JSON.stringify(r2)} sameRunAsCanceled=${r2.runId === r1.runId}`);
  out.push(`  progress right after: ${JSON.stringify((({ status, phase, runId, message }) => ({ status, phase, runId, message }))(w.store.get("capture_progress")))}`);
  const done = await until(() => {
    const p = w.store.get("capture_progress");
    return p && ["complete", "error"].includes(p.status) ? p : null;
  }, "second sync", 60_000).catch((e) => ({ status: "TIMEOUT", message: e.message }));
  await sleep(500);
  const p = w.store.get("capture_progress");
  out.push(`second sync end: ${done.status} "${done.message}" final progress=${JSON.stringify((({ status, phase, runId, message }) => ({ status, phase, runId, message }))(p))}`);
  out.push(`  counts=${JSON.stringify(at.counts())} dupes=${JSON.stringify(at.dupes())}`);
  out.push(`  checkpoint=${JSON.stringify(w.store.get("earthos_li_progress") && (({ status, runId, importId, nextSequence }) => ({ status, runId, importId, nextSequence }))(w.store.get("earthos_li_progress")))} lock=${JSON.stringify(w.store.get("earthos_linkedin_capture_lock"))}`);
  out.push(`  capture_results=${JSON.stringify(w.store.get("capture_results"))}`);
  out.push(`VIOLATIONS: ${at.violations.length ? "\n  " + at.violations.join("\n  ") : "none"}`);
} catch (e) {
  out.push(`FAILED: ${e.stack}`);
} finally {
  report(`S5 cancel@${when} then sync`, out);
  await w.send({ type: "CANCEL_SYNC" }).catch(() => {});
  setTimeout(() => process.exit(0), 100);
}
