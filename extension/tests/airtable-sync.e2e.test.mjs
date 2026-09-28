/**
 * The whole path, end to end: the real service worker, set up the way the
 * side panel does it, syncing a fake LinkedIn into a fake Airtable — then the
 * scheduled soft sync running over the same network and finding nothing to do.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bootWorker } from "./helpers/worker-harness.mjs";
import { BASE_ID, TABLE_ID, fakeAirtable } from "./helpers/fake-airtable.mjs";

const CONNECTIONS = 5;
const urnFor = (index) => `urn:li:fsd_profile:ACoAA${index}`;
const publicIdFor = (index) => `ada-number-${index}`;

const signedInToLinkedIn = {
  get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }),
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

function profileRecord(index) {
  return {
    publicIdentifier: publicIdFor(index),
    entityUrn: urnFor(index),
    firstName: "Ada",
    lastName: `Number${index}`,
    summary: `About Ada ${index}.`,
    industry: { name: "Computer Software" },
    geoLocation: { geo: { defaultLocalizedNameWithoutCountryName: "San Francisco Bay Area" } },
  };
}

function network(airtable, { connections = CONNECTIONS, slowMs = () => 0 } = {}) {
  const linkedin = { profileRequests: 0 };
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith("https://api.airtable.com/")) return airtable.handle(input, init);
    // A slow LinkedIn holds a run open long enough to race it.
    const delay = slowMs(url);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (url.includes("/voyager/api/identity/dash/profiles")) {
      linkedin.profileRequests++;
      const query = new URL(url, "https://www.linkedin.com").searchParams;
      const ids = query.get("ids");
      if (ids) {
        const results = {};
        for (const urn of ids.slice("List(".length, -1).split(",").map(decodeURIComponent)) {
          results[urn] = profileRecord(Number(urn.replace("urn:li:fsd_profile:ACoAA", "")));
        }
        return json({ statuses: {}, results, errors: {} });
      }
      const index = Number((query.get("memberIdentity") || "").replace("ada-number-", ""));
      return json({ elements: [profileRecord(index)] });
    }
    if (url.includes("/voyager/api/relationships/dash/connections")) {
      const start = Number(new URL(url).searchParams.get("start")) || 0;
      return json({
        elements: Array.from({ length: Math.max(0, Math.min(100, connections - start)) }, (_, offset) => start + offset).map((index) => ({
          entityUrn: `urn:li:fsd_connection:ACoAA${index}`,
          connectedMemberResolutionResult: {
            entityUrn: urnFor(index),
            firstName: "Ada",
            lastName: `Number${index}`,
            publicIdentifier: publicIdFor(index),
            headline: "Engineer",
          },
          createdAt: Date.UTC(2023, 10, 14),
        })),
        paging: { start, count: 100, total: connections },
      });
    }
    return json({});
  };
  return { linkedin, fetchImpl };
}

async function until(read, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("set up from the panel, a sync fills the table and the soft sync after it costs nothing", async () => {
  const airtable = fakeAirtable();
  const { linkedin, fetchImpl } = network(airtable);
  const { store, send, fireAlarm, restore } = await bootWorker({ fetch: fetchImpl, cookies: signedInToLinkedIn });
  try {
    // Nothing can run before Airtable is set up, and the panel is told why.
    const early = await send({ type: "START_CAPTURE", site: "linkedin" });
    assert.match(early.error, /Connect Airtable/);

    const connected = await send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
    assert.equal(connected.connected, true);
    assert.equal(connected.tokenHint, "…cdef");
    assert.equal(connected.bases[0].id, BASE_ID);
    assert.equal(JSON.stringify(connected).includes("patTESTTOKEN"), false, "the panel was handed the token");

    const auto = await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: TABLE_ID });
    assert.equal(auto.problem, null);
    assert.equal(auto.mapping.linkedinUrl, "fldLinkedIn");
    assert.equal(auto.mapping.connectedAt, "fldConnected");
    // Source is only ever chosen by hand.
    assert.equal(auto.mapping.source, undefined);
    const selected = await send({ type: "AIRTABLE_SAVE_MAPPING", mapping: { ...auto.mapping, source: "fldSource" } });
    assert.equal(selected.mapping.source, "fldSource");

    const started = await send({ type: "START_CAPTURE", site: "linkedin" });
    assert.equal(started.error, undefined, started.error);
    const progress = await until(() => {
      const status = store.get("capture_progress")?.status;
      return status === "complete" || status === "error" ? store.get("capture_progress") : null;
    }, "the sync to finish");
    assert.equal(progress.status, "complete", progress.message);
    assert.equal(store.get("capture_results").total, CONNECTIONS);

    const rows = airtable.byLinkedIn();
    assert.equal(rows.size, CONNECTIONS);
    const ada = rows.get("https://www.linkedin.com/in/ada-number-0").fields;
    assert.equal(ada.fldName, "Ada Number0");
    assert.equal(ada.fldHeadline, "Engineer");
    assert.equal(ada.fldConnected, "2023-11-14");
    assert.equal(ada.fldSource, "LinkedIn connection");
    assert.equal(ada.fldDegree, "1st");
    assert.ok(linkedin.profileRequests > 0, "the full sync never enriched anyone");

    // The scheduled refresh over an unchanged network: nobody is re-enriched
    // (they all have rows) and no cell moved, so Airtable hears nothing.
    const writesBefore = airtable.writes().length;
    const profilesBefore = linkedin.profileRequests;
    store.set("capture_progress", { status: "idle" });
    fireAlarm("earthos-soft-sync");
    const soft = await until(() => {
      const status = store.get("earthos_soft_sync_status");
      return status?.completed || status?.failed || status?.skipped ? status : null;
    }, "the soft sync to finish");
    assert.equal(soft.completed, true, JSON.stringify(soft));
    assert.equal(linkedin.profileRequests, profilesBefore, "soft sync re-enriched people already in the table");
    assert.equal(airtable.writes().length, writesBefore, "an unchanged network cost Airtable writes");
    assert.equal(store.get("capture_progress").status, "idle", "a scheduled run published progress");
  } finally {
    await send({ type: "CANCEL_SYNC" }).catch(() => {});
    restore();
  }
});

test("only the extension's own pages can command it", async () => {
  const { send, store, restore } = await bootWorker();
  try {
    const response = await send(
      { type: "AIRTABLE_CONNECT", token: "patEVIL.0123456789abcdef" },
      { id: "someotherextensionid", url: "https://evil.example/", tab: { id: 1 } },
    );
    assert.match(response.error, /outside the extension/);
    assert.equal(store.get("airtable_config"), undefined);
  } finally {
    restore();
  }
});

const finished = (store) => {
  const status = store.get("capture_progress")?.status;
  return status === "complete" || status === "error" ? store.get("capture_progress") : null;
};

test("a test sync runs the same pipeline over just ten people, then the full sync picks up the rest", async () => {
  const airtable = fakeAirtable();
  const { linkedin, fetchImpl } = network(airtable, { connections: 25 });
  const { store, send, fireAlarm, restore } = await bootWorker({ fetch: fetchImpl, cookies: signedInToLinkedIn });
  try {
    await send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
    await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: TABLE_ID });

    const started = await send({ type: "START_CAPTURE", site: "linkedin", sample: true });
    assert.equal(started.error, undefined, started.error);
    const test1 = await until(() => finished(store), "the test sync to finish");
    assert.equal(test1.status, "complete", test1.message);
    assert.match(test1.message, /Test sync/);
    assert.equal(airtable.table.records.size, 10);
    assert.equal(airtable.byLinkedIn().get("https://www.linkedin.com/in/ada-number-9").fields.fldHeadline, "Engineer");
    assert.equal(airtable.byLinkedIn().has("https://www.linkedin.com/in/ada-number-10"), false);
    assert.ok(linkedin.profileRequests > 0, "the test skipped the profile pass");
    assert.equal(store.get("capture_results").sample, true);

    // Ten people prove the setup, not a choice to import the network: the
    // unattended schedule stays locked until a real sync.
    fireAlarm("earthos-soft-sync");
    const soft = await until(() => store.get("earthos_soft_sync_status"), "the schedule to decide");
    assert.equal(soft.skipped, "no_initial_sync");

    store.set("capture_progress", { status: "idle" });
    await send({ type: "START_CAPTURE", site: "linkedin" });
    const full = await until(() => finished(store), "the full sync to finish");
    assert.equal(full.status, "complete", full.message);
    assert.equal(airtable.table.records.size, 25, "the full sync duplicated or dropped the test rows");
    assert.equal(store.get("capture_results").sample, false);
  } finally {
    await send({ type: "CANCEL_SYNC" }).catch(() => {});
    restore();
  }
});

test("pasted LinkedIn URLs are enriched in the background and land in Airtable", async () => {
  const airtable = fakeAirtable();
  const { linkedin, fetchImpl } = network(airtable);
  const { store, send, restore } = await bootWorker({ fetch: fetchImpl, cookies: signedInToLinkedIn });
  try {
    await send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
    const auto = await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: TABLE_ID });
    await send({ type: "AIRTABLE_SAVE_MAPPING", mapping: { ...auto.mapping, source: "fldSource" } });

    // Messy paste: duplicates, trailing slashes, a company page, a blank line.
    const pasted = [
      ...Array.from({ length: 12 }, (_, index) => `https://www.linkedin.com/in/ada-number-${index}/`),
      "linkedin.com/in/ada-number-3",
      "https://www.linkedin.com/company/acme",
      "",
    ].join("\n");
    const started = await send({ type: "BULK_ENRICH", urls: pasted });
    assert.equal(started.error, undefined, started.error);
    assert.equal(started.total, 12);

    const done = await until(() => {
      const progress = store.get("enrich_progress");
      return progress?.status === "complete" || progress?.status === "error" ? progress : null;
    }, "the bulk enrich to finish", 60_000);
    assert.equal(done.status, "complete", done.message);
    assert.equal(airtable.table.records.size, 12);
    const ada = airtable.byLinkedIn().get("https://www.linkedin.com/in/ada-number-4").fields;
    assert.equal(ada.fldName, "Ada Number4");
    assert.equal(ada.fldSource, "Bulk enrich");
    assert.ok(linkedin.profileRequests >= 12);
    assert.equal(store.get("bulk_enrich_job").status, "complete");
  } finally {
    await send({ type: "CANCEL_SYNC" }).catch(() => {});
    restore();
  }
});

test("a bulk enrich interrupted by a worker restart picks up at its next batch", async () => {
  // A restarted worker starts with empty memory; in this process the sink
  // module outlives the boot, so drop what the previous test left in it.
  (await import("../lib/airtable-sink.js")).forgetTableState();
  const airtable = fakeAirtable();
  const { linkedin, fetchImpl } = network(airtable);
  const urls = Array.from({ length: 15 }, (_, index) => `https://www.linkedin.com/in/ada-number-${index}`);
  const { store, send, restore } = await bootWorker({
    fetch: fetchImpl,
    cookies: signedInToLinkedIn,
    storage: {
      airtable_config: (await import("./helpers/fake-airtable.mjs")).airtableConfig(),
      bulk_enrich_job: {
        id: "job-1", urls, next: 10, created: 10, updated: 0, unchanged: 0, failed: 0,
        failedUrls: [], emptyBatches: 0, status: "running", startedAt: Date.now() - 60_000,
      },
    },
  });
  try {
    const done = await until(() => (store.get("bulk_enrich_job")?.status === "complete" ? store.get("bulk_enrich_job") : null),
      "the resumed job to finish", 60_000);
    assert.equal(done.next, 15);
    assert.equal(airtable.table.records.size, 5, "the resume re-did batches that were already written");
    assert.ok(!airtable.byLinkedIn().has("https://www.linkedin.com/in/ada-number-0"));
    assert.ok(linkedin.profileRequests < 15);
  } finally {
    await send({ type: "CANCEL_SYNC" }).catch(() => {});
    restore();
  }
});

test("setup on the Basanite base: linked tables, links, and marker land where the spec says", async () => {
  const { fakeBase } = await import("./helpers/fake-airtable.mjs");
  const layout = await import("./helpers/basanite-base.mjs");
  const base = fakeBase({ tables: layout.BASANITE_TABLES });
  const { send, restore } = await bootWorker({ fetch: base.handle });
  try {
    await send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
    const config = await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: layout.PEOPLE });
    assert.equal(config.problem, null);
    assert.equal(config.stampValue, "Added By Branch");
    assert.equal(config.mapping.createdStamp, "fldxnxDdEM3pbrs6X");
    assert.equal(config.mapping.referredBy, "fldmzPV4cmQLf8KV2");
    assert.equal(config.linked.companies.tableId, layout.COMPANIES);
    assert.equal(config.linked.workHistory.tableId, layout.WORK);
    assert.equal(config.linked.schools.tableId, layout.EDUCATION);
    assert.deepEqual(config.linked.peopleLinks, { workedAt: "flddIyGX4W7BKfj19", currentCompany: "fldbic0J90xFTmFJn", schools: "fldSPy2fWWELX0wKZ" });
    assert.deepEqual(config.linkedReady, { companies: true, workHistory: true, schools: true, workedAt: true, currentCompany: true, schoolsLink: true });

    // One table can't play two parts.
    const refused = await send({ type: "AIRTABLE_SAVE_LINKED", linked: { ...config.linked, workHistory: { ...config.linked.workHistory, tableId: layout.COMPANIES } } });
    assert.match(refused.error, /different table/);

    // Switching Schools off keeps it off through a targeted re-match.
    const noSchools = { ...config.linked };
    delete noSchools.schools;
    const saved = await send({ type: "AIRTABLE_SAVE_LINKED", linked: noSchools });
    assert.equal(saved.linked.schools, undefined);
    assert.equal(saved.linked.peopleLinks.schools, undefined);
    const rematched = await send({ type: "AIRTABLE_SUGGEST_LINKED", only: "companies" });
    assert.equal(rematched.linked.schools, undefined, "a table set to None came back");
  } finally {
    restore();
  }
});

test("each table keeps its own mapping: switch away and back, and your edits are still there", async () => {
  const { fakeBase } = await import("./helpers/fake-airtable.mjs");
  const layout = await import("./helpers/basanite-base.mjs");
  const DEX = "tbltFO5Xa1tckP4Hy";
  const dex = {
    id: DEX,
    name: "Dex Contacts",
    fields: [
      { id: "fldDexName0000001", name: "Name", type: "singleLineText" },
      { id: "fldDexLinkedIn001", name: "LinkedIn", type: "url" },
      { id: "fldDexTitle000001", name: "Current title", type: "singleLineText" },
      { id: "fldDexNotes000001", name: "Notes", type: "multilineText" },
    ],
  };
  const base = fakeBase({ tables: [dex, ...layout.BASANITE_TABLES] });
  const { send, restore } = await bootWorker({ fetch: base.handle });
  try {
    await send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
    const listed = await send({ type: "AIRTABLE_LIST_TABLES", baseId: BASE_ID });
    assert.equal(listed.suggested, layout.PEOPLE, "setup didn't start on People");

    // Dex: drop the title, send Headline into Notes instead.
    const dexAuto = await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: DEX });
    assert.equal(dexAuto.mapping.title, "fldDexTitle000001");
    assert.ok(dexAuto.peopleMismatch, "no warning that Work history links people elsewhere");
    const { title, ...rest } = dexAuto.mapping;
    void title;
    await send({ type: "AIRTABLE_SAVE_MAPPING", mapping: { ...rest, headline: "fldDexNotes000001" } });

    // People: its own mapping, matched by name, and editable.
    const people = await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: layout.PEOPLE });
    assert.equal(people.mapping.linkedinUrl, "fldvyrmtV2q06ip6k");
    assert.equal(people.peopleMismatch, null);
    assert.equal(people.linked.workHistory.tableId, layout.WORK);
    await send({ type: "AIRTABLE_SAVE_MAPPING", mapping: { ...people.mapping, location: undefined } });

    // Back to Dex: your edits, not a fresh auto-match.
    const dexAgain = await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: DEX });
    assert.equal(dexAgain.mapping.title, undefined, "the removed Title mapping came back");
    assert.equal(dexAgain.mapping.headline, "fldDexNotes000001");

    // And People again: still without Location, still with its linked tables.
    const peopleAgain = await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: layout.PEOPLE });
    assert.equal(peopleAgain.mapping.location, undefined);
    assert.equal(peopleAgain.mapping.name, "fldqwePau2SiMdzzW");
    assert.equal(peopleAgain.linked.companies.tableId, layout.COMPANIES);
  } finally {
    restore();
  }
});

test("a setup pointing at Dex Contacts moves itself to People, and the test sync lands there", async () => {
  const { fakeBase } = await import("./helpers/fake-airtable.mjs");
  const layout = await import("./helpers/basanite-base.mjs");
  const { summarizeTables } = await import("../lib/airtable-sink.js");
  const DEX = "tbltFO5Xa1tckP4Hy";
  const dex = {
    id: DEX,
    name: "Dex Contacts",
    fields: [
      { id: "fldDexName0000001", name: "Name", type: "singleLineText" },
      { id: "fldDexLinkedIn001", name: "LinkedIn", type: "url" },
    ],
  };
  const tables = [dex, ...layout.BASANITE_TABLES];
  const base = fakeBase({ tables });
  const airtable = { handle: base.handle };
  const { linkedin, fetchImpl } = network(airtable, { connections: 12 });
  // The saved state from the first live test: Dex Contacts, no linked tables.
  const { store, send, restore } = await bootWorker({
    fetch: fetchImpl,
    cookies: signedInToLinkedIn,
    storage: {
      airtable_config: {
        token: "patTESTTOKEN.0123456789abcdef",
        bases: [{ id: BASE_ID, name: "Basanite OS — Live", permissionLevel: "create" }],
        baseId: BASE_ID,
        baseName: "Basanite OS — Live",
        tableId: DEX,
        tableName: "Dex Contacts",
        fields: dex.fields,
        mapping: { name: "fldDexName0000001", linkedinUrl: "fldDexLinkedIn001" },
        linked: { peopleLinks: {} },
        baseTables: summarizeTables(tables),
        schemaAt: Date.now(),
      },
    },
  });
  try {
    const config = await send({ type: "AIRTABLE_GET_CONFIG" });
    assert.equal(config.tableId, layout.PEOPLE, "setup still points at Dex Contacts");
    assert.equal(config.problem, null);
    assert.match(config.notice, /Now writing to People, not Dex Contacts/);
    assert.equal(config.linked.workHistory.tableId, layout.WORK);

    const started = await send({ type: "START_CAPTURE", site: "linkedin", sample: true });
    assert.equal(started.error, undefined, started.error);
    const done = await until(() => {
      const status = store.get("capture_progress")?.status;
      return status === "complete" || status === "error" ? store.get("capture_progress") : null;
    }, "the test sync to finish");
    assert.equal(done.status, "complete", done.message);
    assert.equal(base.rows(layout.PEOPLE).length, 10, "the test didn't land in People");
    assert.equal(base.rows(DEX).length, 0, "something was written to Dex Contacts");
    const ada = base.rows(layout.PEOPLE).find((row) => row.fields.fldvyrmtV2q06ip6k === "https://www.linkedin.com/in/ada-number-3");
    assert.equal(ada.fields.fldqwePau2SiMdzzW, "Ada Number3");
    assert.equal(ada.fields.fldxnxDdEM3pbrs6X, "Added By Branch");
    assert.ok(linkedin.profileRequests > 0);
  } finally {
    await send({ type: "CANCEL_SYNC" }).catch(() => {});
    restore();
  }
});

test("pressing sync again and again (test, full, refresh) never duplicates a person", async () => {
  const { fakeBase } = await import("./helpers/fake-airtable.mjs");
  const layout = await import("./helpers/basanite-base.mjs");
  (await import("../lib/airtable-sink.js")).forgetTableState();
  const base = fakeBase({ tables: layout.BASANITE_TABLES });
  const { fetchImpl } = network({ handle: base.handle }, { connections: 14 });
  const { store, send, restore } = await bootWorker({ fetch: fetchImpl, cookies: signedInToLinkedIn });
  const runOnce = async (message) => {
    store.set("capture_progress", { status: "idle" });
    const started = await send({ type: "START_CAPTURE", site: "linkedin", ...message });
    assert.equal(started.error, undefined, started.error);
    const done = await until(() => {
      const status = store.get("capture_progress")?.status;
      return status === "complete" || status === "error" ? store.get("capture_progress") : null;
    }, "a sync to finish", 60_000);
    assert.equal(done.status, "complete", done.message);
  };
  try {
    await send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
    await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: layout.PEOPLE });
    await runOnce({ sample: true });
    await runOnce({ sample: true });
    await runOnce({ mode: "full" });
    await runOnce({ mode: "soft" });
    await runOnce({ mode: "full" });
    const urls = base.rows(layout.PEOPLE).map((row) => row.fields.fldvyrmtV2q06ip6k);
    assert.equal(urls.length, 14);
    assert.equal(new Set(urls).size, 14, "a person was written twice");
  } finally {
    await send({ type: "CANCEL_SYNC" }).catch(() => {});
    restore();
  }
});

test("a test sync interrupted by a worker restart resumes as a test, not a full sync", async () => {
  const airtable = fakeAirtable();
  let slow = 400;
  const { fetchImpl } = network(airtable, { connections: 250, slowMs: (url) => (url.includes("/voyager/") ? slow : 0) });
  const first = await bootWorker({ fetch: fetchImpl, cookies: signedInToLinkedIn });
  await first.send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
  await first.send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: TABLE_ID });
  await first.send({ type: "START_CAPTURE", site: "linkedin", sample: true });
  await until(() => first.store.get("earthos_li_progress")?.importId, "a checkpoint");
  assert.equal(first.store.get("earthos_li_progress").sampleLimit, 10, "the checkpoint forgot it's a test");
  const saved = Object.fromEntries([...first.store.entries()].map(([key, value]) => [key, structuredClone(value)]));
  slow = 0;
  const second = await bootWorker({ fetch: fetchImpl, cookies: signedInToLinkedIn, storage: saved });
  try {
    const done = await until(() => {
      const status = second.store.get("capture_progress")?.status;
      return status === "complete" || status === "error" ? second.store.get("capture_progress") : null;
    }, "the resumed run", 60_000);
    assert.equal(done.status, "complete", done.message);
    assert.equal(airtable.table.records.size, 10, "the resumed test synced more than 10 people");
    assert.equal(second.store.get("capture_results").sample, true);
  } finally {
    await second.send({ type: "CANCEL_SYNC" }).catch(() => {});
    second.restore();
  }
});

test("a full sync asked for while a test is starting is refused, not merged into it", async () => {
  const airtable = fakeAirtable();
  const { fetchImpl } = network(airtable, { connections: 40, slowMs: (url) => (url.includes("/voyager/") ? 300 : 0) });
  const { store, send, restore } = await bootWorker({ fetch: fetchImpl, cookies: signedInToLinkedIn });
  try {
    await send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
    await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: TABLE_ID });
    const test = await send({ type: "START_CAPTURE", site: "linkedin", sample: true });
    const full = await send({ type: "START_CAPTURE", site: "linkedin" });
    assert.equal(test.started, true);
    assert.match(full.error || "", /test sync is running/);
    const done = await until(() => {
      const status = store.get("capture_progress")?.status;
      return status === "complete" || status === "error" ? store.get("capture_progress") : null;
    }, "the test to finish", 60_000);
    assert.equal(done.status, "complete", done.message);
    assert.equal(airtable.table.records.size, 10);
  } finally {
    await send({ type: "CANCEL_SYNC" }).catch(() => {});
    restore();
  }
});

test("two sync starts at the same moment finish once, not stuck on starting", async () => {
  const airtable = fakeAirtable();
  const { fetchImpl } = network(airtable);
  const { store, send, restore } = await bootWorker({ fetch: fetchImpl, cookies: signedInToLinkedIn });
  try {
    await send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
    await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: TABLE_ID });
    const [one, two] = await Promise.all([
      send({ type: "START_CAPTURE", site: "linkedin" }),
      send({ type: "START_CAPTURE", site: "linkedin" }),
    ]);
    assert.equal(one.runId, two.runId, "two runs were started");
    const done = await until(() => {
      const status = store.get("capture_progress")?.status;
      return status === "complete" || status === "error" ? store.get("capture_progress") : null;
    }, "the sync to finish", 20_000);
    assert.equal(done.status, "complete", done.message);
    assert.equal(done.runId, one.runId);
    assert.ok(store.get("capture_results"));
  } finally {
    await send({ type: "CANCEL_SYNC" }).catch(() => {});
    restore();
  }
});

test("a test sync after a real one doesn't switch the schedule off", async () => {
  const airtable = fakeAirtable();
  const { fetchImpl } = network(airtable, { connections: 12 });
  const { store, send, fireAlarm, restore } = await bootWorker({ fetch: fetchImpl, cookies: signedInToLinkedIn });
  const runOnce = async (message) => {
    store.set("capture_progress", { status: "idle" });
    await send({ type: "START_CAPTURE", site: "linkedin", ...message });
    return until(() => {
      const status = store.get("capture_progress")?.status;
      return status === "complete" || status === "error" ? store.get("capture_progress") : null;
    }, "a sync to finish", 60_000);
  };
  try {
    await send({ type: "AIRTABLE_CONNECT", token: "patTESTTOKEN.0123456789abcdef" });
    await send({ type: "AIRTABLE_SELECT_TABLE", baseId: BASE_ID, tableId: TABLE_ID });
    await runOnce({ mode: "full" });
    await runOnce({ sample: true });
    store.set("capture_progress", { status: "idle" });
    fireAlarm("earthos-soft-sync");
    const soft = await until(() => {
      const status = store.get("earthos_soft_sync_status");
      return status?.completed || status?.failed || status?.skipped ? status : null;
    }, "the schedule to act", 60_000);
    assert.notEqual(soft.skipped, "no_initial_sync", "a test sync turned the schedule off");
  } finally {
    await send({ type: "CANCEL_SYNC" }).catch(() => {});
    restore();
  }
});
