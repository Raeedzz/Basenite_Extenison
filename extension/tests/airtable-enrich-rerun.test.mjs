/**
 * Table enrich run again and again, through the ways a run can end badly —
 * Stop mid-write, creates that saved but answered 500, a restarted worker,
 * two tables started at once, an Add landing mid-batch, messy URLs — and every
 * table in the base still holds one row per person, company, school, and job.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bootWorker } from "./helpers/worker-harness.mjs";
import { BASE_ID, fakeBase } from "./helpers/fake-airtable.mjs";
import { BASANITE_TABLES, COMPANIES, EDUCATION, PEOPLE, WORK } from "./helpers/basanite-base.mjs";
import { normalizeName, suggestMapping } from "../lib/airtable-fields.js";
import { suggestLinked } from "../lib/airtable-linked.js";
import * as sink from "../lib/airtable-sink.js";

const P_LINKEDIN = "fldvyrmtV2q06ip6k";
const C_NAME = "fldzBJ1c98Y5wviTm";
const E_NAME = "fldk389mX9pLnMj62";
const W = { title: "fldXwAfDqpN13BSwM", company: "flduTDvxs0L1eWyWD", person: "fldjmSvXmRCd98JMk", start: "fldfsvlMrvrGJCdFA" };
const SOURCES = ["tblDexA0000000001", "tblDexB0000000001"];
const URL_FIELD = "fldDexLinkedIn001";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const vec = (key) => ({ vectorImage: { rootUrl: `https://media.licdn.com/dms/image/v2/${key}/x_`,
  artifacts: [{ width: 200, height: 200, fileIdentifyingUrlPathSegment: "200?e=9999999999&t=x" }] } });
const signedIn = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };
const slug = (n) => `ada-${n}`;
const url = (n) => `https://www.linkedin.com/in/${slug(n)}`;
const range = (from, to) => Array.from({ length: to - from }, (_, index) => from + index);

/** Everyone shares one past company; current companies and schools overlap in small groups. */
function profile(n) {
  const jobs = [[1000 + (n % 4), 2021], [2000, 2012]];
  return {
    entityUrn: `urn:li:fsd_profile:ACoAA${n}`, publicIdentifier: slug(n), firstName: "Ada", lastName: String(n), headline: `Role ${n}`,
    profilePicture: { displayImageReference: vec(`photo${n}`) },
    profilePositionGroups: { elements: jobs.map(([company, year]) => ({
      companyName: `Co ${company}`, company: { entityUrn: `urn:li:fsd_company:${company}`, name: `Co ${company}`, logo: vec(`logo${company}`) },
      profilePositionInPositionGroup: { elements: [{ title: `Title ${company}`, companyName: `Co ${company}`,
        companyUrn: `urn:li:fsd_company:${company}`, timePeriod: { startDate: { year, month: 1 } } }] },
    })) },
    profileEducations: { elements: [{ schoolName: `School ${n % 2}`, schoolUrn: `urn:li:fsd_school:${500 + (n % 2)}`,
      school: { entityUrn: `urn:li:fsd_school:${500 + (n % 2)}`, name: `School ${n % 2}`, logo: vec(`school${n % 2}`) },
      timePeriod: { startDate: { year: 2008 } } }] },
  };
}

/**
 * A fake LinkedIn and a strict fake of Basanite OS with two source tables.
 * `redirects` maps an old profile slug to the person it now belongs to.
 * `onAirtable(entry)` runs before each Airtable call and may return a promise to hold it.
 */
