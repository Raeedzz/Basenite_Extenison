/**
 * Add to mandate: links on the person's side, union never replace, typecast
 * off, stage only moved forward, and open mandates listed Live first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BASE_ID, P, PEOPLE, setup, sink } from "./helpers/image-harness.mjs";

const { MANDATES: M, PEOPLE_MANDATES: PM, addToMandate, listMandates, mandatesReady, nextStatus } =
  await import("../lib/airtable-mandates.js");

const link = (id, name, target) => ({ id, name, type: "multipleRecordLinks", options: { linkedTableId: target } });
const STAGES = ["Potential candidate", "Reached out", "Replied", "Placed"];

function withMandates(layout) {
  layout.find((table) => table.id === PEOPLE).fields.push(
    link(PM.candidate, "Mandates (candidate for)", M.table),
    link(PM.reachedOut, "Mandates (reached out for)", M.table),
    { id: PM.status, name: "Mandate status", type: "singleSelect", options: { choices: STAGES.map((name) => ({ id: `sel${name}`, name })) } },
  );
  layout.push({
    id: M.table,
    name: "Mandates",
    fields: [
      { id: M.name, name: "Mandate", type: "singleLineText" },
      { id: M.status, name: "Status", type: "singleSelect", options: { choices: ["Live", "On hold", "Filled", "Closed"].map((name) => ({ id: `sel${name}`, name })) } },
      { id: M.created, name: "Created", type: "createdTime" },
    ],
  });
  return layout;
}

const mandate = (id, name, status, created) => ({ id, fields: { [M.name]: name, ...(status ? { [M.status]: status } : {}), [M.created]: created } });
const RUNBOOK = mandate("recRUNBOOK0000001", "Runbook — Agent PM", "Live", "2026-09-30T00:00:00.000Z");
const ACME = mandate("recACME0000000001", "Acme — Founding eng", "Live", "2026-09-10T00:00:00.000Z");
const HOLD = mandate("recHOLD0000000001", "Hold Co — CFO", "On hold", "2026-09-29T00:00:00.000Z");
const FRESH = mandate("recFRESH000000001", "Fresh — no status", null, "2026-10-01T00:00:00.000Z");
const DONE = mandate("recDONE0000000001", "Done Co — CTO", "Filled", "2026-09-01T00:00:00.000Z");
const RON = { id: "recRONBOLEN000001", fields: { [P.name]: "Ron Bolen", [P.linkedin]: "https://www.linkedin.com/in/ron-bolen" } };

const ready = (people = [RON]) => setup({ [PEOPLE]: people, [M.table]: [RUNBOOK, ACME, HOLD, FRESH, DONE] }, { tables: withMandates });
const patches = (base) => base.log.filter((entry) => entry.path === `/v0/${BASE_ID}/${PEOPLE}` && entry.method === "PATCH");
const row = (base, id) => base.rows(PEOPLE).find((record) => record.id === id);

test("mandatesReady needs the Mandates table and both People links pointing at it", async () => {
  ready();
  const config = await sink.readConfig();
  assert.equal(mandatesReady(config.baseTables, PEOPLE), true);
  setup({ [PEOPLE]: [RON] });
  assert.equal(mandatesReady((await sink.readConfig()).baseTables, PEOPLE), false);
});

test("open mandates only: Live newest first, then On hold, then no status; Filled/Closed left out", async () => {
  ready();
  const listed = await listMandates(await sink.readConfig());
  assert.deepEqual(listed.map((each) => each.id), [RUNBOOK.id, ACME.id, HOLD.id, FRESH.id]);
  assert.deepEqual(listed[0], { id: RUNBOOK.id, name: "Runbook — Agent PM", status: "Live" });
});

test("add links them as a candidate, keeps their other mandates, typecast off, and sets the first stage", async () => {
  const { base } = ready([{ ...RON, fields: { ...RON.fields, [PM.candidate]: [ACME.id] } }]);
  const result = await addToMandate(await sink.readConfig(), { personId: RON.id, mandateId: RUNBOOK.id });
  assert.equal(result.added, true);
  assert.deepEqual(row(base, RON.id).fields[PM.candidate], [ACME.id, RUNBOOK.id]);
  assert.equal(row(base, RON.id).fields[PM.reachedOut], undefined);
  assert.equal(row(base, RON.id).fields[PM.status], "Potential candidate");
  assert.ok(patches(base).every((entry) => entry.body.typecast === false));
});

test("reached out links both sides and moves the stage forward from Potential candidate", async () => {
  const { base } = ready([{ ...RON, fields: { ...RON.fields, [PM.candidate]: [RUNBOOK.id], [PM.status]: "Potential candidate" } }]);
  const result = await addToMandate(await sink.readConfig(), { personId: RON.id, mandateId: RUNBOOK.id, reachedOut: true });
  assert.equal(result.added, true);
  assert.deepEqual(row(base, RON.id).fields[PM.candidate], [RUNBOOK.id]);
  assert.deepEqual(row(base, RON.id).fields[PM.reachedOut], [RUNBOOK.id]);
  assert.equal(row(base, RON.id).fields[PM.status], "Reached out");
});

test("already in the mandate writes nothing; a later stage is never moved back", async () => {
  const { base } = ready([{ ...RON, fields: { ...RON.fields, [PM.candidate]: [RUNBOOK.id], [PM.reachedOut]: [RUNBOOK.id], [PM.status]: "Replied" } }]);
  const result = await addToMandate(await sink.readConfig(), { personId: RON.id, mandateId: RUNBOOK.id, reachedOut: true });
  assert.equal(result.added, false);
  assert.equal(patches(base).length, 0);
  assert.equal(row(base, RON.id).fields[PM.status], "Replied");
  assert.equal(nextStatus("Replied", true), null);
  assert.equal(nextStatus("Placed", false), null);
  assert.equal(nextStatus("", true), "Reached out");
});

test("a stage the base can't take still leaves the link in place, with a warning", async () => {
  const { base } = setup({ [PEOPLE]: [RON], [M.table]: [RUNBOOK] }, {
    tables: (layout) => {
      withMandates(layout);
      layout.find((table) => table.id === PEOPLE).fields.find((field) => field.id === PM.status).options.choices = [];
      return layout;
    },
  });
  const result = await addToMandate(await sink.readConfig(), { personId: RON.id, mandateId: RUNBOOK.id });
  assert.deepEqual(row(base, RON.id).fields[PM.candidate], [RUNBOOK.id]);
  assert.match(result.warning, /Mandate status wasn't set/);
  assert.equal(result.status, "");
});

test("worker: preview reads LinkedIn once, Add reuses it, adds to People, then links the mandate", async () => {
  const { BASANITE_TABLES, fakeBase } = await import("./helpers/image-harness.mjs");
  const { bootWorker } = await import("./helpers/worker-harness.mjs");
  const fieldsLib = await import("../lib/airtable-fields.js");
  const linkedLib = await import("../lib/airtable-linked.js");
  sink.forgetTableState();
  const layout = withMandates(structuredClone(BASANITE_TABLES));
  const base = fakeBase({ baseId: BASE_ID, tables: layout.map((table) => ({ ...table, records: table.id === M.table ? [RUNBOOK, DONE] : [] })) });
  const people = layout.find((table) => table.id === PEOPLE);
  const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };
  const profile = { included: [{ entityUrn: "urn:li:fsd_profile:ACoAAB1", publicIdentifier: "new-person", firstName: "New", lastName: "Person", headline: "Builds agents" }] };
  // Profile reads only; /me (whose Known by) is asked on every write.
  let linkedin = 0;
  const fetchImpl = async (input, init) => {
    if (String(input).startsWith("https://api.airtable.com/")) return base.handle(input, init);
    if (String(input).includes("/identity/dash/profiles")) linkedin++;
    return new Response(JSON.stringify(profile), { status: 200, headers: { "content-type": "application/json" } });
  };
  const worker = await bootWorker({ fetch: fetchImpl, cookies, storage: { airtable_config: {
    token: "patTESTTOKEN.0123456789abcdef", userId: "usrME000000000001",
    baseId: BASE_ID, baseName: "Basanite", tableId: PEOPLE, tableName: "People", fields: people.fields,
    mapping: fieldsLib.suggestMapping(people.fields), linked: linkedLib.suggestLinked(layout, PEOPLE),
    baseTables: sink.summarizeTables(layout), schemaAt: Date.now(),
  } } });
  try {
    const url = "https://www.linkedin.com/in/new-person/";
    const listed = await worker.send({ type: "LIST_MANDATES" });
    assert.deepEqual(listed, { ready: true, mandates: [{ id: RUNBOOK.id, name: "Runbook — Agent PM", status: "Live" }] });
    assert.deepEqual(await worker.send({ type: "PERSON_MANDATES", url }), { person: null, mandates: null });
    const preview = await worker.send({ type: "PROFILE_PREVIEW", url });
    assert.equal(preview.error, undefined, preview.error);
    assert.equal(preview.profile.name, "New Person");
    assert.equal(preview.profile.headline, "Builds agents");
    const read = linkedin;
    assert.ok(read > 0);
    const bad = await worker.send({ type: "ADD_TO_MANDATE", url, mandateId: "nope" });
    assert.equal(bad.ok, true, "a malformed mandate id is ignored, not linked");
    const added = await worker.send({ type: "ADD_TO_MANDATE", url, mandateId: RUNBOOK.id, reachedOut: true });
    assert.equal(added.error, undefined, added.error);
    assert.equal(added.added, true);
    assert.equal(linkedin, read, "Add didn't ask LinkedIn again");
    const [person] = base.rows(PEOPLE);
    assert.equal(base.rows(PEOPLE).length, 1);
    assert.deepEqual(person.fields[PM.candidate], [RUNBOOK.id]);
    assert.deepEqual(person.fields[PM.reachedOut], [RUNBOOK.id]);
    assert.equal(person.fields[PM.status], "Reached out");
    const after = await worker.send({ type: "PERSON_MANDATES", url });
    assert.equal(after.person.id, person.id);
    assert.deepEqual(after.mandates, { candidate: [RUNBOOK.id], reachedOut: [RUNBOOK.id], status: "Reached out" });
  } finally {
    worker.restore();
  }
});

/** A worker over the Basanite layout with Mandates, LinkedIn answering as `slug` for any profile asked. */
async function mandateWorker({ people = [], slug = "new-person", slowWrites = false } = {}) {
  const { BASANITE_TABLES, fakeBase } = await import("./helpers/image-harness.mjs");
  const { bootWorker } = await import("./helpers/worker-harness.mjs");
  const fieldsLib = await import("../lib/airtable-fields.js");
  const linkedLib = await import("../lib/airtable-linked.js");
  // The sink outlives a worker boot: its row index belongs to the last test's base.
  sink.forgetTableState();
  const layout = withMandates(structuredClone(BASANITE_TABLES));
  const records = { [PEOPLE]: people, [M.table]: [RUNBOOK, ACME] };
  const base = fakeBase({ baseId: BASE_ID, tables: layout.map((table) => ({ ...table, records: records[table.id] || [] })) });
  const peopleTable = layout.find((table) => table.id === PEOPLE);
  const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };
  // `linkedin.slug` is what LinkedIn calls them now; a test may change it.
  const linkedin = { slug };
  const fetchImpl = async (input, init) => {
    if (String(input).startsWith("https://api.airtable.com/")) {
      // Writes that land late, as over a real network: a read can slip in before them.
      if (slowWrites && init?.method === "PATCH") await new Promise((resolve) => setTimeout(resolve, 600));
      return base.handle(input, init);
    }
    const profile = { included: [{ entityUrn: "urn:li:fsd_profile:ACoAAB1", publicIdentifier: linkedin.slug, firstName: "New", lastName: "Person" }] };
    return new Response(JSON.stringify(profile), { status: 200, headers: { "content-type": "application/json" } });
  };
  const worker = await bootWorker({ fetch: fetchImpl, cookies, storage: { airtable_config: {
    token: "patTESTTOKEN.0123456789abcdef", userId: "usrME000000000001",
    baseId: BASE_ID, baseName: "Basanite", tableId: PEOPLE, tableName: "People", fields: peopleTable.fields,
    mapping: fieldsLib.suggestMapping(peopleTable.fields), linked: linkedLib.suggestLinked(layout, PEOPLE),
    baseTables: sink.summarizeTables(layout), schemaAt: Date.now(),
  } } });
  const peopleWrites = () => base.log.filter((entry) => entry.path === `/v0/${BASE_ID}/${PEOPLE}` && ["POST", "PATCH"].includes(entry.method)
    && !String(entry.path).endsWith("/listRecords"));
  return { base, worker, peopleWrites, linkedin };
}

