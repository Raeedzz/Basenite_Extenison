/**
 * Mutuals: one row per undirected pair, lower record id as Person A, by field
 * id, typecast off, create-only. People's mutual columns are never written.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BASANITE_TABLES, BASE_ID, P, PEOPLE, fakeBase, setup, sink, store } from "./helpers/image-harness.mjs";

const { MUTUALS: M, mutualsLine, mutualsReady, observedDate, recordMutuals } = await import("../lib/airtable-mutuals.js");
const { MUTUAL_PREFS_KEY, normalizeMutualPrefs } = await import("../lib/mutual-prefs.js");
const { bootWorker } = await import("./helpers/worker-harness.mjs");
const fieldsLib = await import("../lib/airtable-fields.js");
const linkedLib = await import("../lib/airtable-linked.js");

const AS_A = "fldSmJyqG1ROLeZ5m";
const AS_B = "fldsYeGqrMrfO7SK2";
const PEOPLE_MUTUAL_FIELDS = [AS_A, AS_B, "flddgRCs9VbWxKji7", "flddyk584U5NrcbU8", "fldia1w0Rr4dtKXnB", "fldlokd09HlvEKGKy"];
const NOTES = "fldkthUiSOavt8p3Q";

/** The real Basanite layout plus Mutuals and People's read-only mutual columns. */
function withMutuals(layout) {
  layout.find((table) => table.id === PEOPLE).fields.push(
    { id: AS_A, name: "Mutual links (as A)", type: "multipleRecordLinks", options: { linkedTableId: M.table, inverseLinkFieldId: M.personA } },
    { id: AS_B, name: "Mutual links (as B)", type: "multipleRecordLinks", options: { linkedTableId: M.table, inverseLinkFieldId: M.personB } },
    { id: "flddgRCs9VbWxKji7", name: "Mutuals via A", type: "multipleLookupValues" },
    { id: "flddyk584U5NrcbU8", name: "Mutuals via B", type: "multipleLookupValues" },
    { id: "fldia1w0Rr4dtKXnB", name: "Mutuals", type: "formula" },
    { id: "fldlokd09HlvEKGKy", name: "Mutual count", type: "formula" },
  );
  layout.push({
    id: M.table,
    name: "Mutuals",
    fields: [
      { id: M.pair, name: "Pair", type: "singleLineText" },
      { id: M.personA, name: "Person A", type: "multipleRecordLinks", options: { linkedTableId: PEOPLE, inverseLinkFieldId: AS_A } },
      { id: M.personB, name: "Person B", type: "multipleRecordLinks", options: { linkedTableId: PEOPLE, inverseLinkFieldId: AS_B } },
      { id: M.source, name: "Source", type: "singleSelect", options: { choices: ["LinkedIn", "Branch", "Manual", "Referral"].map((name) => ({ id: `sel${name}`, name })) } },
      { id: M.observed, name: "Observed date", type: "date" },
      { id: NOTES, name: "Notes", type: "multilineText" },
    ],
  });
  return layout;
}

const url = (slug) => `https://www.linkedin.com/in/${slug}`;
const row = (id, slug, name, extra = {}) => ({ id, fields: { [P.name]: name, [P.linkedin]: url(slug), ...extra } });
const MIA = "recMMM00000000001";
const ANN = "recAAA00000000001";
const ZOE = "recZZZ00000000001";
const PEOPLE_ROWS = [row(MIA, "mia", "Mia Target"), row(ANN, "ann", "Ann Early"), row(ZOE, "zoe", "Zoe Late")];
const bridge = (slug, name = `Bridge ${slug}`) => ({ name, headline: `Headline ${slug}`, linkedinUrl: url(slug), photoUrl: null });
const result = (bridges, { slug = "mia", name = "Mia Target" } = {}) => ({ linkedinUrl: url(slug), profile: name ? { name } : null, bridges });
// 03:30 UTC on the 29th is still the 28th in Chicago.
const NOW = new Date("2026-09-29T03:30:00Z");