function world(sources, { redirects = {}, onAirtable = null } = {}) {
  const tables = SOURCES.map((id, index) => ({
    id, name: `Dex ${"AB"[index]}`, primaryFieldId: `fldDexName${"AB"[index]}000001`,
    fields: [{ id: `fldDexName${"AB"[index]}000001`, name: "Name", type: "singleLineText" }, { id: URL_FIELD, name: "LinkedIn", type: "multilineText" }],
    records: (sources[index] || []).map((cell, row) => ({ id: `recDex${"AB"[index]}${String(row).padStart(10, "0")}`, fields: { [URL_FIELD]: cell } })),
  }));
  const layout = [...BASANITE_TABLES.map((table) => ({ ...table, records: [] })), ...tables];
  const base = fakeBase({ baseId: BASE_ID, tables: layout });
  const fetchImpl = async (input, init = {}) => {
    const href = String(input);
    if (href.startsWith("https://api.airtable.com/") || href.startsWith("https://content.airtable.com/")) {
      await onAirtable?.({ method: (init.method || "GET").toUpperCase(), path: new URL(href).pathname });
      return base.handle(input, init);
    }
    if (href.includes("media.licdn.com")) return new Response(new Uint8Array(2_000), { headers: { "content-type": "image/jpeg" } });
    if (href.includes("/voyager/api/identity/dash/profiles")) {
      const asked = new URL(href, "https://www.linkedin.com").searchParams.get("memberIdentity") || "";
      const who = redirects[asked] || asked;
      const n = Number(who.replace("ada-", ""));
      return who.startsWith("ada-") && Number.isInteger(n) ? json({ elements: [profile(n)] }) : json({ elements: [] });
    }
    const company = href.match(/\/voyager\/api\/organization\/companies\/(\d+)/)?.[1];
    if (company) {
      return json({ elements: [{ entityUrn: `urn:li:fs_normalized_company:${company}`, universalName: `co-${company}`,
        name: `Co ${company}`, description: `About ${company}.`, companyPageUrl: "https://example.com" }] });
    }
    return json({});
  };
  const people = layout.find((table) => table.id === PEOPLE);
  const config = {
    token: "patTESTTOKEN.0123456789abcdef", userId: "usrME000000000001", baseId: BASE_ID, baseName: "Basanite", tableId: PEOPLE,
    tableName: "People", fields: people.fields, mapping: suggestMapping(people.fields), linked: suggestLinked(layout, PEOPLE),
    linkedChosen: true, baseTables: sink.summarizeTables(layout), schemaAt: Date.now(), stampValue: "Added By Branch",
  };
  return { base, fetchImpl, config };
}

async function boot(w, storage = { airtable_config: w.config }) {
  const worker = await bootWorker({ fetch: w.fetchImpl, cookies: signedIn, storage });
  // The sink outlives a boot in this process; a real restart starts it empty.
  sink.forgetTableState();
  return worker;
}

