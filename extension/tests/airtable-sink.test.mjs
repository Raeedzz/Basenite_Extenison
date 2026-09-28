/**
 * The sink against a fake Airtable: matching, change detection, failure
 * isolation, and the import protocol the capture engine drives.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { airtableConfig, fakeAirtable } from "./helpers/fake-airtable.mjs";

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
const api = await import("../lib/api-client.js");

function setup(options = {}) {
  store.clear();
  store.set("airtable_config", airtableConfig());
  sink.forgetTableState();
  const airtable = fakeAirtable(options);
  globalThis.fetch = airtable.handle;
  return airtable;
}

const person = (slug, extra = {}) => ({
  name: `Person ${slug}`,
  bio: `Headline ${slug}`,
  linkedinUrl: `https://www.linkedin.com/in/${slug}`,
  ...extra,
});

test("new people are created, and a second identical write sends nothing", async () => {
  const airtable = setup();
  const first = await sink.writePeople([person("a"), person("b")], { source: "LinkedIn connection", degree: "1st" });
  assert.equal(first.created, 2);
  assert.equal(first.accepted, 2);
  const rows = airtable.byLinkedIn();
  assert.equal(rows.get("https://www.linkedin.com/in/a").fields.fldName, "Person a");
  assert.equal(rows.get("https://www.linkedin.com/in/a").fields.fldSource, "LinkedIn connection");
  assert.equal(rows.get("https://www.linkedin.com/in/a").fields.fldDegree, "1st");

  const writesBefore = airtable.writes().length;
  const second = await sink.writePeople([person("a"), person("b")], { source: "LinkedIn connection" });
  assert.equal(second.unchanged, 2);
  assert.equal(airtable.writes().length, writesBefore, "an unchanged network cost Airtable requests");
});

test("someone already in the table is filled in, not duplicated, and keeps their source", async () => {
  const airtable = setup({
    records: [{ id: "recEXISTING000001", fields: { fldLinkedIn: "linkedin.com/in/Ada/", fldName: "Ada L.", fldSource: "Referral" } }],
  });
  const tally = await sink.writePeople([person("ada", {
    headline: "Analyst", experience: [{ title: "Analyst", company: "Engines", isCurrent: true }],
  })], { source: "Company: Engines" });
  assert.equal(tally.updated, 1);
  assert.equal(tally.created, 0);
  assert.equal(airtable.table.records.size, 1);
  const row = airtable.table.records.get("recEXISTING000001");
  assert.equal(row.fields.fldLinkedIn, "linkedin.com/in/Ada/", "the URL someone typed was rewritten");
  assert.equal(row.fields.fldSource, "Referral");
  assert.equal(row.fields.fldCompany, "Engines");
  // Name is fill-if-blank: what someone typed stays.
  assert.equal(row.fields.fldName, "Ada L.");
});

test("a cell edited by hand stays until LinkedIn's own value changes", async () => {
  const airtable = setup();
  await sink.writePeople([person("a")]);
  const [row] = airtable.table.records.values();
  row.fields.fldHeadline = "Edited in Airtable";
  await sink.writePeople([person("a")]);
  assert.equal(row.fields.fldHeadline, "Edited in Airtable");
  await sink.writePeople([person("a", { bio: "New headline" })]);
  assert.equal(row.fields.fldHeadline, "New headline");
});

test("one bad row fails alone, and a row deleted in Airtable is recreated", async () => {
  const airtable = setup();
  const rows = Array.from({ length: 12 }, (_, i) => person(`p${i}`, i === 3 ? { bio: "REJECT-ME" } : {}));
  const tally = await sink.writePeople(rows);
  assert.equal(tally.created, 11);
  assert.equal(tally.failed, 1);
  assert.match(tally.errors[0], /rejected/);

  const victim = airtable.byLinkedIn().get("https://www.linkedin.com/in/p0");
  airtable.table.records.delete(victim.id);
  const again = await sink.writePeople([person("p0", { bio: "Changed" })]);
  assert.equal(again.created, 1);
  assert.equal(airtable.byLinkedIn().get("https://www.linkedin.com/in/p0").fields.fldHeadline, "Changed");
});

test("rate limits and server errors are waited out", async () => {
  const airtable = setup();
  airtable.failures.push(429, 503);
  const tally = await sink.writePeople([person("a")]);
  assert.equal(tally.created, 1);
});

test("a bad token stops the write with a clear reason", async () => {
  const airtable = setup();
  airtable.failures.push(401);
  await assert.rejects(sink.writePeople([person("a")]), /rejected the token/);
});

test("unconfigured, nothing is written and the reason names the fix", async () => {
  setup();
  store.set("airtable_config", airtableConfig({ mapping: { name: "fldName" } }));
  assert.equal(await api.getToken(), null);
  await assert.rejects(sink.writePeople([person("a")]), /LinkedIn URL column/);
});

test("the import protocol counts, replays, and reports gaps the way the engine expects", async () => {
  const airtable = setup();
  const { import: opened } = await api.createPeopleImport({
    expectedRows: 3,
    clientImportKey: "key-1",
    sourceCursor: { mode: "linkedin_network_connections", syncMode: "full", nextSequence: 0 },
  });
  assert.equal(opened.status, "open");

  const again = await api.createPeopleImport({ expectedRows: 3, clientImportKey: "key-1" });
  assert.equal(again.import.id, opened.id);
  await assert.rejects(api.createPeopleImport({ expectedRows: 4, clientImportKey: "key-1" }), (error) => error.status === 409);

  const chunk1 = await api.putPeopleImportChunk(opened.id, 1, [person("c")]);
  assert.equal(chunk1.chunk.accepted, 1);
  let status = await api.getPeopleImportStatus(opened.id);
  assert.equal(status.nextExpectedSequence, 0, "a gap at 0 must be reported");
  assert.deepEqual(status.receivedSequences, [1]);

  const chunk0 = await api.putPeopleImportChunk(opened.id, 0, [person("a"), { name: "LinkedIn Member", linkedinUrl: "" }]);
  assert.equal(chunk0.chunk.accepted, 1);
  assert.equal(chunk0.chunk.failed, 1);
  const writes = airtable.writes().length;
  const replay = await api.putPeopleImportChunk(opened.id, 0, [person("a")]);
  assert.equal(replay.chunk.replayed, true);
  assert.equal(airtable.writes().length, writes);

  status = await api.getPeopleImportStatus(opened.id);
  assert.equal(status.nextExpectedSequence, 2);
  const { import: done } = await api.completePeopleImport(opened.id);
  assert.equal(done.status, "complete");
  assert.equal(done.accepted, 2);
  assert.equal(done.failed, 1);
  await assert.rejects(api.getPeopleImportStatus("nope"), (error) => error.status === 404);
});

test("the soft-sync check knows exactly who already has a row", async () => {
  setup({ records: [{ fields: { fldLinkedIn: "https://www.linkedin.com/in/known" } }] });
  const { known } = await api.softSyncCheck([
    { linkedinUrl: "https://www.linkedin.com/in/known" },
    { linkedinUrl: "https://www.linkedin.com/in/new" },
    { linkedinUrl: "" },
  ]);
  assert.deepEqual(known, [true, false, false]);
});

test("mutual and company captures land on the right rows", async () => {
  const airtable = setup();
  await api.captureMutualConnections([{
    linkedinUrl: "https://www.linkedin.com/in/target",
    connectionDegree: "2nd",
    profile: { name: "Target Person", headline: "Partner" },
    bridges: [{ name: "Grace", linkedinUrl: "https://www.linkedin.com/in/grace" }],
    totalBridges: 1,
  }]);
  const target = airtable.byLinkedIn().get("https://www.linkedin.com/in/target");
  assert.equal(target.fields.fldMutualCount, 1);
  assert.equal(target.fields.fldDegree, "2nd");
  assert.equal(target.fields.fldSource, "Mutual finder");

  const result = await api.captureCompanyPeople({ company: "Acme", people: [person("acme-1"), person("acme-2")] });
  assert.equal(result.accepted, 2);
  assert.equal(airtable.byLinkedIn().get("https://www.linkedin.com/in/acme-1").fields.fldSource, "Company: Acme");
});