test("worker: a row added by hand under the tab's URL is linked, though LinkedIn now calls them something else", async () => {
  const OLD = { id: "recOLDSLUG0000001", fields: { [P.name]: "New Person", [P.linkedin]: "https://www.linkedin.com/in/old-slug" } };
  const { base, worker, peopleWrites } = await mandateWorker({ people: [OLD], slug: "new-person" });
  try {
    const url = "https://www.linkedin.com/in/old-slug/";
    const preview = await worker.send({ type: "PROFILE_PREVIEW", url });
    assert.equal(preview.profile.linkedinUrl, "https://www.linkedin.com/in/new-person");
    assert.equal((await worker.send({ type: "PERSON_MANDATES", url })).person.id, OLD.id);
    const added = await worker.send({ type: "ADD_TO_MANDATE", url, mandateId: RUNBOOK.id });
    assert.equal(added.error, undefined, added.error);
    assert.equal(added.person.id, OLD.id);
    assert.equal(added.created, false);
    assert.equal(base.rows(PEOPLE).length, 1);
    assert.deepEqual(row(base, OLD.id).fields[PM.candidate], [RUNBOOK.id]);
    assert.ok(peopleWrites().every((entry) => entry.method === "PATCH"), "nothing created");
  } finally {
    worker.restore();
  }
});

