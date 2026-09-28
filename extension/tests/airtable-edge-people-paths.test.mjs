import test from "node:test";
import assert from "node:assert/strict";
import { P, PEOPLE, cdn, person, setup, sink } from "./helpers/image-harness.mjs";

const rowsOf = (base) => base.rows(PEOPLE);
const byName = (base, name) => rowsOf(base).find((row) => row.fields[P.name] === name);

test("recreating a deleted row survives Known by being rejected", async () => {
  const { base } = setup();
  await sink.writePeople([person("ada")]);
  const [first] = rowsOf(base);
  // Deleted by hand in Airtable; meanwhile this user was removed as a collaborator.
  base.state.get(PEOPLE).records.delete(first.id);
  base.faults.nonCollaborators.add("usrME000000000001");
  const tally = await sink.writePeople([person("ada", { headline: "Changed" })]);
  assert.equal(tally.failed, 0, `recreate failed: ${tally.errors[0]}`);
  assert.equal(rowsOf(base).length, 1, "the deleted person wasn't recreated");
});

test("recreating in strict mode still sends held-back select values", async () => {
  // Source mapped (a select with no choices yet: typecast would add one).
  const { base } = setup({}, { mapping: { source: P.source } });
  await sink.writePeople([person("ada")], { source: "Sync" });
  const [first] = rowsOf(base);
  assert.equal(first.fields[P.source], "Sync", "sanity: a normal create gets Source via the follow-up update");
  base.state.get(PEOPLE).records.delete(first.id);
  await sink.writePeople([person("ada", { headline: "Changed" })], { source: "Sync" });
  const [again] = rowsOf(base);
  assert.equal(again.fields[P.headline], "Changed");
  assert.equal(again.fields[P.source], "Sync", "the recreated row never gets Source (no follow-up update on recreate)");
});

test("an ambiguous strict create that landed still gets its held-back values", async () => {
  const { base } = setup({}, { mapping: { source: P.source } });
  base.faults.saveThenFail = 1;
  const tally = await sink.writePeople([person("ada")], { source: "Sync" });
  assert.equal(tally.created, 1);
  assert.equal(rowsOf(base).length, 1, "sanity: no duplicate");
  assert.equal(rowsOf(base)[0].fields[P.source], "Sync", "Source is lost for a create whose response was ambiguous");
});

test("a recreated row keeps its member id", async () => {
  const { base } = setup();
  await sink.writePeople([person("ada-old", { memberId: "ACoAAada" })]);
  base.state.get(PEOPLE).records.delete(rowsOf(base)[0].id);
  await sink.writePeople([person("ada-old", { memberId: "ACoAAada", headline: "Changed" })]);
  assert.equal(rowsOf(base).length, 1, "sanity: recreated");
  sink.forgetTableState(); // the service worker restarted
  await sink.writePeople([person("ada-new", { memberId: "ACoAAada", name: "Person ada-old" })]);
  assert.equal(rowsOf(base).length, 1, "same member id under a new URL created a second row");
});

test("a photo that won't download doesn't cause timestamp-only writes", async () => {
  const addLastSynced = (tables) => {
    tables.find((table) => table.id === PEOPLE).fields.push(
      { id: "fldLastSynced0001", name: "Last synced", type: "dateTime", options: {} });
    return tables;
  };
  const { base } = setup({}, { broken: ["photo-bad"], tables: addLastSynced });
  await sink.writePeople([person("bad")]);
  const patches = () => base.writes(PEOPLE).filter((entry) => entry.method === "PATCH");
  const before = patches().length;
  // Nothing about this person changes between syncs.
  const t1 = await sink.writePeople([person("bad")]);
  const t2 = await sink.writePeople([person("bad")]);
  const sent = patches().slice(before).flatMap((entry) => entry.body.records.map((record) => Object.keys(record.fields)));
  assert.deepEqual(sent, [], `unchanged person was written ${sent.length} time(s): ${JSON.stringify(sent)}; tallies updated=${t1.updated},${t2.updated}`);
});
