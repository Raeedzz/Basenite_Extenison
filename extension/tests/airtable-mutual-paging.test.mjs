import test from "node:test";
import assert from "node:assert/strict";
const ROOT = "./helpers";
const { bootWorker } = await import(`${ROOT}/worker-harness.mjs`);
const { airtableConfig, fakeAirtable } = await import(`${ROOT}/fake-airtable.mjs`);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Stop during a big target's mutual paging stops the paging", async () => {
  const airtable = fakeAirtable();
  const searches = [];
  let page = 0;
  const cookies = { get: async ({ name }) => ({ value: name === "JSESSIONID" ? '"ajax:1234"' : `${name}-value` }) };
  const fetchImpl = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.airtable.com/")) return airtable.handle(input, init);
    if (url.includes("/search/dash/clusters")) {
      searches.push(url);
      const p = page++;
      const items = Array.from({ length: 49 }, (_, i) => ({ item: { entityResult: {
        title: { text: `Bridge ${p}-${i}` }, navigationUrl: `https://www.linkedin.com/in/bridge-${p}-${i}`, entityUrn: `urn:${p}-${i}` } } }));
      return json({ metadata: { totalResultCount: 900 }, elements: [{ items }] });
    }
    if (url.includes("/identity/dash/profiles") || url.includes("profile")) {
      return json({ elements: [{ entityUrn: "urn:li:fsd_profile:ACoAAbig", publicIdentifier: "target-big", firstName: "Big", lastName: "Target" }] });
    }
    return json({});
  };
  const worker = await bootWorker({ fetch: fetchImpl, storage: { airtable_config: airtableConfig() }, cookies });
  try {
    const started = await worker.send({ type: "START_MUTUAL_FINDING", contacts: [{ linkedinUrl: "https://www.linkedin.com/in/target-big" }] });
    assert.equal(started.started, true, JSON.stringify(started));
    const t0 = Date.now();
    while (searches.length < 1 && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(searches.length >= 1, "sanity: paging started");
    assert.equal((await worker.send({ type: "CANCEL_SYNC" })).canceled, true);
    const before = searches.length;
    await new Promise((r) => setTimeout(r, 6000));
    assert.ok(searches.length <= before + 1, `LinkedIn search paging continued after Stop: ${before} → ${searches.length}`);
  } finally {
    worker.restore();
  }
});