const ready = (records = {}) => setup({ [PEOPLE]: PEOPLE_ROWS, ...records }, { tables: withMutuals });
const creates = (base) => base.log.filter((entry) => entry.path === `/v0/${BASE_ID}/${M.table}` && entry.method === "POST");
const peopleWrites = (base) => base.log.filter((entry) => entry.path === `/v0/${BASE_ID}/${PEOPLE}` && ["POST", "PATCH"].includes(entry.method));

test("new pairs: lower record id is Person A, exact fields, Branch, Chicago date, typecast off", async () => {
  const { base } = ready();
  const tally = await recordMutuals([result([bridge("ann", "Ann Early"), bridge("zoe", "Zoe Late")])], { now: NOW });
  assert.deepEqual(tally, { created: 2, existing: 0, skipped: 0, failed: 0 });
  const rows = base.rows(M.table).map((record) => record.fields);
  assert.deepEqual(rows, [
    { [M.pair]: "Ann Early <> Mia Target", [M.personA]: [ANN], [M.personB]: [MIA], [M.source]: "Branch", [M.observed]: "2026-09-28" },
    { [M.pair]: "Mia Target <> Zoe Late", [M.personA]: [MIA], [M.personB]: [ZOE], [M.source]: "Branch", [M.observed]: "2026-09-28" },
  ]);
  const [sent] = creates(base);
  assert.equal(creates(base).length, 1);
  assert.equal(sent.body.typecast, false);
  assert.equal(mutualsLine(tally), "Mutuals: 2 new, 0 already linked, 0 skipped (not in People)");
});

test("an existing pair either way round is left alone; running again creates nothing", async () => {
  const PAIR = "recPAIR0000000001";
  const { base } = ready({
    [PEOPLE]: [row(MIA, "mia", "Mia Target", { [AS_A]: [PAIR] }), row(ANN, "ann", "Ann Early", { [AS_B]: [PAIR] }), row(ZOE, "zoe", "Zoe Late")],
    // Stored the "wrong" way round, with a note: still the same pair.
    [M.table]: [{ id: PAIR, fields: { [M.pair]: "hand made", [M.personA]: [MIA], [M.personB]: [ANN], [M.source]: "Manual", [NOTES]: "met at YC" } }],
  });
  const first = await recordMutuals([result([bridge("ann"), bridge("zoe")])], { now: NOW });
  assert.deepEqual(first, { created: 1, existing: 1, skipped: 0, failed: 0 });
  const again = await recordMutuals([result([bridge("ann"), bridge("zoe")])], { now: NOW });
  assert.deepEqual(again, { created: 0, existing: 2, skipped: 0, failed: 0 });
  assert.equal(base.rows(M.table).length, 2);
  assert.deepEqual(base.rows(M.table)[0].fields, { [M.pair]: "hand made", [M.personA]: [MIA], [M.personB]: [ANN], [M.source]: "Manual", [NOTES]: "met at YC" });
  assert.ok(!base.log.some((entry) => entry.method === "PATCH" && entry.path.endsWith(M.table)));
});

test("two targets that are each other's mutual make one row", async () => {
  const { base } = ready();
  const tally = await recordMutuals([result([bridge("ann")]), result([bridge("mia")], { slug: "ann", name: "Ann Early" })], { now: NOW });
  assert.deepEqual(tally, { created: 1, existing: 1, skipped: 0, failed: 0 });
  assert.equal(base.rows(M.table).length, 1);
});

test("a mutual not in People is skipped with the setting off, and nobody is added", async () => {
  const { base } = ready();
  const tally = await recordMutuals([result([bridge("ann"), bridge("stranger")])], { now: NOW });
  assert.deepEqual(tally, { created: 1, existing: 0, skipped: 1, failed: 0 });
  assert.equal(base.rows(PEOPLE).length, 3);
});

