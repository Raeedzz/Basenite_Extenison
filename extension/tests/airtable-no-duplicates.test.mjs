/**
 * Sync as often as you like, never a duplicate. Every table in a strict fake
 * of Basanite OS — Live is checked for one row per real person, company,
 * school, and job after repeated syncs and after every way a write can go
 * wrong halfway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeName, suggestMapping } from "../lib/airtable-fields.js";
import { suggestLinked } from "../lib/airtable-linked.js";
import { summarizeTables } from "../lib/airtable-sink.js";
import { BASE_ID, fakeBase } from "./helpers/fake-airtable.mjs";
import { BASANITE_TABLES, COMPANIES, EDUCATION, PEOPLE, WORK } from "./helpers/basanite-base.mjs";

const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.map((key) => [key, store.get(key)]));
      },
      async set(next) { for (const [key, value] of Object.entries(next)) store.set(key, value); },
      async remove(keys) { for (const key of [].concat(keys)) store.delete(key); },
    },
  },
};

const sink = await import("../lib/airtable-sink.js");
const linkedSync = await import("../lib/airtable-linked-sync.js");

const P_LINKEDIN = "fldvyrmtV2q06ip6k";
const C_NAME = "fldzBJ1c98Y5wviTm";
const E_NAME = "fldk389mX9pLnMj62";
const W = { title: "fldXwAfDqpN13BSwM", company: "flduTDvxs0L1eWyWD", person: "fldjmSvXmRCd98JMk", start: "fldfsvlMrvrGJCdFA" };

function setup() {
  store.clear();
  sink.forgetTableState();
  const base = fakeBase({ baseId: BASE_ID, tables: BASANITE_TABLES.map((table) => ({ ...table, records: [] })) });
  globalThis.fetch = base.handle;
  const people = BASANITE_TABLES.find((table) => table.id === PEOPLE);
  store.set("airtable_config", {
    token: "patTESTTOKEN.0123456789abcdef",
    baseId: BASE_ID,
    tableId: PEOPLE,
    tableName: "People",
    fields: people.fields,
    mapping: suggestMapping(people.fields),
    stampValue: "Added By Branch",
    linked: suggestLinked(BASANITE_TABLES, PEOPLE),
    linkedChosen: true,
    baseTables: summarizeTables(BASANITE_TABLES),
    schemaAt: Date.now(),
  });
  linkedSync.setCompanyDetailsProvider(async (id) => ({
    universalName: `co-${id}`, name: `Company ${id}`, about: `About ${id}.`, website: "", industry: "Software", logoUrl: "",
  }));
  return base;
}

/** A small network: people who share companies and schools. */
function person(n, extra = {}) {
  return {
    name: `Person ${n}`,
    headline: `Role ${n}`,
    linkedinUrl: `https://www.linkedin.com/in/person-${n}`,
    memberId: `ACoAA${n}`,
    experience: [
      { title: "Partner", company: `Company ${n % 3}`, companyUrn: `urn:li:fsd_company:${n % 3}`, startDate: "2022-01", isCurrent: true },
      { title: "Analyst", company: "Company 9", companyUrn: "urn:li:fsd_company:9", startDate: "2015-06", endDate: "2019-01", isCurrent: false },
    ],
    education: [{ school: `School ${n % 2}`, schoolUrn: `urn:li:fsd_school:${n % 2}` }],
    _earthosEnrichment: { status: "complete" },
    ...extra,
  };
}

/** Throws unless every table holds exactly one row per real thing. */
function assertNoDuplicates(base) {
  const once = (label, values) => {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    const dupes = [...counts].filter(([, count]) => count > 1);
    assert.deepEqual(dupes, [], `${label} has duplicates`);
  };
  once("People", base.rows(PEOPLE).map((row) => String(row.fields[P_LINKEDIN]).toLowerCase().replace(/\/$/, "")));
  once("Companies", base.rows(COMPANIES).map((row) => normalizeName(row.fields[C_NAME])));
  once("Education", base.rows(EDUCATION).map((row) => normalizeName(row.fields[E_NAME])));
  once("Work history", base.rows(WORK).map((row) => [row.fields[W.person]?.[0], row.fields[W.company]?.[0], normalizeName(row.fields[W.title]), row.fields[W.start]].join("|")));
}