test("worker: someone the extension added before they changed their URL is found by member id, not added again", async () => {
  const { base, worker, peopleWrites, linkedin } = await mandateWorker({ slug: "old-slug" });
  try {
    const first = await worker.send({ type: "ADD_TO_MANDATE", url: "https://www.linkedin.com/in/old-slug", mandateId: null });
    assert.equal(first.created, true);
    const [person] = base.rows(PEOPLE);
    const creates = peopleWrites().filter((entry) => entry.method === "POST").length;
    linkedin.slug = "new-person";
    const url = "https://www.linkedin.com/in/new-person";
    await worker.send({ type: "PROFILE_PREVIEW", url });
    assert.equal((await worker.send({ type: "PERSON_MANDATES", url })).person.id, person.id);
    const added = await worker.send({ type: "ADD_TO_MANDATE", url, mandateId: ACME.id });
    assert.equal(added.error, undefined, added.error);
    assert.equal(added.person.id, person.id);
    assert.equal(base.rows(PEOPLE).length, 1);
    assert.equal(peopleWrites().filter((entry) => entry.method === "POST").length, creates);
    assert.deepEqual(row(base, person.id).fields[PM.candidate], [ACME.id]);
  } finally {
    worker.restore();
  }
});

test("worker: already in People and in the mandate: Add writes nothing at all", async () => {
  const IN = { id: "recALREADYIN00001", fields: {
    [P.name]: "New Person", [P.linkedin]: "https://www.linkedin.com/in/new-person", [PM.candidate]: [RUNBOOK.id], [PM.status]: "Potential candidate",
  } };
  const { base, worker, peopleWrites } = await mandateWorker({ people: [IN] });
  try {
    const url = "https://www.linkedin.com/in/new-person";
    await worker.send({ type: "PROFILE_PREVIEW", url });
    const again = await worker.send({ type: "ADD_TO_MANDATE", url, mandateId: RUNBOOK.id });
    assert.equal(again.added, false);
    const plain = await worker.send({ type: "ADD_TO_MANDATE", url, mandateId: null });
    assert.equal(plain.ok, true);
    assert.equal(plain.created, false);
    assert.equal(peopleWrites().length, 0);
    assert.equal(base.rows(PEOPLE).length, 1);
  } finally {
    worker.restore();
  }
});

