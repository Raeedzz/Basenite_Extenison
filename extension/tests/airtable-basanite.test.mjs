/**
 * A full profile written into a strict fake of Basanite OS — Live, checked
 * against the mapping spec: find-or-create order, fill-if-blank, additive
 * links, create-only marker, blank-only referrer, and the tables and columns
 * that must never be touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { suggestMapping } from "../lib/airtable-fields.js";
import { suggestLinked } from "../lib/airtable-linked.js";
import { summarizeTables } from "../lib/airtable-sink.js";
import { BASE_ID, fakeBase } from "./helpers/fake-airtable.mjs";
import { BASANITE_TABLES, COMPANIES, EDUCATION, PEOPLE, ROLES, WORK } from "./helpers/basanite-base.mjs";

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

const P = {
  name: "fldqwePau2SiMdzzW",
  linkedin: "fldvyrmtV2q06ip6k",
  headline: "fld3BmFW5JllGAygg",
  location: "fldmJANiFBbhvmlDf",
  workedAt: "flddIyGX4W7BKfj19",
  education: "fldSPy2fWWELX0wKZ",
  currentCompany: "fldbic0J90xFTmFJn",
  review: "fldxnxDdEM3pbrs6X",
  knownBy: "fldC0cY3rR5dWzKB9",
  referredBy: "fldmzPV4cmQLf8KV2",
};
const C = { name: "fldzBJ1c98Y5wviTm", linkedin: "fldrtMFdA0cHj9Aeh", about: "fldCLrrYTiMG8nrxo", website: "fldTxY46iThubn8HK", sector: "fldxYiGlqXGXlsPV0" };
const W = { title: "fldXwAfDqpN13BSwM", company: "flduTDvxs0L1eWyWD", person: "fldjmSvXmRCd98JMk", timeframe: "fldYPAJskFkfTScdy",
  start: "fldfsvlMrvrGJCdFA", end: "fldC4oBixQUijH3HT", current: "fldtrGvHwTQlsAO7A", description: "fldxJuN6ScIhcneZq", location: "fldGS87PaAX4csC1l" };
const E = { name: "fldk389mX9pLnMj62", linkedin: "fldDqDzDWfQAYOxoS" };

// Columns the spec says are never written, on any table.
const NEVER = ["fldi7jFNhhkLJCLmV", "fld6F1WO8GBqO9TL7", "fldpst66YX7LQJK3R", "fldIRzEraQrrRWzCR",
  "fldSource00000001", "fldBasaniteId0001", "fldReviewState001", "fldCanonical00001", "fldSetupSample001",
  "fldL70B4fJbFB4tSy", "fldPKigKRaF2OZl7S", "fldzS7Pv9ocq6aueG", "fldeCDU9qwRMwyESH", "fldPyE13fnzRefyih",
  "fldnj4lQo4vBTAGws", "fldM8pfO1luPPGEXo", "fldMG4qXi0PD6vTHV", "flduR4OmOvSkSIuiP", "fldzReVjmXKu618yz"];

// A read sent as POST …/listRecords isn't a write.
const isWrite = (entry) => entry.method !== "GET" && !entry.path.endsWith("/listRecords");

const DETAILS = {
  4242: { universalName: "basanite", name: "Basanite", about: "Seed fund.", website: "https://basanite.com", industry: "Venture Capital", logoUrl: "" },
  77: { universalName: "engines-ltd", name: "Engines Ltd", about: "Makes engines.", website: "https://engines.example", industry: "Machinery", logoUrl: "" },
};

function setup(records = {}) {
  store.clear();
  sink.forgetTableState();
  const tables = BASANITE_TABLES.map((table) => ({ ...table, records: records[table.id] || [] }));
  const base = fakeBase({ baseId: BASE_ID, tables });
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
    userId: "usrME000000000001",
    userEmail: "raeed@basanite.com",
    baseName: "Basanite OS — Live",
    linked: suggestLinked(BASANITE_TABLES, PEOPLE),
    baseTables: summarizeTables(BASANITE_TABLES),
    schemaAt: Date.now(),
  });
  const asked = [];
  linkedSync.setCompanyDetailsProvider(async (id) => {
    asked.push(id);
    return DETAILS[id] || null;
  });
  return { base, asked };
}

const ADA = {
  name: "Ada Lovelace",
  headline: "Partner at Basanite",
  location: "New York",
  linkedinUrl: "https://www.linkedin.com/in/ada",
  experience: [
    { title: "Partner", company: "Basanite", companyUrn: "urn:li:fsd_company:4242", location: "New York",
      startDate: "2023-01", description: "Seed.", isCurrent: true },
    { title: "Principal", company: "Engines Ltd", companyUrn: "urn:li:fsd_company:77", startDate: "2020-01", endDate: "2022-12", isCurrent: false },
    { title: "Advisor", company: "No Page Co", startDate: "2017-05", endDate: "2019-01", isCurrent: false },
  ],
  education: [
    { school: "MIT", schoolUrn: "urn:li:fsd_school:5678", degree: "MBA" },
    { school: "Local College", degree: "BA" },
  ],
  _earthosEnrichment: { status: "complete" },
};

function sentFieldIds(base) {
  return new Set(base.log.filter((entry) => isWrite(entry))
    .flatMap((entry) => (entry.body?.records || []).flatMap((record) => Object.keys(record.fields || {}))));
}

test("a new person: companies, schools, and jobs found or created, then linked", async () => {
  const { base, asked } = setup({
    [COMPANIES]: [
      // Curated, with a LinkedIn page under its slug and a different name.
      { id: "recCOMPBASANITE01", fields: { [C.name]: "Basanite Capital", [C.linkedin]: "https://www.linkedin.com/company/basanite/" } },
      // Curated, no LinkedIn yet, About already written by hand.
      { id: "recCOMPENGINES001", fields: { [C.name]: "engines ltd ", [C.about]: "Curated about." } },
    ],
    [EDUCATION]: [{ id: "recSCHOOLLOCAL001", fields: { [E.name]: "Local College" } }],
  });
  const tally = await sink.writePeople([ADA], { source: "Profile capture" });
  assert.equal(tally.created, 1);

  // Companies: matched by slug (after asking LinkedIn) and by name; one new.
  const companies = base.rows(COMPANIES);
  assert.equal(companies.length, 3, "a curated company was duplicated");
  const basanite = base.state.get(COMPANIES).records.get("recCOMPBASANITE01").fields;
  assert.equal(basanite[C.name], "Basanite Capital", "an existing name was overwritten");
  assert.equal(basanite[C.about], "Seed fund.", "blank About was not filled");
  assert.equal(basanite[C.sector], "Venture Capital");
  const engines = base.state.get(COMPANIES).records.get("recCOMPENGINES001").fields;
  assert.equal(engines[C.about], "Curated about.", "a hand-written About was overwritten");
  assert.equal(engines[C.linkedin], "https://www.linkedin.com/company/engines-ltd", "blank LinkedIn was not filled");
  const noPage = companies.find((row) => row.fields[C.name] === "No Page Co");
  assert.ok(noPage, "a company with no LinkedIn page wasn't created");
  assert.equal(noPage.fields[C.linkedin], undefined);
  assert.deepEqual(asked.sort(), ["4242", "77"]);

  // Schools: MIT created with its page, Local College matched by name.
  const schools = base.rows(EDUCATION);
  assert.equal(schools.length, 2);
  const mit = schools.find((row) => row.fields[E.name] === "MIT");
  assert.equal(mit.fields[E.linkedin], "https://www.linkedin.com/school/5678");

  // The person: created with links, marker, no referrer.
  const [person] = base.rows(PEOPLE);
  assert.equal(person.fields[P.name], "Ada Lovelace");
  assert.equal(person.fields[P.review], "Added By Branch");
  assert.equal(person.fields[P.referredBy], undefined);
  assert.deepEqual(new Set(person.fields[P.workedAt]), new Set(["recCOMPBASANITE01", "recCOMPENGINES001", noPage.id]));
  assert.deepEqual(new Set(person.fields[P.education]), new Set([mit.id, "recSCHOOLLOCAL001"]));
  assert.deepEqual(person.fields[P.currentCompany], ["recCOMPBASANITE01"], "Current company isn't the current role's company");
  const personCreate = base.log.find((entry) => entry.method === "POST" && entry.path.endsWith(`/${PEOPLE}`));
  assert.equal(personCreate.body.typecast, false, "the marker went out with typecast on");

  // Jobs: one row each, linked both ways, dated.
  const jobs = base.rows(WORK);
  assert.equal(jobs.length, 3);
  const partner = jobs.find((row) => row.fields[W.title] === "Partner");
  assert.deepEqual(partner.fields[W.person], [person.id]);
  assert.deepEqual(partner.fields[W.company], ["recCOMPBASANITE01"]);
  assert.equal(partner.fields[W.start], "2023-01-01");
  assert.equal(partner.fields[W.end], undefined);
  assert.equal(partner.fields[W.current], true);
  assert.equal(partner.fields[W.timeframe], "2023-01 – present");
  const principal = jobs.find((row) => row.fields[W.title] === "Principal");
  assert.equal(principal.fields[W.end], "2022-12-01");
  assert.equal(principal.fields[W.current], false);

  // Never touched: the recruiting Roles table and every forbidden column.
  assert.equal(base.writes(ROLES).length, 0);
  const sent = sentFieldIds(base);
  for (const fieldId of NEVER) assert.equal(sent.has(fieldId), false, `${fieldId} was written`);
});

test("the same profile again costs no writes anywhere", async () => {
  const { base } = setup();
  await sink.writePeople([ADA]);
  const before = base.log.filter((entry) => isWrite(entry)).length;
  const tally = await sink.writePeople([ADA]);
  assert.equal(tally.unchanged, 1);
  assert.equal(base.log.filter((entry) => isWrite(entry)).length, before);
});

test("an existing person keeps what's theirs: name, review state, referrer, hand-made links", async () => {
  const { base } = setup({
    [COMPANIES]: [{ id: "recCOMPHANDMADE01", fields: { [C.name]: "Stealth Co" } }],
    [PEOPLE]: [{
      id: "recPERSONADA00001",
      fields: {
        [P.linkedin]: "linkedin.com/in/ada/",
        [P.name]: "Ada L.",
        [P.review]: "Sources checked",
        [P.referredBy]: "Jane Doe",
        [P.workedAt]: ["recCOMPHANDMADE01"],
        [P.currentCompany]: ["recCOMPHANDMADE01"],
      },
    }],
  });
  const tally = await sink.writePeople([{ ...ADA, referredBy: "Someone Else" }]);
  assert.equal(tally.created, 0);
  assert.equal(base.rows(PEOPLE).length, 1, "the existing person was duplicated");
  const fields = base.state.get(PEOPLE).records.get("recPERSONADA00001").fields;
  assert.equal(fields[P.name], "Ada L.");
  assert.equal(fields[P.review], "Sources checked", "the review state was changed on an existing person");
  assert.equal(fields[P.referredBy], "Jane Doe", "an existing referrer was overwritten");
  assert.equal(fields[P.location], "New York", "a blank Location wasn't filled");
  assert.equal(fields[P.headline], "Partner at Basanite", "Headline is the extension's and should update");
  assert.equal(fields[P.linkedin], "linkedin.com/in/ada/", "the match key was rewritten");
  assert.ok(fields[P.workedAt].includes("recCOMPHANDMADE01"), "a hand-made link was dropped");
  assert.equal(fields[P.workedAt].length, 4);
  assert.deepEqual(fields[P.currentCompany], ["recCOMPHANDMADE01"], "a hand-set Current company was replaced");
  // Jobs point at the existing person.
  assert.ok(base.rows(WORK).every((row) => row.fields[W.person][0] === "recPERSONADA00001"));
});

test("a known referrer fills a blank Referred By, and nothing is sent without one", async () => {
  const { base } = setup({
    [PEOPLE]: [{ id: "recPERSONBLANK001", fields: { [P.linkedin]: "https://www.linkedin.com/in/bo" } }],
  });
  await sink.writePeople([
    { name: "Bo", linkedinUrl: "https://www.linkedin.com/in/bo", referredBy: "Grace Hopper" },
    { name: "Cy", linkedinUrl: "https://www.linkedin.com/in/cy", referredBy: "Alan Turing" },
    { name: "Di", linkedinUrl: "https://www.linkedin.com/in/di" },
  ]);
  const byUrl = new Map(base.rows(PEOPLE).map((row) => [row.fields[P.linkedin], row.fields]));
  assert.equal(byUrl.get("https://www.linkedin.com/in/bo")[P.referredBy], "Grace Hopper");
  assert.equal(byUrl.get("https://www.linkedin.com/in/bo")[P.review], undefined, "the marker reached an existing person");
  assert.equal(byUrl.get("https://www.linkedin.com/in/cy")[P.referredBy], "Alan Turing");
  assert.equal(byUrl.get("https://www.linkedin.com/in/cy")[P.review], "Added By Branch");
  assert.equal(P.referredBy in byUrl.get("https://www.linkedin.com/in/di"), false);
});

test("a new job adds a row and leaves the old ones alone; nothing is ever deleted", async () => {
  const { base } = setup();
  await sink.writePeople([ADA]);
  const before = base.rows(WORK).length;
  const moved = {
    ...ADA,
    experience: [
      { title: "Managing Partner", company: "Basanite", companyUrn: "urn:li:fsd_company:4242", startDate: "2025-01", isCurrent: true },
      { ...ADA.experience[0], endDate: "2024-12", isCurrent: false },
      ADA.experience[1],
    ],
  };
  await sink.writePeople([moved]);
  const jobs = base.rows(WORK);
  assert.equal(jobs.length, before + 1);
  const partner = jobs.find((row) => row.fields[W.title] === "Partner");
  assert.equal(partner.fields[W.end], "2024-12-01");
  assert.equal(partner.fields[W.current], false);
  assert.ok(jobs.find((row) => row.fields[W.title] === "Advisor"), "a job gone from LinkedIn was removed");
});

test("company lookups report their progress while the write waits on them", async () => {
  setup();
  const seen = [];
  linkedSync.setLinkedProgressHook((event) => seen.push(event));
  try {
    await sink.writePeople([ADA]);
  } finally {
    linkedSync.setLinkedProgressHook(null);
  }
  // Two companies have LinkedIn pages to ask about; "No Page Co" doesn't.
  assert.deepEqual(seen.map(({ done, total }) => `${done}/${total}`), ["1/2", "2/2"]);
  assert.deepEqual(seen.map((event) => event.name).sort(), ["Basanite", "Engines Ltd"]);
});

test("a job change moves Current company, and only while the extension set it", async () => {
  const { base } = setup();
  await sink.writePeople([ADA]);
  const moved = {
    ...ADA,
    experience: [
      { title: "Principal", company: "Engines Ltd", companyUrn: "urn:li:fsd_company:77", startDate: "2025-01", isCurrent: true },
      { ...ADA.experience[0], endDate: "2024-12", isCurrent: false },
    ],
  };
  await sink.writePeople([moved]);
  const [person] = base.rows(PEOPLE);
  const engines = base.rows(COMPANIES).find((row) => row.fields[C.name] === "Engines Ltd");
  assert.deepEqual(person.fields[P.currentCompany], [engines.id]);
  // Between jobs: the last value stays; nothing is cleared.
  await sink.writePeople([{ ...ADA, experience: [{ ...moved.experience[0], endDate: "2025-06", isCurrent: false }] }]);
  assert.deepEqual(base.rows(PEOPLE)[0].fields[P.currentCompany], [engines.id]);
});

test("Known by: you on create; on existing people you're only ever added", async () => {
  const { base } = setup({
    [PEOPLE]: [
      { id: "recPERSONOTHERS01", fields: { [P.linkedin]: "https://www.linkedin.com/in/bo",
        [P.knownBy]: [{ id: "usrCOLLEAGUE00001", email: "sam@basanite.com", name: "Sam" }] } },
      { id: "recPERSONMINE0001", fields: { [P.linkedin]: "https://www.linkedin.com/in/cy",
        [P.knownBy]: [{ id: "usrME000000000001", email: "raeed@basanite.com", name: "Raeed" }] } },
    ],
  });
  await sink.writePeople([
    { name: "Bo", linkedinUrl: "https://www.linkedin.com/in/bo" },
    { name: "Cy", linkedinUrl: "https://www.linkedin.com/in/cy" },
    { name: "Di", linkedinUrl: "https://www.linkedin.com/in/di" },
  ]);
  const byUrl = new Map(base.rows(PEOPLE).map((row) => [row.fields[P.linkedin], row.fields]));
  assert.deepEqual(byUrl.get("https://www.linkedin.com/in/di")[P.knownBy], [{ id: "usrME000000000001" }]);
  assert.deepEqual(byUrl.get("https://www.linkedin.com/in/bo")[P.knownBy].map((user) => user.id),
    ["usrCOLLEAGUE00001", "usrME000000000001"], "someone already listed was dropped, or you weren't added");
  const sentToCy = base.log.some((entry) => entry.method === "PATCH"
    && entry.body.records.some((record) => record.id === "recPERSONMINE0001" && P.knownBy in record.fields));
  assert.equal(sentToCy, false, "Known by was sent though you were already in it");

  // Syncing again sends nothing for it.
  const writes = base.log.filter((entry) => isWrite(entry)).length;
  await sink.writePeople([
    { name: "Bo", linkedinUrl: "https://www.linkedin.com/in/bo" },
    { name: "Cy", linkedinUrl: "https://www.linkedin.com/in/cy" },
    { name: "Di", linkedinUrl: "https://www.linkedin.com/in/di" },
  ]);
  assert.equal(base.log.filter((entry) => isWrite(entry)).length, writes);
});

test("Known by uses the Syncing-as email when a shared token sets one", async () => {
  const { base } = setup();
  store.set("airtable_config", { ...store.get("airtable_config"), syncAsEmail: "sam@basanite.com" });
  await sink.writePeople([{ name: "Ed", linkedinUrl: "https://www.linkedin.com/in/ed" }]);
  assert.deepEqual(base.rows(PEOPLE)[0].fields[P.knownBy], [{ email: "sam@basanite.com" }]);
});

test("not a collaborator: the person is still written, Known by is skipped, and it isn't retried", async () => {
  const { base } = setup({
    [PEOPLE]: [{ id: "recPERSONEXIST001", fields: { [P.linkedin]: "https://www.linkedin.com/in/bo" } }],
  });
  base.faults.nonCollaborators.add("usrME000000000001");
  const tally = await sink.writePeople([
    { name: "Bo", headline: "Hi", linkedinUrl: "https://www.linkedin.com/in/bo" },
    { name: "Di", headline: "Hey", linkedinUrl: "https://www.linkedin.com/in/di" },
  ]);
  assert.equal(tally.created, 1);
  const byUrl = new Map(base.rows(PEOPLE).map((row) => [row.fields[P.linkedin], row.fields]));
  assert.equal(byUrl.get("https://www.linkedin.com/in/di")[P.name], "Di");
  assert.equal(P.knownBy in byUrl.get("https://www.linkedin.com/in/di"), false);
  assert.equal(byUrl.get("https://www.linkedin.com/in/bo")[P.headline], "Hi", "the rest of the update was lost");
  const config = store.get("airtable_config");
  assert.equal(config.knownByBlocked, true);
  assert.match(config.notice, /isn't a collaborator on Basanite OS — Live, so Known by can't be set/);

  const rejected = () => base.log.filter((entry) => isWrite(entry)
    && entry.body.records.some((record) => P.knownBy in record.fields)).length;
  const before = rejected();
  await sink.writePeople([{ name: "Fay", linkedinUrl: "https://www.linkedin.com/in/fay" }]);
  assert.equal(rejected(), before, "Known by was sent again after Airtable refused it");
});