test("the same network synced ten times over: one row per person, company, school, and job", async () => {
  const base = setup();
  const network = Array.from({ length: 12 }, (_, n) => person(n));
  for (let run = 0; run < 10; run++) {
    // Connection rows (no profile), then full profiles, like a real sync.
    await sink.writePeople(network.map(({ experience, education, _earthosEnrichment, ...base }) => base));
    await sink.writePeople(network);
    // And the same people again from other captures, in odd batch shapes.
    await sink.writePeople([network[3], network[3], network[7]], { source: "Bulk enrich" });
  }
  assertNoDuplicates(base);
  assert.equal(base.rows(PEOPLE).length, 12);
  assert.equal(base.rows(COMPANIES).length, 4);
  assert.equal(base.rows(EDUCATION).length, 2);
  assert.equal(base.rows(WORK).length, 24);
});

test("a create that saved but answered 500 isn't sent twice", async () => {
  const base = setup();
  base.faults.saveThenFail = 1;
  await sink.writePeople([person(1), person(2)]).catch(() => {});
  // Whatever happened, the next run reconciles instead of duplicating.
  await sink.writePeople([person(1), person(2)]);
  assertNoDuplicates(base);
  assert.equal(base.rows(PEOPLE).length, 2);
});

test("a failed linked-table create is re-read before the retry", async () => {
  const base = setup();
  await sink.writePeople([person(1)]);
  // The next create anywhere (a new company for person 5) lands, then 500s.
  base.faults.saveThenFail = 1;
  await assert.rejects(sink.writePeople([person(5)]), /saved, then failed|Airtable/);
  await sink.writePeople([person(5)]);
  assertNoDuplicates(base);
});

test("a write cut off before the extension recorded it doesn't duplicate on the next run", async () => {
  const base = setup();
  await sink.writePeople([person(1), person(2)]);
  // Worst case: the rows landed, the marker says a write was open, and the
  // extension's own memory of them is gone (worker killed mid-write).
  store.set("airtable_write_open", Date.now());
  for (const key of [...store.keys()]) {
    if (key.startsWith("airtable_rows") && !key.endsWith(":meta")) store.delete(key);
    if (key.startsWith("airtable_linked") && !key.endsWith(":meta")) store.delete(key);
  }
  sink.forgetTableState();
  await sink.writePeople([person(1), person(2), person(3)]);
  assertNoDuplicates(base);
  assert.equal(base.rows(PEOPLE).length, 3);
  assert.equal(store.get("airtable_write_open"), undefined);
});

test("one new company reached two ways in one batch is one row", async () => {
  const base = setup();
  linkedSync.setCompanyDetailsProvider(async (id) => ({ universalName: "engines-ltd", name: "Engines Ltd", about: "", website: "", industry: "", logoUrl: "" }));
  await sink.writePeople([
    person(1, { experience: [{ title: "CEO", company: "Engines Ltd", companyUrn: "urn:li:fsd_company:77", startDate: "2020-01", isCurrent: true }] }),
    person(2, { experience: [{ title: "CTO", company: "Engines Ltd", startDate: "2021-01", isCurrent: true }] }),
  ]);
  assert.equal(base.rows(COMPANIES).length, 1);
  const [company] = base.rows(COMPANIES);
  assert.ok(base.rows(WORK).every((row) => row.fields[W.company][0] === company.id));
});

