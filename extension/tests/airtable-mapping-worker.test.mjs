/**
 * Worker-level mapping and Known by: per-base block, fields left on Skip.
 */
import test from "node:test";
import assert from "node:assert/strict";
const { bootWorker } = await import("./helpers/worker-harness.mjs");
const { BASE_ID, TABLE_ID, fakeAirtable, fakeBase } = await import("./helpers/fake-airtable.mjs");
const { BASANITE_TABLES, PEOPLE } = await import("./helpers/basanite-base.mjs");
const fieldsLib = await import("../lib/airtable-fields.js");
const linkedLib = await import("../lib/airtable-linked.js");

const ME = "usrME000000000001";
const KNOWN_BY = "fldC0cY3rR5dWzKB9";
const B2 = "appSECONDBASE0001";

test("a Known by block stays with the base it happened on", async () => {
  const layout = () => structuredClone(BASANITE_TABLES).map((t) => ({ ...t, records: [] }));
  const base1 = fakeBase({ baseId: BASE_ID, tables: layout() });
  const base2 = fakeBase({ baseId: B2, tables: layout() });
  base1.faults.nonCollaborators.add(ME);
  const fetchImpl = async (input, init) => (String(input).includes(B2) ? base2 : base1).handle(input, init);
  const people = BASANITE_TABLES.find((t) => t.id === PEOPLE);
  const sink = await import("../lib/airtable-sink.js");
  const worker = await bootWorker({ fetch: fetchImpl, storage: { airtable_config: {
    token: "patTESTTOKEN.0123456789abcdef", userId: ME, userEmail: "me@example.com",
    bases: [{ id: BASE_ID, name: "Base one", permissionLevel: "create" }, { id: B2, name: "Base two", permissionLevel: "create" }],
    baseId: BASE_ID, baseName: "Base one", tableId: PEOPLE, tableName: "People", fields: people.fields,
    mapping: fieldsLib.suggestMapping(people.fields), linked: linkedLib.suggestLinked(BASANITE_TABLES, PEOPLE),
    baseTables: sink.summarizeTables(BASANITE_TABLES), schemaAt: Date.now(),
  } } });
  try {
    await sink.writePeople([{ name: "A", linkedinUrl: "https://www.linkedin.com/in/a" }]);
    assert.equal(worker.store.get("airtable_config").knownByBlocked, true, "precondition: blocked on base one");
    const answer = await worker.send({ type: "AIRTABLE_SELECT_TABLE", baseId: B2, tableId: PEOPLE });
    assert.equal(answer.error, undefined, answer.error);
    await sink.writePeople([{ name: "B", linkedinUrl: "https://www.linkedin.com/in/b" }]);
    const [row] = base2.rows(PEOPLE);
    assert.deepEqual((row.fields[KNOWN_BY] || []).map((u) => u.id), [ME], "Base two row has no Known by; block stuck from Base one");
  } finally {
    worker.restore();
  }
});

test("a field left on Skip in the panel stays unmapped after a refresh", async () => {
  const fields = [
    { id: "fldName", name: "Name", type: "singleLineText" },
    { id: "fldLinkedIn", name: "LinkedIn", type: "url" },
    { id: "fldRoles", name: "Roles", type: "singleLineText" },
    { id: "fldTitle", name: "Title", type: "singleLineText" },
  ];
  const airtable = fakeAirtable({ fields });
  const worker = await bootWorker({ fetch: airtable.handle, storage: { airtable_config: {
    token: "patTESTTOKEN.0123456789abcdef", userId: ME,
    bases: [{ id: BASE_ID, name: "Deal flow", permissionLevel: "create" }],
  } } });
  try {
    const picked = await worker.send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: TABLE_ID });
    assert.equal(picked.mapping.title, "fldRoles", "precondition: fresh match put Current title on Roles");
    // The user fixes Current title -> Title and leaves Experience on Skip (Roles is free and offered).
    const saved = await worker.send({ type: "AIRTABLE_SAVE_MAPPING", mapping: { name: "fldName", linkedinUrl: "fldLinkedIn", title: "fldTitle" } });
    assert.equal(saved.mapping.experience, undefined);
    const refreshed = await worker.send({ type: "AIRTABLE_REFRESH_SCHEMA" });
    assert.equal(refreshed.mapping.experience, undefined, `refresh mapped experience -> ${refreshed.mapping.experience}`);
  } finally {
    worker.restore();
  }
});
