/**
 * Log interaction: one Interactions row per log, at most one Notes row,
 * create-only, by field id, typecast off, and a Retry that reuses the note.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BASANITE_TABLES, BASE_ID, P, PEOPLE, fakeBase, setup, sink } from "./helpers/image-harness.mjs";

const { INTERACTIONS: I, NOTES: N, INTERACTION_TYPES, interactionEntry, interactionTables, logInteraction } =
  await import("../lib/airtable-interactions.js");
const { bootWorker } = await import("./helpers/worker-harness.mjs");
const fieldsLib = await import("../lib/airtable-fields.js");
const linkedLib = await import("../lib/airtable-linked.js");

const link = (id, name, target) => ({ id, name, type: "multipleRecordLinks", options: { linkedTableId: target } });

/** The real Basanite layout plus Interactions and the Notes columns the log writes. */
function withInteractions(layout) {
  const notes = layout.find((table) => table.id === N.table);
  notes.fields.push({ id: N.at, name: "Noted at", type: "dateTime" });
  layout.push({
    id: I.table,
    name: "Interactions",
    fields: [
      { id: I.summary, name: "Summary", type: "singleLineText" },
      { id: I.types, name: "Types", type: "multipleSelects", options: { choices: INTERACTION_TYPES.map((name) => ({ id: `sel${name}`, name })) } },
      { id: I.at, name: "Interaction at", type: "dateTime" },
      link(I.person, "Person", PEOPLE),
      link(I.note, "Note", N.table),
      { id: "fldlIIpZNRooTBurJ", name: "Logged at", type: "createdTime" },
      { id: "fldPARUAXOSNUaXJp", name: "Type", type: "singleSelect", options: { choices: [] } },
      { id: "fldo6QlsWIdWYYCaz", name: "Date", type: "date" },
    ],
  });
  return layout;
}

const RON = { id: "recRONBOLEN000001", fields: { [P.name]: "Ron Bolen", [P.linkedin]: "https://www.linkedin.com/in/ron-bolen" } };
const AT = "2026-09-20T18:30:00.000Z";

const ready = () => setup({ [PEOPLE]: [RON] }, { tables: withInteractions });
const configOf = () => sink.readConfig();
const writes = (base, table) => base.log.filter((entry) => entry.path === `/v0/${BASE_ID}/${table}` && entry.method !== "GET");

test("a log with no note: one Interactions row, by field id, typecast off, no Notes row", async () => {
  const { base } = ready();
  const config = await configOf();
  const person = await sink.findPersonRecord("https://www.linkedin.com/in/ron-bolen/");
  assert.deepEqual(person, { id: RON.id, name: "Ron Bolen" });
  const result = await logInteraction(config, { ...interactionEntry({ types: ["Coffee", "Lunch"], at: AT, note: "  " }), personId: person.id, name: person.name });
  const [row] = base.rows(I.table);
  assert.equal(base.rows(I.table).length, 1);
  assert.equal(result.interactionId, row.id);
  assert.deepEqual(row.fields, {
    [I.summary]: "Coffee + Lunch with Ron Bolen",
    [I.types]: ["Coffee", "Lunch"],
    [I.at]: AT,
    [I.person]: [RON.id],
  });
  assert.equal(base.rows(N.table).length, 0);
  const [sent] = writes(base, I.table);
  assert.equal(sent.body.typecast, false);
  assert.equal(sent.method, "POST");
});

test("a log with a note: the Notes row first, then the interaction linking it, same timestamp", async () => {
  const { base } = ready();
  const config = await configOf();
  await logInteraction(config, { ...interactionEntry({ types: ["Calls"], at: AT, note: " Talked about the Series A.\nFollow up in May. " }), personId: RON.id, name: "Ron Bolen" });
  const [note] = base.rows(N.table);
  const [interaction] = base.rows(I.table);
  assert.deepEqual(note.fields, { [N.text]: "Talked about the Series A.\nFollow up in May.", [N.person]: [RON.id], [N.at]: AT });
  assert.deepEqual(interaction.fields[I.note], [note.id]);
  assert.ok(base.log.findIndex((entry) => entry.path.endsWith(N.table)) < base.log.findIndex((entry) => entry.path.endsWith(I.table)));
});