test("a title edited on LinkedIn updates its job; two jobs starting together stay two", async () => {
  const base = setup();
  const before = person(1);
  await sink.writePeople([before]);
  const retitled = { ...before, experience: [{ ...before.experience[0], title: "Managing Partner" }, before.experience[1]] };
  await sink.writePeople([retitled]);
  assert.equal(base.rows(WORK).length, 2, "an edited title became a second job");
  assert.ok(base.rows(WORK).some((row) => row.fields[W.title] === "Managing Partner"));
  assert.ok(!base.rows(WORK).some((row) => row.fields[W.title] === "Partner"));

  const twoAtOnce = {
    ...before,
    linkedinUrl: "https://www.linkedin.com/in/person-2",
    memberId: "ACoAA2",
    experience: [
      { title: "Advisor", company: "Company 9", companyUrn: "urn:li:fsd_company:9", startDate: "2023-03", isCurrent: true },
      { title: "Board Member", company: "Company 9", companyUrn: "urn:li:fsd_company:9", startDate: "2023-03", isCurrent: true },
    ],
  };
  await sink.writePeople([twoAtOnce]);
  await sink.writePeople([twoAtOnce]);
  const mine = base.rows(WORK).filter((row) => ["Advisor", "Board Member"].includes(row.fields[W.title]));
  assert.equal(mine.length, 2);
  assertNoDuplicates(base);
});

test("a changed profile URL is the same person, found by LinkedIn member id", async () => {
  const base = setup();
  await sink.writePeople([person(1)]);
  await sink.writePeople([person(1, { linkedinUrl: "https://www.linkedin.com/in/person-one-new" })]);
  assert.equal(base.rows(PEOPLE).length, 1, "a new vanity URL made a second person");
  assertNoDuplicates(base);
});

test("a company deleted in Airtable doesn't turn the next update into a second person", async () => {
  const base = setup();
  await sink.writePeople([person(1)]);
  const [company] = base.rows(COMPANIES).filter((row) => row.fields[C_NAME] === "Company 1");
  base.state.get(COMPANIES).records.delete(company.id);
  // A new job means the person's links change inside the index's 24h window.
  const moved = person(1, { headline: "New role", experience: [...person(1).experience,
    { title: "Board", company: "Company 2", companyUrn: "urn:li:fsd_company:2", startDate: "2024-01", isCurrent: true }] });
  await sink.writePeople([moved]);
  assert.equal(base.rows(PEOPLE).length, 1, "a refused link recreated the person");
  assert.equal(base.rows(PEOPLE)[0].fields["fld3BmFW5JllGAygg"], "New role", "the rest of the update was lost");
  // Next write re-reads the linked tables and gets the links right.
  await sink.writePeople([moved]);
  assertNoDuplicates(base);
});

test("the member id survives updates and a worker restart", async () => {
  const base = setup();
  await sink.writePeople([person(1)]);
  await sink.writePeople([person(1, { headline: "Changed" })]);
  sink.forgetTableState();
  await sink.writePeople([person(1, { linkedinUrl: "https://www.linkedin.com/in/person-one-renamed" })]);
  assert.equal(base.rows(PEOPLE).length, 1);
});

test("a write that fails partway still records the companies it created", async () => {
  const base = setup();
  // Company 1 is created with blanks, so a later sync will try to fill them.
  linkedSync.setCompanyDetailsProvider(async () => null);
  await sink.writePeople([person(1)]);
  linkedSync.setCompanyDetailsProvider(async (id) => ({ universalName: `co-${id}`, name: `Company ${id}`, about: `About ${id}.`, website: "", industry: "", logoUrl: "" }));
  store.delete("linkedin_company_details");
  sink.forgetTableState();
  // Person 2 creates Company 2, then the fill-blank patch on Company 1 is refused.
  const handle = base.handle;
  let refused = false;
  globalThis.fetch = async (input, init = {}) => {
    if ((init.method || "GET") === "PATCH" && String(input).includes(COMPANIES) && !refused) {
      refused = true;
      return new Response(JSON.stringify({ error: { type: "INVALID_PERMISSIONS", message: "nope" } }), { status: 403, headers: { "content-type": "application/json" } });
    }
    return handle(input, init);
  };
  await assert.rejects(sink.writePeople([person(1), person(2)]));
  globalThis.fetch = handle;
  assert.ok(refused, "the scenario never reached the company patch");
  sink.forgetTableState();
  await sink.writePeople([person(1), person(2)]);
  assertNoDuplicates(base);
});