test("with the setting on, the mutual is added to People the normal way, then paired", async () => {
  const { base } = ready();
  const tally = await recordMutuals([result([bridge("stranger", "Sam Stranger")])], { createPeople: true, now: NOW });
  assert.deepEqual(tally, { created: 1, existing: 0, skipped: 0, failed: 0 });
  const added = base.rows(PEOPLE).find((record) => fieldsLib.linkedinKey(record.fields[P.linkedin]) === "stranger");
  assert.equal(added.fields[P.name], "Sam Stranger");
  assert.equal(added.fields[P.headline], "Headline stranger");
  assert.deepEqual(added.fields[P.knownBy], [{ id: "usrME000000000001" }]);
  const [pair] = base.rows(M.table);
  assert.deepEqual([...pair.fields[M.personA], ...pair.fields[M.personB]].sort(), [MIA, added.id].sort());
});

test("a mutual already in People by a teammate (not in the local index) is found, not added", async () => {
  const { base } = ready();
  await sink.peopleRecordIds([url("mia")]);
  base.state.get(PEOPLE).records.set("recTEAM000000001", { id: "recTEAM000000001", fields: { [P.name]: "Tea Mate", [P.linkedin]: `${url("tea")}/` } });
  // An index read in the same millisecond is (rightly) taken as current.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const tally = await recordMutuals([result([bridge("tea")])], { createPeople: true, now: NOW });
  assert.deepEqual(tally, { created: 1, existing: 0, skipped: 0, failed: 0 });
  assert.equal(base.rows(PEOPLE).length, 4);
});

test("self-pairs are never made", async () => {
  const { base } = ready();
  const tally = await recordMutuals([result([bridge("mia"), bridge("ann")])], { now: NOW });
  assert.deepEqual(tally, { created: 1, existing: 0, skipped: 0, failed: 0 });
  assert.equal(base.rows(M.table).length, 1);
});

test("ten per request; one pair Airtable refuses is skipped and the rest land", async () => {
  const many = Array.from({ length: 12 }, (_, i) => row(`recB${String(i).padStart(13, "0")}`, `b${i}`, `B ${i}`));
  const { base } = ready({ [PEOPLE]: [...PEOPLE_ROWS, ...many] });
  await sink.peopleRecordIds([url("mia")]);
  // Deleted in Airtable after the index was read: linking to it is refused.
  base.state.get(PEOPLE).records.delete(many[3].id);
  const tally = await recordMutuals([result(many.map((_, i) => bridge(`b${i}`)))], { now: NOW });
  assert.deepEqual(tally, { created: 11, existing: 0, skipped: 0, failed: 1 });
  assert.equal(base.rows(M.table).length, 11);
  assert.ok(creates(base).every((entry) => entry.body.records.length <= 10));
});

test("no name from LinkedIn: the Pair label uses the People row's name", async () => {
  const { base } = ready();
  await recordMutuals([result([bridge("ann", "")], { name: null })], { now: NOW });
  assert.equal(base.rows(M.table)[0].fields[M.pair], "Ann Early <> Mia Target");
});

test("People's mutual columns are never written, and a base without Mutuals gets nothing", async () => {
  const { base } = ready();
  await recordMutuals([result([bridge("ann"), bridge("stranger")])], { createPeople: true, now: NOW });
  for (const entry of peopleWrites(base)) {
    for (const record of entry.body.records) assert.ok(!PEOPLE_MUTUAL_FIELDS.some((id) => id in record.fields), JSON.stringify(record.fields));
  }
  const bare = setup({ [PEOPLE]: PEOPLE_ROWS });
  assert.equal(await recordMutuals([result([bridge("ann")])], { now: NOW }), null);
  assert.equal(creates(bare.base).length, 0);
});

test("mutualsReady wants every column, both people linking to People", () => {
  const layout = sink.summarizeTables(withMutuals(structuredClone(BASANITE_TABLES)));
  assert.equal(mutualsReady(layout, PEOPLE), true);
  assert.equal(mutualsReady(layout, "tblSOMEOTHERPEOPL"), false);
  const noDate = structuredClone(layout);
  noDate.find((table) => table.id === M.table).fields = noDate.find((table) => table.id === M.table).fields.filter((field) => field.id !== M.observed);
  assert.equal(mutualsReady(noDate, PEOPLE), false);
});