test("the interaction fails after the note landed: the note stays, Retry links it and writes no second note", async () => {
  const { base } = ready();
  const config = await configOf();
  base.faults.lockedFields.add(I.types);
  const entry = interactionEntry({ types: ["Dinner"], at: AT, note: "Great dinner" });
  const error = await logInteraction(config, { ...entry, personId: RON.id, name: "Ron Bolen" }).then(() => null, (failure) => failure);
  assert.ok(error, "the log should have failed");
  assert.equal(base.rows(N.table).length, 1);
  assert.equal(error.noteId, base.rows(N.table)[0].id);
  assert.equal(base.rows(I.table).length, 0);
  base.faults.lockedFields.clear();
  await logInteraction(config, { ...entry, personId: RON.id, name: "Ron Bolen", noteId: error.noteId, retry: true });
  assert.equal(base.rows(N.table).length, 1, "Retry wrote a second note");
  assert.equal(base.rows(I.table).length, 1);
  assert.deepEqual(base.rows(I.table)[0].fields[I.note], [error.noteId]);
});

test("a create that landed but answered 500 isn't sent again", async () => {
  const { base } = ready();
  const config = await configOf();
  base.faults.saveThenFail = 2;
  const result = await logInteraction(config, { ...interactionEntry({ types: ["Email"], at: AT, note: "Sent the deck" }), personId: RON.id, name: "Ron Bolen" });
  assert.equal(base.rows(N.table).length, 1);
  assert.equal(base.rows(I.table).length, 1);
  assert.equal(result.interactionId, base.rows(I.table)[0].id);
  assert.deepEqual(base.rows(I.table)[0].fields[I.note], [result.noteId]);
});

test("Retry after an unclear failure finds the rows that landed instead of adding more", async () => {
  const { base } = ready();
  const config = await configOf();
  const entry = interactionEntry({ types: ["Event Attendee"], at: AT, note: "Met at the summit" });
  await logInteraction(config, { ...entry, personId: RON.id, name: "Ron Bolen" });
  await logInteraction(config, { ...entry, personId: RON.id, name: "Ron Bolen", retry: true });
  assert.equal(base.rows(N.table).length, 1);
  assert.equal(base.rows(I.table).length, 1);
  // Another person, same words: a new row.
  await logInteraction(config, { ...entry, personId: "recSOMEONEELSE001", name: "Ron Bolen", retry: true }).catch(() => {});
  assert.ok(base.rows(I.table).every((row) => row.fields[I.person][0] === RON.id));
});

test("a type that isn't an option in Airtable is refused, not added (typecast off)", async () => {
  const { base } = ready();
  const config = await configOf();
  base.state.get(I.table).fields.find((field) => field.id === I.types).options.choices = [{ id: "selCalls", name: "Calls" }];
  await assert.rejects(logInteraction(config, { ...interactionEntry({ types: ["Coffee"], at: AT }), personId: RON.id, name: "Ron Bolen" }));
  assert.equal(base.rows(I.table).length, 0);
  assert.deepEqual(base.state.get(I.table).fields.find((field) => field.id === I.types).options.choices.map((choice) => choice.name), ["Calls"]);
});

