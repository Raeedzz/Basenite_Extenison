// Scenario 8b: a row added to People after the index was built (teammate's extension, or by hand)
// — does a soft sync / bulk enrich / company capture create a second row for that person?
import { boot, makeBase, fakeLinkedIn, setupAirtable, runCapture, report, until, sleep, L, F, urlFor } from "./lib.mjs";

const how = process.argv[2] || "soft"; // soft | scheduled | bulk | company
let N = 10;
const at = makeBase();
const li = fakeLinkedIn({ connections: () => N, companyPeople: [10] });
const out = [];
const w = await boot({ airtable: at, linkedin: li });
try {
  await setupAirtable(w);
  await runCapture(w, { mode: "full" }, "full");
  out.push(`after full sync: people=${at.counts().people}`);
  // A teammate's extension (or a person) adds ada-number-10 to People.
  const table = at.base.state.get(L.PEOPLE);
  table.records.set("recTEAMMATE000010", { id: "recTEAMMATE000010", fields: {
    [F.pName]: "Ada Number10", [F.pUrl]: urlFor(10), [F.pKnownBy]: [{ id: "usrTEAMMATE00001" }],
  } });
  N = 11; // ...and ada-number-10 is now also my connection
  at.setPhase(how);
  if (how === "soft") await runCapture(w, { mode: "soft" }, "quick refresh");
  else if (how === "scheduled") {
    w.fireAlarm("earthos-soft-sync");
    await until(() => { const v = w.store.get("earthos_soft_sync_status"); return v?.completed || v?.failed ? v : null; }, "scheduled");
    await sleep(300);
  } else if (how === "bulk") {
    await w.send({ type: "BULK_ENRICH", urls: urlFor(10) });
    await until(() => { const j = w.store.get("bulk_enrich_job"); return j && ["complete", "error"].includes(j.status) ? j : null; }, "bulk");
  } else if (how === "company") {
    await w.send({ type: "START_COMPANY_CAPTURE", company: "Globex", keywords: [] });
    await until(() => { const p = w.store.get("company_progress"); return p && ["complete", "error"].includes(p.status) ? p : null; }, "company");
    await sleep(300);
  }
  const rows = at.rows(L.PEOPLE).filter((r) => r.fields[F.pUrl] === urlFor(10));
  out.push(`${how}: rows for ada-number-10 = ${rows.length} → ${rows.map((r) => `${r.id} knownBy=${JSON.stringify(r.fields[F.pKnownBy])}`).join(" | ")}`);
  out.push(`dupes=${JSON.stringify(at.dupes())}`);
  out.push(`VIOLATIONS: ${at.violations.length ? "\n  " + at.violations.join("\n  ") : "none"}`);
} catch (e) {
  out.push(`FAILED: ${e.stack}`);
} finally {
  report(`S8b stale index → ${how}`, out);
  await w.send({ type: "CANCEL_SYNC" }).catch(() => {});
  setTimeout(() => process.exit(0), 100);
}
