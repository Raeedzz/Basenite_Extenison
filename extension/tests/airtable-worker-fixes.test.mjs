/**
 * Worker regressions: "Create missing" against Airtable's create-field rules,
 * and Stop during Find mutuals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bootWorker } from "./helpers/worker-harness.mjs";
import { BASE_ID, TABLE_ID, airtableConfig, fakeAirtable } from "./helpers/fake-airtable.mjs";
import { SOURCE_FIELDS } from "../lib/airtable-fields.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Airtable's documented rules: a checkbox needs options.color and .icon, a
// single select needs options.choices, attachments take no options, names are unique.
function strictCreate(airtable, { failOn = null } = {}) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === `/v0/meta/bases/${BASE_ID}/tables/${TABLE_ID}/fields` && init.method === "POST") {
      const body = JSON.parse(init.body);
      const bad = (message, type = "INVALID_FIELD_TYPE_OPTIONS_FOR_CREATE") => json({ error: { type, message } }, 422);
      if (airtable.table.fields.some((field) => field.name.toLowerCase() === body.name.toLowerCase())) {
        return bad(`Field "${body.name}" already exists`, "DUPLICATE_OR_EMPTY_FIELD_NAME");
      }
      if (body.name === failOn) return bad("refused for the test");
      if (body.type === "checkbox" && !(body.options?.color && body.options?.icon)) return bad("checkbox needs options.color and options.icon");
      if (body.type === "singleSelect" && !Array.isArray(body.options?.choices)) return bad("singleSelect needs options.choices");
      if (body.type === "multipleAttachments" && body.options) return bad("multipleAttachments takes no options");
    }
    return airtable.handle(input, init);
  };
}

const missingKeys = (config) => SOURCE_FIELDS.filter((source) => !source.noCreate && !config.mapping[source.key]).map((source) => source.key);

test("Create missing makes every column Airtable's rules allow, and maps them all", async () => {
  const airtable = fakeAirtable();
  const worker = await bootWorker({ fetch: strictCreate(airtable), storage: { airtable_config: airtableConfig() } });
  try {
    const config = await worker.send({ type: "AIRTABLE_GET_CONFIG" });
    const answer = await worker.send({ type: "AIRTABLE_CREATE_FIELDS", keys: missingKeys(config) });
    assert.equal(answer.error, undefined, answer.error);
    const { mapping } = worker.store.get("airtable_config");
    for (const key of ["photo", "inNetwork", "hasInteracted"]) assert.ok(mapping[key], `${key} wasn't mapped`);
    const network = airtable.table.fields.find((field) => field.id === mapping.inNetwork);
    assert.deepEqual(network.options.choices.map((choice) => choice.name).sort(), ["In network", "Outside network"]);
    // Nothing left to make: a second press is a no-op, not an error.
    const again = await worker.send({ type: "AIRTABLE_CREATE_FIELDS", keys: missingKeys(await worker.send({ type: "AIRTABLE_GET_CONFIG" })) });
    assert.equal(again.error, undefined, again.error);
  } finally {
    worker.restore();
  }
});

test("a column Airtable refuses partway keeps the ones already made mapped, and a retry continues", async () => {
  const airtable = fakeAirtable();
  const worker = await bootWorker({ fetch: strictCreate(airtable, { failOn: "Has messaged" }), storage: { airtable_config: airtableConfig() } });
  try {
    const config = await worker.send({ type: "AIRTABLE_GET_CONFIG" });
    const first = await worker.send({ type: "AIRTABLE_CREATE_FIELDS", keys: missingKeys(config) });
    assert.match(first.error || "", /refused/);
    const { mapping } = worker.store.get("airtable_config");
    assert.ok(mapping.photo && mapping.inNetwork, "columns made before the failure were left unmapped");
    const count = airtable.table.fields.length;
    const retry = await worker.send({ type: "AIRTABLE_CREATE_FIELDS", keys: missingKeys(await worker.send({ type: "AIRTABLE_GET_CONFIG" })) });
    assert.match(retry.error || "", /refused/, "the retry got stuck on a column that already exists");
    assert.equal(airtable.table.fields.length, count, "the retry made duplicate columns");
  } finally {
    worker.restore();
  }
});

test("Stop during Find mutuals stops it: no more LinkedIn requests, no progress coming back", async () => {
  const airtable = fakeAirtable();
  const voyager = [];
  const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };
  const fetchImpl = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.airtable.com/")) return airtable.handle(input, init);
    voyager.push(url);
    return json({});
  };
  const worker = await bootWorker({ fetch: fetchImpl, storage: { airtable_config: airtableConfig() }, cookies });
  try {
    const targets = ["a", "b", "c"].map((slug) => ({ linkedinUrl: `https://www.linkedin.com/in/target-${slug}` }));
    const started = await worker.send({ type: "START_MUTUAL_FINDING", contacts: targets });
    assert.equal(started.started, true, JSON.stringify(started));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = voyager.length;
    assert.equal((await worker.send({ type: "CANCEL_SYNC" })).canceled, true);
    const history = () => (worker.writes.get("mutual_progress") || []).map((progress) => progress?.status);
    const cancelAt = history().lastIndexOf("canceled");
    await new Promise((resolve) => setTimeout(resolve, 7000));
    // The one request already in flight may finish; nothing new starts.
    assert.ok(voyager.length <= before + 1, `LinkedIn requests continued after Stop: ${before} → ${voyager.length}`);
    assert.deepEqual(history().slice(cancelAt + 1), [], "progress came back after Stop");
  } finally {
    worker.restore();
  }
});

test("Disconnect removes the token, the setup, and every local index and cache for the base", async () => {
  const airtable = fakeAirtable();
  const worker = await bootWorker({
    fetch: strictCreate(airtable),
    storage: {
      airtable_config: airtableConfig(),
      [`airtable_rows:${BASE_ID}:${TABLE_ID}:0`]: { ada: { r: "recADA0000000001" } },
      [`airtable_linked:${BASE_ID}:tblCOMPANIES00001:0`]: { recX: { n: "acme" } },
      linkedin_company_details: { 1: { name: "Acme", about: "…" } },
      bulk_enrich_job: { status: "complete", urls: [] },
      company_capture: { people: [{ name: "Someone" }] },
      airtable_last_write: { at: 1 },
      earthos_soft_sync_prefs: { enabled: true, timesPerDay: 12 },
    },
  });
  try {
    const answer = await worker.send({ type: "AIRTABLE_DISCONNECT" });
    assert.equal(answer.error, undefined, answer.error);
    const left = [...worker.store.keys()];
    assert.deepEqual(left.filter((key) => /^airtable_|linkedin_company_details|bulk_enrich_job|company_capture/.test(key)), []);
    assert.ok(left.includes("earthos_soft_sync_prefs"), "an unrelated preference was wiped");
  } finally {
    worker.restore();
  }
});

test("a new table setup makes and maps a column for every field the table lacks", async () => {
  const airtable = fakeAirtable({ fields: [
    { id: "fldName", name: "Name", type: "singleLineText" },
    { id: "fldLinkedIn", name: "LinkedIn", type: "url" },
    { id: "fldEduLink", name: "Education", type: "multipleRecordLinks" },
    { id: "fldCoLink", name: "Current company", type: "multipleRecordLinks" },
  ] });
  const worker = await bootWorker({ fetch: strictCreate(airtable), storage: { airtable_config: {
    token: "patTESTTOKEN.0123456789abcdef", bases: [{ id: BASE_ID, name: "Deal flow", permissionLevel: "create" }],
  } } });
  try {
    const picked = await worker.send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: TABLE_ID });
    assert.equal(picked.error, undefined, picked.error);
    assert.equal(picked.columnsError, undefined, picked.columnsError);
    const unmapped = SOURCE_FIELDS.filter((source) => !source.noCreate && source.autoMap !== false && !picked.mapping[source.key]).map((source) => source.key);
    assert.deepEqual(unmapped, [], `left on Skip: ${unmapped}`);
    const nameOf = (key) => airtable.table.fields.find((field) => field.id === picked.mapping[key])?.name;
    assert.equal(nameOf("experience"), "Experience");
    assert.equal(nameOf("education"), "Education (LinkedIn)", "a same-named linked column got a clumsy duplicate name");
    assert.equal(nameOf("company"), "Current company (LinkedIn)");
    assert.equal(picked.mapping.linkedinUrl, "fldLinkedIn");
    assert.equal(picked.mapping.source, undefined, "Source is only ever chosen by hand");
  } finally {
    worker.restore();
  }
});

test("a token that can't make columns still sets up the table, and says why", async () => {
  const airtable = fakeAirtable();
  const fetchImpl = async (input, init = {}) => {
    if (new URL(String(input)).pathname.endsWith(`/tables/${TABLE_ID}/fields`) && init.method === "POST") {
      return json({ error: { type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", message: "no" } }, 403);
    }
    return airtable.handle(input, init);
  };
  const worker = await bootWorker({ fetch: fetchImpl, storage: { airtable_config: {
    token: "patTESTTOKEN.0123456789abcdef", bases: [{ id: BASE_ID, name: "Deal flow", permissionLevel: "create" }],
  } } });
  try {
    const picked = await worker.send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: TABLE_ID });
    assert.equal(picked.error, undefined, picked.error);
    assert.equal(picked.tableId, TABLE_ID);
    assert.match(picked.columnsError || "", /schema\.bases:write/);
    assert.ok(picked.mapping.linkedinUrl, "the name match was lost");
  } finally {
    worker.restore();
  }
});

test("a token is the whole setup: base, table, and every column, ready to sync", async () => {
  const airtable = fakeAirtable({ fields: [
    { id: "fldName", name: "Name", type: "singleLineText" },
    { id: "fldLinkedIn", name: "LinkedIn", type: "url" },
  ] });
  const worker = await bootWorker({ fetch: strictCreate(airtable), storage: {} });
  try {
    const ready = await worker.send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
    assert.equal(ready.error, undefined, ready.error);
    assert.equal(ready.baseId, BASE_ID);
    assert.equal(ready.tableId, TABLE_ID);
    assert.equal(ready.problem, null);
    for (const key of ["linkedinUrl", "experience", "experienceDates", "education", "educationDates"]) assert.ok(ready.mapping[key], `${key} left on Skip`);
  } finally {
    worker.restore();
  }
});
