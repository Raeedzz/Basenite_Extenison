// Scenario 1: full sync of 25 with full profiles, then the same sync again.
import { boot, makeBase, fakeLinkedIn, setupAirtable, runCapture, report, L, F, urlFor } from "./lib.mjs";

const seed = {
  [L.PEOPLE]: [{ id: "recSEEDPERSON0003", fields: {
    [F.pName]: "Ada Hand-typed", [F.pUrl]: urlFor(3),
    [F.pPhoto]: [{ id: "attSEED", url: "https://dl.airtable.com/seed.jpg", filename: "seed.jpg" }],
    [F.pKnownBy]: [{ id: "usrOTHERPERSON01" }],
  } }],
  [L.COMPANIES]: [{ id: "recSEEDCOMPANY101", fields: {
    [F.cName]: "Acme", [F.cUrl]: "https://www.linkedin.com/company/acme",
    [F.cLogo]: [{ id: "attLOGO", url: "https://dl.airtable.com/acme.png", filename: "acme.png" }],
  } }],
  [L.EDUCATION]: [{ id: "recSEEDSCHOOL0201", fields: { [F.eName]: "MIT" } }],
  [L.ROLES]: [{ id: "recSEEDROLE000001", fields: { fldRoleTitle00001: "Hiring", fldRoleCompany001: ["recSEEDCOMPANY101"] } }],
};
const at = makeBase(seed);
const li = fakeLinkedIn({ connections: 25 });
const w = await boot({ airtable: at, linkedin: li });
const out = [];
try {
  const cfg = await setupAirtable(w);
  out.push(`mapping: ${JSON.stringify(cfg.mapping)}`);
  out.push(`linked: ${JSON.stringify(cfg.linked)}`);
  at.setPhase("sync1");
  const r1 = await runCapture(w, { mode: "full" }, "sync1");
  out.push(`sync1: ${r1.done.status} ${r1.done.message} counts=${JSON.stringify(at.counts())}`);
  out.push(`sync1 writes: ${at.writesIn("sync1").length} (${at.writesIn("sync1").map((x) => `${x.method}:${x.tableId.slice(-4)}:${x.n}`).join(" ")})`);
  const p3 = at.rows(L.PEOPLE).find((r) => r.fields[F.pUrl] === urlFor(3));
  out.push(`seed person3: id=${p3?.id} name=${p3?.fields[F.pName]} photo=${p3?.fields[F.pPhoto]?.[0]?.url} knownBy=${JSON.stringify(p3?.fields[F.pKnownBy])}`);
  const acme = at.rows(L.COMPANIES).filter((r) => /acme/i.test(r.fields[F.cName] || ""));
  out.push(`acme rows: ${acme.map((r) => `${r.id} logo=${r.fields[F.cLogo]?.[0]?.url}`).join(" | ")}`);
  const mit = at.rows(L.EDUCATION).filter((r) => /mit/i.test(r.fields[F.eName] || ""));
  out.push(`mit rows: ${mit.map((r) => `${r.id} logo=${r.fields[F.eLogo]?.[0]?.source || r.fields[F.eLogo]?.[0]?.url}`).join(" | ")}`);
  const p0 = at.rows(L.PEOPLE).find((r) => r.fields[F.pUrl] === urlFor(0));
  out.push(`person0 fields: ${Object.keys(p0?.fields || {}).join(",")} workedAt=${p0?.fields[F.pWorkedAt]} current=${p0?.fields[F.pCurrent]} schools=${p0?.fields[F.pSchools]}`);
  out.push(`dupes after sync1: ${JSON.stringify(at.dupes())}`);

  at.setPhase("sync2");
  const r2 = await runCapture(w, { mode: "full" }, "sync2");
  out.push(`sync2: ${r2.done.status} ${r2.done.message} counts=${JSON.stringify(at.counts())}`);
  const w2 = at.writesIn("sync2");
  out.push(`sync2 writes: ${w2.length}`);
  for (const x of w2) out.push(`   ${x.method} ${x.tableId} n=${x.n} fields=${JSON.stringify(x.body.records.map((r) => Object.keys(r.fields)))}`);
  out.push(`dupes after sync2: ${JSON.stringify(at.dupes())}`);
  out.push(`VIOLATIONS: ${at.violations.length ? "\n  " + at.violations.join("\n  ") : "none"}`);
  out.push(`li stats: ${JSON.stringify({ ...li.stats, profileUrns: li.stats.profileUrns.length })}`);
} catch (e) {
  out.push(`FAILED: ${e.stack}`);
} finally {
  report("S1 full sync x2", out);
  await w.send({ type: "CANCEL_SYNC" }).catch(() => {});
  setTimeout(() => process.exit(0), 100);
}
