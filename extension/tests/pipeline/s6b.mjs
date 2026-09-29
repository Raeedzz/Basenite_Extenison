// Scenario 6b: bulk enrich hits a LinkedIn soft block (profiles come back empty) for two batches,
// pauses with an error, the user fixes it and presses Resume. Does every pasted person land?
import { boot, makeBase, fakeLinkedIn, setupAirtable, report, until, sleep, L, F, urlFor } from "./lib.mjs";

// LinkedIn starts soft-blocking right after the first batch's ten people, whatever the pipeline has read ahead.
let blocked = null;
const seen = new Set();
const at = makeBase();
const li = fakeLinkedIn({
  connections: 0,
  hook: (url, u) => {
    if (u.pathname !== "/voyager/api/identity/dash/profiles") return undefined;
    const id = u.searchParams.get("memberIdentity");
    if (blocked === null && !seen.has(id) && seen.size >= 10) blocked = true;
    seen.add(id);
    return blocked ? new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "content-type": "application/json" } }) : undefined;
  },
});
const out = [];
const w = await boot({ airtable: at, linkedin: li });
const job = () => w.store.get("bulk_enrich_job");
try {
  await setupAirtable(w);
  const urls = Array.from({ length: 40 }, (_, i) => urlFor(i)).join("\n");
  await w.send({ type: "BULK_ENRICH", urls });
  const paused = await until(() => (["error", "complete"].includes(job()?.status) ? job() : null), "pause", 120_000);
  out.push(`paused: status=${paused.status} next=${paused.next} failed=${paused.failed} failedUrls=${paused.failedUrls.length} error="${paused.error}"`);
  out.push(`enrich_progress: ${JSON.stringify(w.store.get("enrich_progress"))}`);
  blocked = false; // user signs back in
  const r = await w.send({ type: "BULK_ENRICH_RESUME" });
  out.push(`resume: ${JSON.stringify(r)}`);
  const done = await until(() => (["error", "complete"].includes(job()?.status) && job().status !== "error" ? job() : null), "resumed job", 180_000);
  const have = new Set(at.rows(L.PEOPLE).map((row) => row.fields[F.pUrl]));
  const missing = Array.from({ length: 40 }, (_, i) => urlFor(i)).filter((u) => !have.has(u));
  out.push(`done: status=${done.status} next=${done.next}/${done.urls.length} created=${done.created} failed=${done.failed} message="${w.store.get("enrich_progress")?.message}"`);
  out.push(`people in Airtable: ${have.size}/40; never written: ${missing.length} (${missing.map((u) => u.split("/").pop()).join(", ")})`);
  out.push(`VIOLATIONS: ${at.violations.length ? "\n  " + at.violations.join("\n  ") : "none"}`);
} catch (e) {
  out.push(`FAILED: ${e.stack}`);
  out.push(`  job=${JSON.stringify(job())}`);
} finally {
  report("S6b bulk soft-block → resume", out);
  await w.send({ type: "CANCEL_SYNC" }).catch(() => {});
  setTimeout(() => process.exit(0), 100);
}
