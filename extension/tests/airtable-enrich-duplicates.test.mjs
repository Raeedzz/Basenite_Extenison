/**
 * Enrich a table as often as you like, from as many tables as you like: one
 * row per person, company, school, and job across the whole Basanite base.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bootWorker } from "./helpers/worker-harness.mjs";
import { BASE_ID, fakeBase } from "./helpers/fake-airtable.mjs";
import { BASANITE_TABLES, COMPANIES, EDUCATION, PEOPLE, WORK } from "./helpers/basanite-base.mjs";

const fieldsLib = await import("../lib/airtable-fields.js");
const linkedLib = await import("../lib/airtable-linked.js");
const sink = await import("../lib/airtable-sink.js");

const P_LINKEDIN = "fldvyrmtV2q06ip6k";
const C_NAME = "fldzBJ1c98Y5wviTm";
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Companies and schools from small pools, so people share them.
// From person 18 on, one new company each run has never seen.
const companyOf = (i, j) => (i >= 18 ? 200 + i : 100 + ((i + j) % 7));
function profile(i) {
  const school = 500 + (i % 3);
  return {
    entityUrn: `urn:li:fsd_profile:ACoAA${i}`, publicIdentifier: `person-${i}`, firstName: "Person", lastName: String(i), headline: "h",
    profilePositionGroups: { elements: [0, 1].map((j) => {
      const c = companyOf(i, j);
      return {
        companyName: `Co ${c}`, company: { entityUrn: `urn:li:fsd_company:${c}`, name: `Co ${c}` },
        profilePositionInPositionGroup: { elements: [{ title: `T${j}`, companyName: `Co ${c}`, companyUrn: `urn:li:fsd_company:${c}`, timePeriod: { startDate: { year: 2010 + j } } }] },
      };
    }) },
    profileEducations: { elements: [{ schoolName: `School ${school}`, schoolUrn: `urn:li:fsd_school:${school}`,
      school: { entityUrn: `urn:li:fsd_school:${school}`, name: `School ${school}` }, timePeriod: { startDate: { year: 2005 } } }] },
  };
}

const source = (id, name, urls) => ({
  id, name, primaryFieldId: `${id}N`,
  fields: [{ id: `${id}N`, name: "Name", type: "singleLineText" }, { id: `${id}L`, name: "LinkedIn", type: "multilineText" }],
  records: urls.map((url, i) => ({ id: `rec${id.slice(3, 9)}${String(i).padStart(8, "0")}`, fields: { [`${id}L`]: url } })),
});
const url = (i) => `https://www.linkedin.com/in/person-${i}/`;
const DEX = source("tblDexDup00000001", "Dex Contacts", Array.from({ length: 12 }, (_, i) => url(i)));
// Half the same people, written the other ways a LinkedIn link turns up, plus a repeat.
const EVENT = source("tblEventDup000001", "Event list", [
  ...Array.from({ length: 6 }, (_, i) => url(i + 6).replace("https://www.", "http://").replace(/\/$/, "")),
  ...Array.from({ length: 6 }, (_, i) => `${url(i + 12)}?utm_source=share`),
  url(12),
]);
const LATE = source("tblLateDup0000001", "Late adds", [url(18), url(19)]);

async function setup() {
  sink.forgetTableState();
  const layout = [...structuredClone(BASANITE_TABLES), DEX, EVENT, LATE];
  const base = fakeBase({ baseId: BASE_ID, tables: layout.map((table) => ({ ...table, records: structuredClone(table.records || []) })) });
  const hooks = { onCreate: null };
  const fetch = async (input, init = {}) => {
    const u = String(input);
    if (init.method === "POST" && u.startsWith("https://api.airtable.com/") && hooks.onCreate) {
      const hook = hooks.onCreate;
      hooks.onCreate = null;
      await hook();
    }
    if (u.startsWith("https://api.airtable.com/") || u.startsWith("https://content.airtable.com/")) return base.handle(input, init);
    const id = new URL(u, "https://www.linkedin.com").searchParams.get("memberIdentity");
    if (id) return json({ elements: [profile(Number(id.split("-")[1]))] });
    const company = u.match(/companies\/(\d+)/)?.[1];
    if (company) return json({ elements: [{ entityUrn: `urn:li:fs_normalized_company:${company}`, universalName: `co-${company}`, name: `Co ${company}` }] });
    return json({});
  };
  const people = layout.find((table) => table.id === PEOPLE);
  const config = { token: "patTESTTOKEN.0123456789abcdef", userId: "usrME000000000001", baseId: BASE_ID, baseName: "Basanite",
    tableId: PEOPLE, tableName: "People", fields: people.fields, mapping: fieldsLib.suggestMapping(people.fields),
    linked: linkedLib.suggestLinked(layout, PEOPLE), baseTables: sink.summarizeTables(layout), schemaAt: Date.now(), stampValue: "Added By Branch" };
  const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };
  const worker = await bootWorker({ fetch, cookies, storage: { airtable_config: config } });
  return { base, worker, hooks };
}

async function enrich(worker, table) {
  const before = worker.store.get("bulk_enrich_job")?.id;
  const started = await worker.send({ type: "ENRICH_FROM_TABLE", tableId: table.id, fieldId: `${table.id}L` });
  assert.equal(started.error, undefined, started.error);
  for (let waited = 0; waited < 60_000; waited += 50) {
    const job = worker.store.get("bulk_enrich_job");
    if (job?.id !== before && ["complete", "error"].includes(job?.status)) {
      assert.equal(job.status, "complete", job.error);
      return job;
    }
    await sleep(50);
  }
  throw new Error(`${table.name} enrich never finished`);
}

const counts = (base) => Object.fromEntries([PEOPLE, COMPANIES, WORK, EDUCATION].map((id) => [id, base.rows(id).length]));
function assertOneEach(base) {
  const people = base.rows(PEOPLE).map((row) => fieldsLib.linkedinKey(row.fields[P_LINKEDIN]));
  assert.equal(new Set(people).size, people.length, `a person twice: ${people}`);
  const companies = base.rows(COMPANIES).map((row) => row.fields[C_NAME]);
  assert.equal(new Set(companies).size, companies.length, `a company twice: ${companies}`);
  for (const id of [WORK, EDUCATION]) {
    const rows = base.rows(id).map((row) => JSON.stringify(Object.entries(row.fields).sort()));
    assert.equal(new Set(rows).size, rows.length, `a ${id === WORK ? "job" : "school"} twice`);
  }
}

test("the same table enriched twice, then an overlapping one, then alongside another capture: one row each", async () => {
  const { base, worker, hooks } = await setup();
  try {
    const first = await enrich(worker, DEX);
    assert.equal(first.created, 12);
    assertOneEach(base);
    const once = counts(base);
    assert.deepEqual(once, { [PEOPLE]: 12, [COMPANIES]: 7, [WORK]: 24, [EDUCATION]: 3 });

    const again = await enrich(worker, DEX);
    assert.equal(again.created, 0);
    assert.deepEqual(counts(base), once, "a second run adds nothing anywhere");

    const event = await enrich(worker, EVENT);
    assert.equal(event.total, 12, "the repeat and the URL variants are one person each");
    assert.equal(event.created, 6);
    assertOneEach(base);
    assert.deepEqual(counts(base), { [PEOPLE]: 18, [COMPANIES]: 7, [WORK]: 36, [EDUCATION]: 3 });

    // Another capture adds the same new person and company while the enrich's first create is in flight.
    let other;
    hooks.onCreate = async () => {
      other = sink.writePeople([{ name: "Person 18", linkedinUrl: url(18),
        experience: [{ title: "T0", company: "Co 218", companyUrn: "urn:li:fsd_company:218", startDate: "2010-01" }] }]);
      await sleep(300);
    };
    await enrich(worker, LATE);
    assert.ok(other, "the other capture ran during the enrich's write");
    await other;
    assertOneEach(base);
    assert.deepEqual(counts(base), { [PEOPLE]: 20, [COMPANIES]: 9, [WORK]: 40, [EDUCATION]: 3 });
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    worker.restore();
  }
});