async function until(read, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settled = (store) => {
  const progress = store.get("enrich_progress");
  return ["complete", "error", "canceled"].includes(progress?.status) ? progress : null;
};

async function start(worker, tableId) {
  worker.store.set("enrich_progress", { status: "idle" });
  return worker.send({ type: "ENRICH_FROM_TABLE", tableId, fieldId: URL_FIELD });
}

/** Enrich one source table to the end; the job's counts. */
async function enrichTable(worker, tableId) {
  const started = await start(worker, tableId);
  assert.equal(started.error, undefined, started.error);
  const done = await until(() => settled(worker.store), "the table enrich to finish");
  assert.equal(done.status, "complete", done.message);
  return worker.store.get("bulk_enrich_job");
}

const creates = (base) => Object.fromEntries([PEOPLE, COMPANIES, EDUCATION, WORK]
  .map((table) => [table, base.log.filter((entry) => entry.method === "POST" && entry.path === `/v0/${BASE_ID}/${table}`).length]));

/**
 * Throws unless every table holds at most one row per real thing and the
 * sources are untouched. With `people`, the run is over: that many people,
 * and every one of their jobs.
 */
function assertNoDuplicates(base, { people } = {}) {
  const once = (label, values) => {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    assert.deepEqual([...counts].filter(([, count]) => count > 1), [], `${label} has duplicates`);
  };
  once("People", base.rows(PEOPLE).map((row) => String(row.fields[P_LINKEDIN]).toLowerCase().replace(/\/$/, "")));
  once("Companies", base.rows(COMPANIES).map((row) => normalizeName(row.fields[C_NAME])));
  once("Education", base.rows(EDUCATION).map((row) => normalizeName(row.fields[E_NAME])));
  once("Work history", base.rows(WORK).map((row) => [row.fields[W.person]?.[0], row.fields[W.company]?.[0],
    normalizeName(row.fields[W.title]), row.fields[W.start]].join("|")));
  for (const source of SOURCES) {
    assert.equal(base.log.some((entry) => entry.method !== "GET" && entry.path.endsWith(`/${source}`)), false, "a source table was written");
  }
  if (people === undefined) return;
  assert.equal(base.rows(PEOPLE).length, people);
  assert.equal(base.rows(WORK).length, people * 2, "a job is missing");
  assert.equal(base.rows(COMPANIES).length, 5);
  assert.equal(base.rows(EDUCATION).length, 2);
}

test("enriched again after the worker restarts (memory gone, storage kept): nothing new anywhere", async () => {
  const w = world([range(0, 12).map(url)]);
  let worker = await boot(w);
  try {
    await enrichTable(worker, SOURCES[0]);
    const before = creates(w.base);
    const kept = Object.fromEntries(worker.store);
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    worker.restore();
    worker = await boot(w, kept);
    const again = await enrichTable(worker, SOURCES[0]);
    assert.equal(again.created, 0);
    assert.deepEqual(creates(w.base), before, "the rerun created rows");
    assertNoDuplicates(w.base, { people: 12 });
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    worker.restore();
  }
});

test("two tables started at once: one runs, the other is refused, not silently dropped", async () => {
  const w = world([range(0, 6).map(url), range(20, 26).map(url)]);
  const worker = await boot(w);
  try {
    worker.store.set("enrich_progress", { status: "idle" });
    const replies = await Promise.all(SOURCES.map((tableId) => worker.send({ type: "ENRICH_FROM_TABLE", tableId, fieldId: URL_FIELD })));
    assert.equal(replies.filter((reply) => reply.started).length, 1, `both said started: ${JSON.stringify(replies)}`);
    assert.match(replies.find((reply) => !reply.started).error, /running/);
    const done = await until(() => settled(worker.store), "the enrich to finish");
    assert.equal(done.status, "complete", done.message);
    // The one that said it started is the one that ran.
    const ran = replies[0].started ? range(0, 6) : range(20, 26);
    assert.deepEqual(w.base.rows(PEOPLE).map((row) => row.fields[P_LINKEDIN]).sort(), ran.map(url).sort());
    assertNoDuplicates(w.base);
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    worker.restore();
  }
});

test("Stop while a batch is writing, then the table again: everyone once", async () => {
  let hold = null;
  let held = null;
  let peopleCreates = 0;
  const w = world([range(0, 30).map(url)], {
    onAirtable: ({ method, path }) => {
      // The second batch's People create waits for the test to press Stop.
      if (method === "POST" && path === `/v0/${BASE_ID}/${PEOPLE}` && ++peopleCreates === 2) {
        return new Promise((resolve) => { hold = resolve; held?.(); });
      }
      return null;
    },
  });
  const worker = await boot(w);
  try {
    worker.store.set("enrich_progress", { status: "idle" });
    const waiting = new Promise((resolve) => { held = resolve; });
    await worker.send({ type: "ENRICH_FROM_TABLE", tableId: SOURCES[0], fieldId: URL_FIELD });
    await waiting;
    await worker.send({ type: "CANCEL_SYNC" });
    hold();
    const stopped = await until(() => settled(worker.store), "the stop to land");
    assert.equal(stopped.status, "canceled");
    assertNoDuplicates(w.base);
    assert.ok(w.base.rows(PEOPLE).length < 30);
    // Pressed again straight away: refused only until the stopped run's last write lands.
    await until(async () => {
      const again = await start(worker, SOURCES[0]);
      assert.ok(again.started || /already running/.test(again.error), again.error);
      return again.started;
    }, "the stopped run to let go");
    const done = await until(() => settled(worker.store), "the rerun to finish");
    assert.equal(done.status, "complete", done.message);
    assertNoDuplicates(w.base, { people: 30 });
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    worker.restore();
  }
});

test("creates that saved but answered 500 mid-run, then resume and a rerun: everyone once", async () => {
  let peopleCreates = 0;
  const w = world([range(0, 30).map(url)], {
    onAirtable: ({ method, path }) => {
      // Once the first batch's people are in, the next creates of any table save and then fail.
      if (method === "POST" && path === `/v0/${BASE_ID}/${PEOPLE}` && ++peopleCreates === 2) w.base.faults.saveThenFail = 3;
      return null;
    },
  });
  const worker = await boot(w);
  try {
    worker.store.set("enrich_progress", { status: "idle" });
    await worker.send({ type: "ENRICH_FROM_TABLE", tableId: SOURCES[0], fieldId: URL_FIELD });
    const first = await until(() => settled(worker.store), "the first run to settle");
    assert.ok(w.base.log.some((entry) => entry.method === "POST") && w.base.faults.saveThenFail < 3, "the faults never fired");
    assertNoDuplicates(w.base);
    assert.equal(first.status, "error");
    // Resumed until it finishes: each fault left stops the run once.
    let last = first;
    for (let tries = 0; last.status === "error" && tries < 3; tries++) {
      worker.store.set("enrich_progress", { status: "idle" });
      const resumed = await worker.send({ type: "BULK_ENRICH_RESUME" });
      assert.equal(resumed.error, undefined, resumed.error);
      last = await until(() => settled(worker.store), "the resume to settle");
      assertNoDuplicates(w.base);
    }
    assert.equal(last.status, "complete", last.message);
    assertNoDuplicates(w.base, { people: 30 });
    await enrichTable(worker, SOURCES[0]);
    assertNoDuplicates(w.base, { people: 30 });
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    worker.restore();
  }
});

test("Add on a profile while the table enriches the same people: their writes don't collide", async () => {
  let hold = null;
  let held = null;
  let peopleCreates = 0;
  const w = world([range(0, 20).map(url)], {
    onAirtable: ({ method, path }) => {
      if (method === "POST" && path === `/v0/${BASE_ID}/${PEOPLE}` && ++peopleCreates === 1) {
        return new Promise((resolve) => { hold = resolve; held?.(); });
      }
      return null;
    },
  });
  const worker = await boot(w);
  try {
    worker.store.set("enrich_progress", { status: "idle" });
    const waiting = new Promise((resolve) => { held = resolve; });
    await worker.send({ type: "ENRICH_FROM_TABLE", tableId: SOURCES[0], fieldId: URL_FIELD });
    await waiting;
    // Someone in the batch being written, someone in the next, and someone new at a shared company.
    const added = worker.send({ type: "CAPTURE_PROFILES", urls: [url(2), url(12), url(40)] });
    const connections = await worker.send({ type: "START_CAPTURE", site: "linkedin" });
    assert.match(connections.error || "", /bulk enrich is running/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    hold();
    const reply = await added;
    assert.equal(reply.error, undefined, reply.error);
    const done = await until(() => settled(worker.store), "the enrich to finish");
    assert.equal(done.status, "complete", done.message);
    assertNoDuplicates(w.base, { people: 21 });
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    worker.restore();
  }
});

test("one person written many ways in the source column is one row", async () => {
  const cells = [
    `${url(1)}/`,
    "linkedin.com/in/ADA-1",
    "https://uk.linkedin.com/in/ada-1?trk=public_profile",
    "http://m.linkedin.com/in/ada-1#about",
    "https://www.linkedin.com/in/ada%2D1/details/experience/",
    // Links inside a notes cell: angle brackets, markdown, quotes.
    `Met at dinner <${url(1)}> and [Ada](${url(2)}), "${url(2)}"`,
    url(2),
    // An old URL that LinkedIn now answers with ada-3's profile, and ada-3 herself in another batch.
    "https://www.linkedin.com/in/ada-old-three",
    ...range(4, 14).map(url),
    url(3),
  ];
  const w = world([cells], { redirects: { "ada-old-three": slug(3) } });
  const worker = await boot(w);
  try {
    const job = await enrichTable(worker, SOURCES[0]);
    assert.equal(job.total, 14, "URL variants weren't folded into one");
    assert.equal(job.failed, 0);
    assertNoDuplicates(w.base, { people: 13 });
    assert.ok(w.base.rows(PEOPLE).some((row) => row.fields[P_LINKEDIN] === url(3)));
    await enrichTable(worker, SOURCES[0]);
    assertNoDuplicates(w.base, { people: 13 });
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    worker.restore();
  }
});