test("worker: Adds sent at once make one person, linked into every mandate asked", async () => {
  const { base, worker } = await mandateWorker();
  try {
    const url = "https://www.linkedin.com/in/new-person";
    const answers = await Promise.all([
      worker.send({ type: "ADD_TO_MANDATE", url, mandateId: RUNBOOK.id }),
      worker.send({ type: "ADD_TO_MANDATE", url, mandateId: RUNBOOK.id }),
      worker.send({ type: "ADD_TO_MANDATE", url, mandateId: ACME.id, reachedOut: true }),
    ]);
    for (const answer of answers) assert.equal(answer.error, undefined, answer.error);
    assert.equal(base.rows(PEOPLE).length, 1);
    const [person] = base.rows(PEOPLE);
    assert.deepEqual(person.fields[PM.candidate], [RUNBOOK.id, ACME.id]);
    assert.deepEqual(person.fields[PM.reachedOut], [ACME.id]);
    assert.deepEqual(answers.map((answer) => answer.added), [true, false, true]);
  } finally {
    worker.restore();
  }
});

test("worker: two mandates added at once for someone in People both stick", async () => {
  const IN = { id: "recALREADYIN00001", fields: { [P.name]: "New Person", [P.linkedin]: "https://www.linkedin.com/in/new-person" } };
  const { base, worker } = await mandateWorker({ people: [IN], slowWrites: true });
  try {
    const url = "https://www.linkedin.com/in/new-person";
    const answers = await Promise.all([
      worker.send({ type: "ADD_TO_MANDATE", url, mandateId: RUNBOOK.id }),
      worker.send({ type: "ADD_TO_MANDATE", url, mandateId: ACME.id }),
    ]);
    for (const answer of answers) assert.equal(answer.error, undefined, answer.error);
    assert.deepEqual(row(base, IN.id).fields[PM.candidate], [RUNBOOK.id, ACME.id]);
  } finally {
    worker.restore();
  }
});
