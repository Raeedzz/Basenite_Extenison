/**
 * Claude's sourcing tools: filtered LinkedIn search, read-only profiles, and
 * searching the synced People table — against a fake LinkedIn and Airtable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { bootWorker, EXTENSION_ID } from "./helpers/worker-harness.mjs";
import { airtableConfig, fakeAirtable } from "./helpers/fake-airtable.mjs";
import { isBulkEnrichRunning } from "../background/bulk-enrich.js";

const KEEPALIVE = "keepalive";
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };
const hit = (id, distance = "DISTANCE_2") => ({ item: { entityResult: {
  title: { text: `Person ${id}` }, primarySubtitle: { text: "ML engineer" }, entityUrn: `urn:${id}`,
  navigationUrl: `https://www.linkedin.com/in/p-${id}`, entityCustomTrackingInfo: { memberDistance: distance },
} } });

function linkedin({ pages = [], total = 0, delayMs = 0, profileDelayMs = 0, failFrom = Infinity } = {}) {
  const everyone = pages.flat();
  const searches = [];
  const raw = [];
  const lookups = [];
  const fetch = async (input) => {
    const url = decodeURIComponent(String(input));
    if (url.includes("/search/dash/clusters")) {
      if (/resultType:List\((COMPANIES|SCHOOLS)\)/.test(url)) lookups.push(String(input));
      if (url.includes("resultType:List(COMPANIES)")) {
        return json({ elements: [{ items: [{ item: { entityResult: { title: { text: "Acme" }, entityUrn: "urn:li:fsd_company:42" } } }] }] });
      }
      if (url.includes("resultType:List(SCHOOLS)")) {
        return json({ elements: [{ items: [{ item: { entityResult: { title: { text: "Stanford University" }, entityUrn: "urn:li:fsd_company:1792" } } }] }] });
      }
      searches.push(url);
      raw.push(String(input));
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      // start and count, as LinkedIn serves them.
      const start = Number(url.match(/[?&]start=(\d+)/)[1]);
      if (start >= failFrom) return new Response("{}", { status: 500 });
      const count = Number(url.match(/[?&]count=(\d+)/)[1]);
      return json({ metadata: { totalResultCount: total }, elements: [{ items: everyone.slice(start, start + count) }] });
    }
    if (url.includes("memberIdentity=")) {
      if (profileDelayMs) await new Promise((resolve) => setTimeout(resolve, profileDelayMs));
      const id = url.match(/memberIdentity=([^&]+)/)[1];
      return json({ elements: [{
        entityUrn: `urn:li:fsd_profile:ACoAA-${id}`, publicIdentifier: id, firstName: "Jane", lastName: "Doe", headline: "Head of ML",
        summary: "x".repeat(3000),
        profilePositionGroups: { elements: [{ companyName: "Acme", profilePositionInPositionGroup: { elements: [
          { title: "Head of ML", companyName: "Acme", description: "y".repeat(2000), timePeriod: { startDate: { year: 2021 } } },
        ] } }] },
        profileEducations: { elements: [{ schoolName: "MIT", degreeName: "PhD", fieldOfStudy: "CS" }] },
      }] });
    }
    return json({});
  };
  return { fetch, searches, raw, lookups };
}

async function boot(fetch, config = airtableConfig()) {
  const airtable = fakeAirtable();
  const airtableWrites = [];
  const worker = await bootWorker({
    fetch: (input, init = {}) => {
      if (!String(input).startsWith("https://api.airtable.com/")) return fetch(input, init);
      if (init.method && init.method !== "GET" && !String(input).endsWith("/listRecords")) airtableWrites.push(String(input));
      return airtable.handle(input, init);
    },
    storage: { airtable_config: config },
    cookies,
  });
  return Object.assign(worker, { airtableWrites, airtable });
}

test("search combines keywords, degree, someone's connections and companies in one Voyager query", async () => {
  const li = linkedin({ pages: [[hit(1, "DISTANCE_1"), hit(2)]], total: 2 });
  const worker = await boot(li.fetch);
  try {
    const result = await worker.send({
      type: "FIND_PEOPLE", keywords: "ML (platform)", degrees: ["1st", "2nd", "bogus"],
      connectionOf: "https://www.linkedin.com/in/jane-doe/", companies: ["Acme"], pastCompanies: "Acme", schools: ["Stanford"],
      titles: ["staff engineer", "tech lead"], locationIds: ["102277331", "San Francisco"], industryIds: ["4"],
      profileLanguages: ["en", "english"], firstName: "Jane", lastName: "O'Doe",
    });
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.people.map((p) => [p.linkedinUrl, p.degree]), [
      ["https://www.linkedin.com/in/p-1", "1st"], ["https://www.linkedin.com/in/p-2", "2nd"],
    ]);
    assert.equal(result.nextStart, null, "LinkedIn ran out");
    assert.equal(result.connectionsOf, "Jane Doe");
    assert.deepEqual([result.companies, result.pastCompanies, result.schools], [["Acme"], ["Acme"], ["Stanford University"]]);
    assert.equal(li.searches.length, 1);
    const query = li.searches[0];
    assert.ok(query.includes("origin=FACETED_SEARCH"));
    assert.ok(query.includes("keywords:ML (platform),"), query);
    // On the wire the parens are encoded, or they'd close the query DSL early.
    assert.ok(li.raw[0].includes("keywords:ML%20%28platform%29,"), li.raw[0]);
    assert.ok(li.raw[0].includes("lastName:List(O%27Doe)"), "Rest.li reserves the apostrophe");
    // Facet names as Voyager honours them (checked live), sorted; bad ids dropped.
    assert.ok(query.includes("queryParameters:(connectionOf:List(ACoAA-jane-doe),currentCompany:List(42),firstName:List(Jane),"
      + "geoUrn:List(102277331),industry:List(4),lastName:List(O'Doe),network:List(F,S),pastCompany:List(42),profileLanguage:List(en),"
      + "resultType:List(PEOPLE),schoolFilter:List(1792),title:List(staff engineer,tech lead))"), query);
  } finally {
    worker.restore();
  }
});

test("a pasted LinkedIn search URL supplies its filters, and named arguments win", async () => {
  const li = linkedin({ pages: [[hit(1)]], total: 1 });
  const worker = await boot(li.fetch);
  try {
    const searchUrl = "https://www.linkedin.com/search/results/people/?keywords=founder&geoUrn=%5B%22103644278%22%2C%22bad%22%5D"
      + "&network=%5B%22F%22%2C%22S%22%5D&industry=%5B%224%22%5D&titleFreeText=CEO&origin=FACETED_SEARCH&sid=abc";
    const result = await worker.send({ type: "FIND_PEOPLE", searchUrl, degrees: ["3rd"] });
    assert.equal(result.error, undefined, result.error);
    assert.ok(li.searches[0].includes("keywords:founder,"), li.searches[0]);
    assert.ok(li.searches[0].includes("queryParameters:(geoUrn:List(103644278),industry:List(4),network:List(O),resultType:List(PEOPLE),title:List(CEO))"), li.searches[0]);
  } finally {
    worker.restore();
  }
});

test("search pages until the limit and hands back where to resume", async () => {
  const page = (from) => Array.from({ length: 49 }, (_, i) => hit(from + i));
  const li = linkedin({ pages: [page(0), page(49), page(98)], total: 500 });
  const worker = await boot(li.fetch);
  try {
    const result = await worker.send({ type: "FIND_PEOPLE", keywords: "ml", limit: 60 });
    assert.equal(result.people.length, 60);
    assert.equal(li.searches.length, 2);
    assert.ok(li.searches[0].includes("origin=GLOBAL_SEARCH_HEADER") && li.searches[0].includes("start=0"));
    // The second page asks only for the 11 still wanted, so nobody is skipped.
    assert.ok(li.searches[0].includes("count=49") && li.searches[1].includes("start=49&count=11"), li.searches[1]);
    assert.deepEqual(result.people.map((p) => p.linkedinUrl).slice(-2), ["https://www.linkedin.com/in/p-58", "https://www.linkedin.com/in/p-59"]);
    assert.equal(result.nextStart, 60);
    assert.equal(result.total, 500);
  } finally {
    worker.restore();
  }
});

test("search needs something to search by, and a real profile URL for connectionOf", async () => {
  const li = linkedin();
  const worker = await boot(li.fetch);
  try {
    assert.match((await worker.send({ type: "FIND_PEOPLE", degrees: ["2nd"], profileLanguages: ["en"] })).error, /keywords, a searchUrl/);
    assert.match((await worker.send({ type: "FIND_PEOPLE", searchUrl: "https://www.linkedin.com/in/someone" })).error, /people search/);
    const degreeOnly = "https://www.linkedin.com/search/results/people/?network=%5B%22S%22%5D&profileLanguage=%5B%22en%22%5D";
    assert.match((await worker.send({ type: "FIND_PEOPLE", searchUrl: degreeOnly })).error, /keywords, a searchUrl/);
    assert.match((await worker.send({ type: "FIND_PEOPLE", connectionOf: "https://evil.example/in/x" })).error, /LinkedIn profile URL/);
    assert.equal(li.searches.length, 0);
  } finally {
    worker.restore();
  }
});

test("get_profiles reads full profiles, trimmed, without writing to Airtable", async () => {
  const li = linkedin();
  const worker = await boot(li.fetch);
  try {
    const result = await worker.send({ type: "GET_PROFILES", urls: ["https://www.linkedin.com/in/jane-doe", "nope"] });
    assert.equal(result.error, undefined, result.error);
    const [jane] = result.profiles;
    assert.equal(jane.name, "Jane Doe");
    assert.equal(jane.experience[0].title, "Head of ML");
    assert.equal(jane.experience[0].end, "present");
    assert.ok(jane.experience[0].description.length <= 601);
    assert.ok(jane.about.length <= 1501);
    assert.equal(jane.education[0].school, "MIT");
    assert.ok(!JSON.stringify(jane).includes("photoUrl") && !JSON.stringify(jane).includes("Urn"), "no pictures or urns");
    assert.deepEqual(worker.airtableWrites, []);
    assert.match((await worker.send({ type: "GET_PROFILES", urls: Array.from({ length: 26 }, (_, i) => `https://www.linkedin.com/in/p${i}`) })).error, /at most 25/);
  } finally {
    worker.restore();
  }
});

test("one pasted profile URL adds that one person, and adding them again updates the same row", async () => {
  const li = linkedin();
  const worker = await boot(li.fetch);
  try {
    const first = await worker.send({ type: "CAPTURE_PROFILES", urls: ["https://www.linkedin.com/in/abrarfrahman/"] });
    assert.equal(first.error, undefined, first.error);
    assert.deepEqual([first.created, first.failed], [1, 0]);
    // Without a scheme, as people and Claude paste it.
    const again = await worker.send({ type: "CAPTURE_PROFILES", urls: ["linkedin.com/in/abrarfrahman"] });
    assert.equal(again.error, undefined, again.error);
    assert.deepEqual([again.created, again.captured], [0, 1]);
    const rows = [...worker.airtable.table.records.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fields.fldName, "Jane Doe");
    assert.match(rows[0].fields.fldLinkedIn, /linkedin\.com\/in\/abrarfrahman\/?$/);
  } finally {
    worker.restore();
  }
});

const until = async (check, what, ms = 60_000) => {
  for (const started = Date.now(); Date.now() - started < ms; await new Promise((r) => setTimeout(r, 100))) {
    const value = check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("capture_search pages every result, then enriches them all into People", async () => {
  const page = (from, n) => Array.from({ length: n }, (_, i) => hit(from + i));
  const li = linkedin({ pages: [page(0, 49), page(49, 3)], total: 52 });
  const worker = await boot(li.fetch);
  try {
    const started = await worker.send({ type: "CAPTURE_SEARCH", titles: ["founder"], companies: ["Acme"] });
    assert.equal(started.error, undefined, started.error);
    assert.deepEqual([started.started, started.found, started.total, started.nextStart, started.companies], [true, 52, 52, null, ["Acme"]]);
    assert.equal(started.people, undefined, "the URLs aren't echoed back");
    assert.equal(li.searches.length, 2);
    const job = await until(() => ["complete", "error"].includes(worker.store.get("bulk_enrich_job")?.status) && worker.store.get("bulk_enrich_job"), "the enrich");
    assert.equal(job.status, "complete", job.error);
    assert.equal(job.created, 52);
    assert.equal(worker.airtable.table.records.size, 52);
    const again = await worker.send({ type: "CAPTURE_SEARCH", titles: ["founder"], max: 3 });
    assert.equal(again.found, 3, JSON.stringify(again));
    assert.equal(again.nextStart, 3, "the rest starts right after the last one added");
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    // The second search's enrich outlives this worker in the test process: let it stop first.
    await until(() => !isBulkEnrichRunning(), "the enrich to stop");
    worker.restore();
  }
});

test("while capture_search pages, nothing else starts a LinkedIn run, and the worker is kept awake", async () => {
  const page = (from) => Array.from({ length: 49 }, (_, i) => hit(from + i));
  const li = linkedin({ pages: [page(0), page(49), page(98)], total: 147, delayMs: 700 });
  const worker = await boot(li.fetch);
  try {
    const before = worker.calls.length;
    const capture = worker.send({ type: "CAPTURE_SEARCH", keywords: "engineer" });
    await until(() => li.searches.length >= 1, "the first page");
    const armed = worker.calls.slice(before).filter(([name]) => name === "alarms.create").map(([, [alarm]]) => alarm);
    assert.ok(armed.includes(KEEPALIVE), `keep-alive armed for the paging: ${armed}`);
    for (const message of [
      { type: "CAPTURE_SEARCH", keywords: "other" },
      { type: "START_CAPTURE", site: "linkedin" },
      { type: "START_MUTUAL_FINDING", contacts: [{ linkedinUrl: "https://www.linkedin.com/in/x" }] },
      { type: "START_COMPANY_CAPTURE", company: "Acme" },
      { type: "BULK_ENRICH", urls: "https://www.linkedin.com/in/x" },
    ]) {
      assert.match((await worker.send(message)).error || "", /search is being added/, message.type);
    }
    const result = await capture;
    assert.equal(result.started, true, JSON.stringify(result));
    assert.equal(result.found, 147);
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    // The bulk enrich module outlives this worker in the test process: let its job stop first.
    await until(() => !isBulkEnrichRunning(), "the enrich to stop");
    worker.restore();
  }
});

test("a later page failing keeps everyone already found, says why, and where to continue", async () => {
  const page = (from) => Array.from({ length: 49 }, (_, i) => hit(from + i));
  const li = linkedin({ pages: [page(0), page(49), page(98)], total: 147, failFrom: 98 });
  const worker = await boot(li.fetch);
  try {
    const found = await worker.send({ type: "FIND_PEOPLE", keywords: "engineer", limit: 100 });
    assert.equal(found.error, undefined, found.error);
    assert.equal(found.people.length, 98);
    assert.equal(found.nextStart, 98);
    assert.match(found.warning, /Stopped early at 98: LinkedIn search failed \(500\).*start = nextStart/);
    assert.ok(found.people.every((person) => !("photoUrl" in person)), "no picture links for Claude");
    const captured = await worker.send({ type: "CAPTURE_SEARCH", keywords: "engineer" });
    assert.deepEqual([captured.started, captured.found, captured.nextStart], [true, 98, 98], JSON.stringify(captured));
    assert.match(captured.warning, /Stopped early/);
    await until(() => worker.store.get("bulk_enrich_job")?.status === "complete", "the enrich", 90_000);
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    await until(() => !isBulkEnrichRunning(), "the enrich to stop");
    worker.restore();
  }
});

test("capture_search input: max must be at least 1; names with parens stay inside the query", async () => {
  const li = linkedin({ pages: [[hit(1)]], total: 1 });
  const worker = await boot(li.fetch);
  try {
    for (const max of [0, 0.5, -3, "lots"]) {
      assert.match((await worker.send({ type: "CAPTURE_SEARCH", keywords: "x", max })).error || "", /max must be/, String(max));
    }
    assert.equal(li.searches.length, 0);
    await worker.send({ type: "FIND_PEOPLE", schools: ["King's College (London)"] });
    const lookup = li.lookups.find((url) => url.includes("SCHOOLS"));
    assert.ok(lookup.includes("keywords:King%27s%20College%20%28London%29,"), lookup);
    const far = await worker.send({ type: "FIND_PEOPLE", keywords: "x", start: 1e999 });
    assert.deepEqual([far.people.length, far.nextStart], [0, null], "nothing past LinkedIn's 1,000");
  } finally {
    worker.restore();
  }
});

test("a profile read still running when paging ends: capture waits for it and keeps the slot", async () => {
  const li = linkedin({ pages: [[hit(1), hit(2), hit(3)]], total: 3, delayMs: 600, profileDelayMs: 2500 });
  const worker = await boot(li.fetch);
  try {
    const capture = worker.send({ type: "CAPTURE_SEARCH", keywords: "x" });
    await until(() => li.searches.length >= 1, "the search");
    // Claude reads a profile while the search pages; the read outlasts the paging.
    const reading = worker.send({ type: "GET_PROFILES", urls: ["https://www.linkedin.com/in/slow"] });
    await new Promise((r) => setTimeout(r, 1200));
    const mutuals = await worker.send({ type: "START_MUTUAL_FINDING", contacts: [{ linkedinUrl: "https://www.linkedin.com/in/x" }] });
    assert.match(mutuals.error || "", /search is being added/, "the slot is still held while capture waits");
    assert.equal((await reading).error, undefined);
    const result = await capture;
    assert.deepEqual([result.started, result.found], [true, 3], JSON.stringify(result));
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    await until(() => !isBulkEnrichRunning(), "the enrich to stop");
    worker.restore();
  }
});

test("Stop during a capture_search's paging adds nobody", async () => {
  const page = (from) => Array.from({ length: 49 }, (_, i) => hit(from + i));
  const li = linkedin({ pages: Array.from({ length: 20 }, (_, i) => page(i * 49)), total: 1000 });
  const worker = await boot(li.fetch);
  try {
    const capture = worker.send({ type: "CAPTURE_SEARCH", keywords: "engineer" });
    await until(() => li.searches.length >= 1, "the first page");
    await worker.send({ type: "CANCEL_SYNC" });
    const result = await capture;
    assert.equal(result.canceled, true, JSON.stringify(result));
    assert.ok(li.searches.length <= 2, `kept paging after Stop: ${li.searches.length}`);
    assert.equal(worker.store.get("bulk_enrich_job"), undefined);
    assert.equal(worker.airtable.table.records.size, 0);
  } finally {
    worker.restore();
  }
});

test("with Claude control on and no server running, the extension never dials (a failed dial logs an error in Chrome)", async () => {
  const dials = [];
  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class { constructor(url) { dials.push(url); throw new Error("must not dial"); } };
  const probes = [];
  const worker = await bootWorker({
    fetch: async (input) => {
      if (String(input).startsWith("http://127.0.0.1:")) {
        probes.push(String(input));
        throw new TypeError("Failed to fetch");
      }
      return json({});
    },
    storage: { airtable_config: airtableConfig(), claude_bridge_enabled: true, claude_bridge_port: 17899 },
    cookies,
  });
  try {
    await until(() => probes.length >= 5, "the bridge to check every port for a server");
    await new Promise((r) => setTimeout(r, 200));
    // One server per Claude session, each on the next port up.
    // Each check names this extension, so another extension's server doesn't answer it.
    assert.deepEqual(probes.sort(), [17899, 17900, 17901, 17902, 17903].map((port) => `http://127.0.0.1:${port}/?ext=${EXTENSION_ID}`));
    assert.deepEqual(dials, [], "no WebSocket while nothing listens");
  } finally {
    await worker.send({ type: "CANCEL_SYNC" }).catch(() => {});
    worker.restore();
    globalThis.WebSocket = RealWebSocket;
  }
});

test("the MCP server offers the sourcing tools as read-only, and no way to send invitations", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../mcp/basanite-mcp.mjs", import.meta.url))], {
    env: { ...process.env, BASANITE_MCP_PORT: "0" }, stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    const replies = new Map();
    createInterface({ input: child.stdout }).on("line", (line) => { const reply = JSON.parse(line); replies.get(reply.id)?.(reply); });
    const rpc = (id, method) => new Promise((resolve) => {
      replies.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`);
    });
    const { result: { instructions } } = await rpc(1, "initialize");
    assert.match(instructions, /cannot read or search the records in Airtable/, "Claude is told the base can't be searched");
    const { result: { tools } } = await rpc(2, "tools/list");
    assert.match(tools.find((tool) => tool.name === "search_linkedin_people").description, /never the Airtable base/);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["search_linkedin_people", "get_profiles"]) {
      assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, name);
    }
    assert.notEqual(byName.get("capture_search")?.annotations?.readOnlyHint, true, "capture_search writes");
    const filters = (name) => Object.keys(byName.get(name).inputSchema.properties).filter((key) => !["start", "limit", "max"].includes(key)).sort();
    assert.deepEqual(filters("capture_search"), filters("search_linkedin_people"), "capture takes every search filter");
    assert.deepEqual(Object.keys(byName.get("search_linkedin_people").inputSchema.properties).sort(), [
      "companies", "connectionOf", "degrees", "firstName", "industryIds", "keywords", "lastName", "limit", "locationIds",
      "pastCompanies", "profileLanguages", "schools", "searchUrl", "start", "titles",
    ]);
    assert.ok(!tools.some((tool) => /invit|connect_with|send/i.test(tool.name)));
  } finally {
    child.kill();
  }
});