test("a company cell filled by hand since the index was read is left alone", async () => {
  const base = setup();
  linkedSync.setCompanyDetailsProvider(async () => null);
  await sink.writePeople([person(1)]);
  const row = base.rows(COMPANIES).find((candidate) => candidate.fields[C_NAME] === "Company 1");
  row.fields.fldCLrrYTiMG8nrxo = "Written by hand.";
  linkedSync.setCompanyDetailsProvider(async (id) => ({ universalName: `co-${id}`, name: `Company ${id}`, about: "From LinkedIn.", website: "", industry: "", logoUrl: "" }));
  store.delete("linkedin_company_details");
  sink.forgetTableState();
  await sink.writePeople([person(4)]);
  assert.equal(row.fields.fldCLrrYTiMG8nrxo, "Written by hand.");
});

test("an existing person's hand-typed Title is kept; a blank one is filled", async () => {
  const base = setup();
  base.state.get(PEOPLE).records.set("recHANDTYPED00001", { id: "recHANDTYPED00001", fields: {
    [P_LINKEDIN]: "https://www.linkedin.com/in/person-1", fldqwePau2SiMdzzW: "Person One (hand)",
  } });
  const config = store.get("airtable_config");
  const titleField = { id: "fldPeopleTitle001", name: "Title", type: "singleLineText" };
  base.state.get(PEOPLE).fields.push(titleField);
  store.set("airtable_config", { ...config, fields: [...config.fields, titleField], mapping: { ...config.mapping, title: titleField.id } });
  base.state.get(PEOPLE).records.get("recHANDTYPED00001").fields[titleField.id] = "Chief Everything";
  await sink.writePeople([person(1), person(2)]);
  assert.equal(base.state.get(PEOPLE).records.get("recHANDTYPED00001").fields[titleField.id], "Chief Everything");
  const two = base.rows(PEOPLE).find((row) => row.fields[P_LINKEDIN] === "https://www.linkedin.com/in/person-2");
  assert.equal(two.fields[titleField.id], "Partner");
});

test("Network is written, follows a new connection, and a hand-set value stays", async () => {
  const base = setup();
  const network = { id: "fldPeopleNetwork1", name: "Network", type: "singleSelect", options: { choices: [] } };
  base.state.get(PEOPLE).fields.push(network);
  const config = store.get("airtable_config");
  store.set("airtable_config", { ...config, fields: [...config.fields, network], mapping: { ...config.mapping, inNetwork: network.id } });
  const cell = (n) => base.rows(PEOPLE).find((row) => row.fields[P_LINKEDIN] === `https://www.linkedin.com/in/person-${n}`).fields[network.id];

  await sink.writePeople([person(1), person(2)], { degree: "1st" });
  await sink.writePeople([person(3, { degree: "2nd" }), person(4, { degree: "3rd" })]);
  assert.equal(cell(1), "In network");
  assert.equal(cell(3), "Outside network");

  // Person 3 accepts your invitation: the next sync sees them as 1st degree.
  await sink.writePeople([person(3, { degree: "1st" })]);
  assert.equal(cell(3), "In network");

  // A value someone typed by hand is theirs.
  base.rows(PEOPLE).find((row) => row.fields[P_LINKEDIN] === "https://www.linkedin.com/in/person-4").fields[network.id] = "VIP";
  sink.forgetTableState();
  await sink.writePeople([person(4, { degree: "1st" })]);
  assert.equal(cell(4), "VIP");
});
