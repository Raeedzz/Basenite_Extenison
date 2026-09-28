// Scenario 6: bulk enrich of pasted URLs (dupes + invalid), cancel, resume.
import { boot, makeBase, fakeLinkedIn, setupAirtable, report, until, sleep, L, F, urlFor } from "./lib.mjs";

const variant = process.argv[2] || "full";
const at = makeBase();
const li = fakeLinkedIn({ connections: 0, delayMs: (url, u) => (u.pathname === "/voyager/api/identity/dash/profiles" ? Number(process.env.SLOW || 0) : 0) });
const out = [];
const pasted = [
  ...Array.from({ length: 25 }, (_, i) => `https://www.linkedin.com/in/ada-number-${i}/`),
  "linkedin.com/in/ada-number-1",
  "https://linkedin.com/in/Ada-Number-2?trk=abc",
  "http://www.linkedin.com/in/ada-number-3",
  "www.linkedin.com/in/ada-number-4/details/experience/",
  "https://www.linkedin.com/in/ada%2Dnumber%2D5",
  "https://www.linkedin.com/company/acme",
  "https://www.linkedin.com/in/",
  "not a url, just text",
  "https://www.linkedin.com/in/no-such-person",
  "",
].join("\n");
const jobOf = (w) => w.store.get("bulk_enrich_job");
const doneJob = (w) => { const j = jobOf(w); return j && ["complete", "error", "canceled"].includes(j.status) ? j : null; };
let w = await boot({ airtable: at, linkedin: li });
try {
  await setupAirtable(w);
  at.setPhase("bulk");
  const r = await w.send({ type: "BULK_ENRICH", urls: pasted });
  out.push(`start: ${JSON.stringify(r)}`);
  if (variant === "full") {
    const j = await until(() => doneJob(w), "bulk done", 180_000);
    out.push(`job: status=${j.status} next=${j.next}/${j.urls.length} created=${j.created} updated=${j.updated} unchanged=${j.unchanged} failed=${j.failed} failedUrls=${JSON.stringify(j.failedUrls)}`);
    out.push(`enrich_progress: ${JSON.stringify(w.store.get("enrich_progress"))}`);
  } else if (variant === "cancel") {
    // cancel while the second batch is in flight
    await until(() => (jobOf(w)?.next || 0) >= 10, "first batch", 60_000);
    await until(() => li.stats.profileSingle > 22, "second batch in flight", 60_000);
    const before = at.counts().people;
    const c = await w.send({ type: "CANCEL_SYNC" });
    out.push(`cancel: ${JSON.stringify(c)} job.status=${jobOf(w).status} people=${before}`);
    const statuses = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) { statuses.push(`${jobOf(w).status}/${w.store.get("enrich_progress")?.status}`); await sleep(100); }
    const compact = statuses.filter((s, i) => s !== statuses[i - 1]);
    out.push(`job/enrich_progress status after cancel (8s): ${compact.join(" → ")}`);
    out.push(`people after cancel: ${at.counts().people} job.next=${jobOf(w).next}`);
    const res = await w.send({ type: "BULK_ENRICH_RESUME" });
    out.push(`resume after cancel: ${JSON.stringify(res)}`);
  } else if (variant === "cancelkill") {
    // cancel mid-batch, then the worker dies while the stored job reads "running" again
    await until(() => (jobOf(w)?.next || 0) >= 10, "first batch", 60_000);
    await until(() => li.stats.profileSingle > 22, "second batch in flight", 60_000);
    await w.send({ type: "CANCEL_SYNC" });
    out.push(`after cancel: job.status=${jobOf(w).status}`);
    const snap = await until(() => (jobOf(w).status === "running" ? w.kill() : null), "job reverted to running", 20_000).catch(() => null);
    out.push(`stored job flipped back to running after cancel: ${Boolean(snap)}`);
    if (snap) {
      out.push(`  killed with job.status=${snap.bulk_enrich_job.status} next=${snap.bulk_enrich_job.next}`);
      const peopleAtKill = at.counts().people;
      at.setPhase("afterkill");
      w = await boot({ airtable: at, linkedin: li, storage: snap });
      await sleep(3000);
      const j = await until(() => doneJob(w), "resumed job", 120_000).catch(() => jobOf(w));
      out.push(`  fresh worker: job.status=${j.status} next=${j.next}/${j.urls.length}; people ${peopleAtKill}→${at.counts().people}; writes after kill=${at.writesIn("afterkill").length}`);
    }
  } else if (variant === "kill") {
    await until(() => (jobOf(w)?.next || 0) >= 10, "first batch", 60_000);
    await until(() => li.stats.profileSingle > 22, "second batch in flight", 60_000);
    const snap = w.kill();
    out.push(`killed: job.status=${snap.bulk_enrich_job.status} next=${snap.bulk_enrich_job.next} people=${at.counts().people}`);
    at.setPhase("afterkill");
    w = await boot({ airtable: at, linkedin: li, storage: snap });
    const j = await until(() => doneJob(w), "resumed job", 180_000);
    out.push("job writes: " + (w.writes.get("bulk_enrich_job")||[]).map((x) => `${x.status}@${x.next}`).join(" ")); out.push(`resumed: status=${j.status} next=${j.next}/${j.urls.length} created=${j.created} updated=${j.updated} unchanged=${j.unchanged} failed=${j.failed}`);
  }
  out.push(`counts=${JSON.stringify(at.counts())} dupes=${JSON.stringify(at.dupes())}`);
  const urls = at.rows(L.PEOPLE).map((r) => r.fields[F.pUrl]).sort();
  out.push(`people urls: ${urls.length} ${urls.some((u) => /no-such|acme/.test(u)) ? "(contains bogus!)" : ""}`);
  out.push(`VIOLATIONS: ${at.violations.length ? "\n  " + at.violations.join("\n  ") : "none"}`);
} catch (e) {
  out.push(`FAILED: ${e.stack}`);
  out.push(`  job=${JSON.stringify(jobOf(w))}`);
} finally {
  report(`S6 bulk ${variant}`, out);
  await w.send({ type: "CANCEL_SYNC" }).catch(() => {});
  setTimeout(() => process.exit(0), 100);
}