test("observed date is Chicago's; prefs default to 50 and off", () => {
  assert.equal(observedDate(new Date("2026-01-15T05:59:00Z")), "2026-01-14");
  assert.equal(observedDate(new Date("2026-01-15T06:00:00Z")), "2026-01-15");
  assert.deepEqual(normalizeMutualPrefs(undefined), { maxPerProfile: 50, createPeople: false });
  assert.deepEqual(normalizeMutualPrefs({ maxPerProfile: 9999, createPeople: "yes" }), { maxPerProfile: 500, createPeople: false });
  assert.deepEqual(normalizeMutualPrefs({ maxPerProfile: 0, createPeople: true }), { maxPerProfile: 1, createPeople: true });
});

// ─── Worker: Find mutuals end to end ─────────────────────────────────────────

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };

async function findMutuals(prefs) {
  const layout = withMutuals(structuredClone(BASANITE_TABLES));
  const base = fakeBase({ baseId: BASE_ID, tables: layout.map((table) => ({ ...table, records: [] })) });
  const people = layout.find((table) => table.id === PEOPLE);
  const searches = [];
  const fetchImpl = async (input, init) => {
    const target = String(input);
    if (target.startsWith("https://api.airtable.com/")) return base.handle(input, init);
    if (target.includes("/search/dash/clusters")) {
      const page = searches.push(target) - 1;
      const items = Array.from({ length: 49 }, (_, i) => ({ item: { entityResult: {
        title: { text: `Bridge ${page}-${i}` }, navigationUrl: url(`bridge-${page}-${i}`), entityUrn: `urn:${page}-${i}` } } }));
      return json({ metadata: { totalResultCount: 900 }, elements: [{ items }] });
    }
    return json({ elements: [{ entityUrn: "urn:li:fsd_profile:ACoAAbig", publicIdentifier: "target-big", firstName: "Big", lastName: "Target" }] });
  };
  // The lib modules outlive a worker boot here; a real worker restart starts clean.
  sink.forgetTableState();
  const worker = await bootWorker({ fetch: fetchImpl, cookies, storage: {
    ...(prefs ? { [MUTUAL_PREFS_KEY]: prefs } : {}),
    airtable_config: {
      token: "patTESTTOKEN.0123456789abcdef", userId: "usrME000000000001",
      baseId: BASE_ID, baseName: "Basanite", tableId: PEOPLE, tableName: "People", fields: people.fields,
      mapping: fieldsLib.suggestMapping(people.fields), linked: linkedLib.suggestLinked(layout, PEOPLE),
      baseTables: sink.summarizeTables(layout), schemaAt: Date.now(),
    },
  } });
  try {
    const started = await worker.send({ type: "START_MUTUAL_FINDING", contacts: [{ linkedinUrl: url("target-big") }] });
    assert.equal(started.started, true, JSON.stringify(started));
    for (let i = 0; i < 1000 && worker.store.get("mutual_progress")?.status !== "complete"; i++) await new Promise((r) => setTimeout(r, 10));
    return { base, searches, progress: worker.store.get("mutual_progress") };
  } finally {
    worker.restore();
  }
}

test("worker: default cap of 50 stops LinkedIn paging, and the summary says who was skipped", async () => {
  const { base, searches, progress } = await findMutuals(null);
  assert.equal(progress?.status, "complete", JSON.stringify(progress));
  assert.equal(searches.length, 2);
  assert.equal(progress.message, "Mutuals: 0 new, 0 already linked, 50 skipped (not in People)");
  assert.equal(base.rows(PEOPLE).length, 1);
  assert.equal(base.rows(M.table).length, 0);
});

test("worker: create People on, cap 5: five new People, five pairs", async () => {
  const { base, searches, progress } = await findMutuals({ maxPerProfile: 5, createPeople: true });
  assert.equal(progress?.status, "complete", JSON.stringify(progress));
  assert.equal(searches.length, 1);
  assert.equal(progress.message, "Mutuals: 5 new, 0 already linked, 0 skipped (not in People)");
  assert.equal(base.rows(PEOPLE).length, 6);
  assert.equal(base.rows(M.table).length, 5);
  assert.ok(base.rows(M.table).every((record) => record.fields[M.personA][0] < record.fields[M.personB][0]));
});