test("the form is checked: a type is required, only known types, a real time, blank note is none", () => {
  assert.throws(() => interactionEntry({ types: [], at: AT }), /at least one/);
  assert.throws(() => interactionEntry({ types: ["Brunch"], at: AT }), /isn't an interaction type/);
  assert.throws(() => interactionEntry({ types: ["DM"], at: "not a date" }), /when/);
  assert.deepEqual(interactionEntry({ types: ["DM", "Calls", "DM"], at: "2026-09-20T13:30:00-05:00", note: "\n " }),
    { types: ["DM", "Calls"], at: AT, note: null });
});

test("Log interaction is offered only when the base has the tables, linked to this People table", () => {
  const plain = sink.summarizeTables(BASANITE_TABLES);
  assert.deepEqual(interactionTables(plain, PEOPLE), { interactions: false, notes: false });
  const full = sink.summarizeTables(withInteractions(structuredClone(BASANITE_TABLES)));
  assert.deepEqual(interactionTables(full, PEOPLE), { interactions: true, notes: true });
  assert.deepEqual(interactionTables(full, "tblSOMEOTHERPEOPL"), { interactions: false, notes: false });
  const noNotedAt = withInteractions(structuredClone(BASANITE_TABLES));
  noNotedAt.find((table) => table.id === N.table).fields = noNotedAt.find((table) => table.id === N.table).fields.filter((field) => field.id !== N.at);
  assert.deepEqual(interactionTables(sink.summarizeTables(noNotedAt), PEOPLE), { interactions: true, notes: false });
});

test("the People lookup asks Airtable: a teammate's row counts, someone absent is null", async () => {
  ready();
  assert.equal((await sink.findPersonRecord("https://www.linkedin.com/in/ron-bolen")).id, RON.id);
  assert.equal(await sink.findPersonRecord("https://www.linkedin.com/in/nobody-here"), null);
  // A near miss by substring isn't a match.
  assert.equal(await sink.findPersonRecord("https://www.linkedin.com/in/ron-bole"), null);
});

test("worker: someone not in People yet is added first, then logged against their new row", async () => {
  const layout = withInteractions(structuredClone(BASANITE_TABLES));
  const base = fakeBase({ baseId: BASE_ID, tables: layout.map((table) => ({ ...table, records: [] })) });
  const people = layout.find((table) => table.id === PEOPLE);
  const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };
  const profile = { included: [{ entityUrn: "urn:li:fsd_profile:ACoAAB1", publicIdentifier: "new-person", firstName: "New", lastName: "Person" }] };
  const fetchImpl = async (input, init) => {
    if (String(input).startsWith("https://api.airtable.com/")) return base.handle(input, init);
    return new Response(JSON.stringify(profile), { status: 200, headers: { "content-type": "application/json" } });
  };
  const worker = await bootWorker({ fetch: fetchImpl, cookies, storage: { airtable_config: {
    token: "patTESTTOKEN.0123456789abcdef", userId: "usrME000000000001",
    baseId: BASE_ID, baseName: "Basanite", tableId: PEOPLE, tableName: "People", fields: people.fields,
    mapping: fieldsLib.suggestMapping(people.fields), linked: linkedLib.suggestLinked(layout, PEOPLE),
    baseTables: sink.summarizeTables(layout), schemaAt: Date.now(),
  } } });
  try {
    const bad = await worker.send({ type: "LOG_INTERACTION", url: "https://www.linkedin.com/in/new-person", types: [], at: AT });
    assert.match(bad.error, /at least one/);
    const answer = await worker.send({
      type: "LOG_INTERACTION", url: "https://www.linkedin.com/in/new-person/", name: "Tab title", types: ["Coffee"], at: AT, note: "Hi",
    });
    assert.equal(answer.error, undefined, answer.error);
    const [person] = base.rows(PEOPLE);
    assert.equal(base.rows(PEOPLE).length, 1);
    const [interaction] = base.rows(I.table);
    assert.equal(interaction.fields[I.summary], "Coffee with New Person");
    assert.deepEqual(interaction.fields[I.person], [person.id]);
    assert.equal(base.rows(N.table).length, 1);
    // Logging again finds the row that now exists: no second person.
    await worker.send({ type: "LOG_INTERACTION", url: "https://www.linkedin.com/in/new-person", types: ["DM"], at: AT });
    assert.equal(base.rows(PEOPLE).length, 1);
    assert.equal(base.rows(I.table).length, 2);
  } finally {
    worker.restore();
  }
});

const wait = async (done, what) => {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(done(), `timed out waiting for ${what}`);
};

for (const [trigger, start] of [
  ["scheduled", (worker) => worker.fireAlarm("earthos-soft-sync")],
  ["Quick refresh", (worker) => worker.send({ type: "START_CAPTURE", site: "linkedin", mode: "soft" })],
]) {
  test(`worker: every soft sync (${trigger}) re-reads the base, so tables added in Airtable turn Log interaction on`, async () => {
    const layout = withInteractions(structuredClone(BASANITE_TABLES));
    const base = fakeBase({ baseId: BASE_ID, tables: layout.map((table) => ({ ...table, records: [] })) });
    const people = layout.find((table) => table.id === PEOPLE);
    // Set up before Interactions existed: the cached schema doesn't have it.
    const before = sink.summarizeTables(BASANITE_TABLES);
    assert.equal(interactionTables(before, PEOPLE).interactions, false);
    const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };
    const fetchImpl = async (input, init) => (String(input).startsWith("https://api.airtable.com/")
      ? base.handle(input, init)
      : new Response(JSON.stringify({ included: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const worker = await bootWorker({ fetch: fetchImpl, cookies, storage: {
      earthos_soft_sync_prefs: { enabled: true, timesPerDay: 12 },
      capture_results: { site: "linkedin", total: 0, completedAt: new Date().toISOString() },
      airtable_config: {
        token: "patTESTTOKEN.0123456789abcdef", userId: "usrME000000000001",
        baseId: BASE_ID, baseName: "Basanite", tableId: PEOPLE, tableName: "People", fields: people.fields,
        mapping: fieldsLib.suggestMapping(people.fields), linked: linkedLib.suggestLinked(BASANITE_TABLES, PEOPLE),
        // Read minutes ago, so only a per-sync re-read (not the 6-hour one) picks the tables up.
        baseTables: before, schemaAt: Date.now() - 60_000,
      },
    } });
    try {
      start(worker);
      await wait(() => interactionTables(worker.store.get("airtable_config").baseTables, PEOPLE).notes, "the re-read");
      // Let the run finish against the fake before the real fetch comes back.
      await wait(() => worker.store.get("capture_results")?.importId, "the sync to finish");
    } finally {
      worker.restore();
    }
  });
}
