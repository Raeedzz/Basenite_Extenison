// Scenario 7: company capture and mutuals, both writing to Airtable (after a 10-person test sync).
import { boot, makeBase, fakeLinkedIn, setupAirtable, runCapture, report, until, sleep, L, F, urlFor } from "./lib.mjs";

const at = makeBase({
  [L.PEOPLE]: [{ id: "recSEEDPERSON0101", fields: {
    [F.pName]: "Hand Entered 101", [F.pUrl]: urlFor(101),
    [F.pPhoto]: [{ id: "attSEED", url: "https://dl.airtable.com/seed.jpg", filename: "seed.jpg" }],
    [F.pKnownBy]: [{ id: "usrOTHERPERSON01" }],
  } }],
});
const li = fakeLinkedIn({ connections: 10, companyPeople: [0, 1, 5, 100, 101, 102], bridgesFor: (i) => [0, 1, 2] });
const out = [];
const w = await boot({ airtable: at, linkedin: li });
const done = (key) => until(() => { const p = w.store.get(key); return p && ["complete", "error", "canceled"].includes(p.status) ? p : null; }, key, 180_000);
try {
  await setupAirtable(w);
  at.setPhase("test");
  const t = await runCapture(w, { sample: true }, "test");
  out.push(`test sync: ${t.done.status} counts=${JSON.stringify(at.counts())}`);

  at.setPhase("company");
  const c = await w.send({ type: "START_COMPANY_CAPTURE", company: "Globex", keywords: [] });
  out.push(`company start: ${JSON.stringify(c)}`);
  const cp = await done("company_progress");
  await sleep(300);
  out.push(`company: ${cp.status} "${cp.message}" counts=${JSON.stringify(at.counts())} dupes=${JSON.stringify(at.dupes())}`);
  const cw = at.writesIn("company");
  out.push(`  writes: ${cw.map((x) => `${x.method}:${x.tableId.slice(-4)}:${x.n}`).join(" ")}`);
  const p101 = at.rows(L.PEOPLE).find((r) => r.fields[F.pUrl] === urlFor(101));
  out.push(`  seeded 101: name=${p101.fields[F.pName]} photo=${p101.fields[F.pPhoto]?.[0]?.url} knownBy=${JSON.stringify(p101.fields[F.pKnownBy])} workedAt=${p101.fields[F.pWorkedAt]}`);
  const p100 = at.rows(L.PEOPLE).find((r) => r.fields[F.pUrl] === urlFor(100));
  out.push(`  new 100: ${JSON.stringify(Object.keys(p100?.fields || {}))} stamp=${p100?.fields.fldxnxDdEM3pbrs6X}`);

  at.setPhase("mutual");
  const targets = [urlFor(102), urlFor(3), "https://www.linkedin.com/in/no-such-person"];
  const m = await w.send({ type: "START_MUTUAL_FINDING", contacts: targets.map((linkedinUrl) => ({ linkedinUrl })) });
  out.push(`mutual start: ${JSON.stringify(m)}`);
  const mp = await done("mutual_progress");
  await sleep(300);
  out.push(`mutual: ${mp.status} "${mp.message}" updated=${mp.updated} unresolved=${mp.unresolved} counts=${JSON.stringify(at.counts())} dupes=${JSON.stringify(at.dupes())}`);
  const mw = at.writesIn("mutual");
  out.push(`  writes: ${mw.map((x) => `${x.method}:${x.tableId.slice(-4)}:${x.n}`).join(" ")}`);
  for (const x of mw.filter((x) => x.tableId === L.PEOPLE)) for (const r of x.body.records) out.push(`   ${x.method} ${r.id || "(new)"} ${JSON.stringify(r.fields).slice(0, 300)}`);
  const bogus = at.rows(L.PEOPLE).find((r) => /no-such-person/.test(r.fields[F.pUrl] || ""));
  out.push(`  row for unresolvable target: ${bogus ? JSON.stringify(bogus.fields) : "none"}`);
  out.push(`VIOLATIONS: ${at.violations.length ? "\n  " + at.violations.join("\n  ") : "none"}`);
} catch (e) {
  out.push(`FAILED: ${e.stack}`);
} finally {
  report("S7 company + mutuals", out);
  await w.send({ type: "CANCEL_SYNC" }).catch(() => {});
  setTimeout(() => process.exit(0), 100);
}
