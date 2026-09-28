/**
 * Mapping lifecycle and Known by: marker, collaborator block, retyped columns.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { BASANITE_TABLES, P, PEOPLE, fields, person, setup, sink, store } from "./helpers/image-harness.mjs";

const ME = "usrME000000000001";
const STAMP = "fldxnxDdEM3pbrs6X";
const peopleFields = (layout) => layout.find((t) => t.id === PEOPLE).fields;
const knownBy = (row) => (row.fields[P.knownBy] || []).map((u) => u.id);
const noPhoto = (slug) => { const p = person(slug); delete p.photoUrl; return p; };

test("a marker column auto-mapped by a refresh gets its stamp value", async () => {
  const without = (layout) => { const t = layout.find((x) => x.id === PEOPLE); t.fields = t.fields.filter((f) => f.id !== STAMP); return layout; };
  const f0 = peopleFields(without(structuredClone(BASANITE_TABLES)));
  const mapping = fields.suggestMapping(f0);
  const { base } = setup({}, { tables: without, config: {
    fields: f0, mapping, mappingSeen: fields.seenMappings(f0, mapping), stampValue: null, schemaAt: 0,
  } });
  // Someone adds the "Enrichment review" column (with its "Added By Branch" choice).
  base.state.get(PEOPLE).fields.push(structuredClone(peopleFields(BASANITE_TABLES).find((f) => f.id === STAMP)));
  await sink.writePeople([noPhoto("fresh")]);
  const config = store.get("airtable_config");
  assert.equal(config.mapping.createdStamp, STAMP, "precondition: refresh auto-mapped the marker");
  const [row] = base.rows(PEOPLE);
  assert.equal(row.fields[STAMP], "Added By Branch", `marker mapped but off: stampValue=${config.stampValue}`);
});

test("rows that hit INVALID_COLLABORATOR get Known by once the block lifts (create)", async () => {
  const { base } = setup();
  base.faults.nonCollaborators.add(ME);
  await sink.writePeople([noPhoto("a")]);
  assert.equal(store.get("airtable_config").knownByBlocked, true);
  // Owner invites me; I clear the block (AIRTABLE_SET_SYNC_AS blank / reconnect both set knownByBlocked:false).
  base.faults.nonCollaborators.delete(ME);
  store.set("airtable_config", { ...store.get("airtable_config"), knownByBlocked: false });
  await sink.writePeople([noPhoto("a")]);
  const [row] = base.rows(PEOPLE);
  assert.deepEqual(knownBy(row), [ME]);
});

test("rows that hit INVALID_COLLABORATOR get Known by once the block lifts (update)", async () => {
  const { base } = setup({ [PEOPLE]: [{ id: "recEXISTING000001", fields: { [P.name]: "B", [P.linkedin]: "https://www.linkedin.com/in/b" } }] });
  base.faults.nonCollaborators.add(ME);
  await sink.writePeople([noPhoto("b")]);
  assert.equal(store.get("airtable_config").knownByBlocked, true);
  base.faults.nonCollaborators.delete(ME);
  store.set("airtable_config", { ...store.get("airtable_config"), knownByBlocked: false });
  await sink.writePeople([noPhoto("b")]);
  assert.deepEqual(knownBy(base.rows(PEOPLE)[0]), [ME]);
});

test("a column retyped away and back is mapped again", async () => {
  const f0 = peopleFields(BASANITE_TABLES);
  const mapping = fields.suggestMapping(f0);
  const { base } = setup({}, { config: { mappingSeen: fields.seenMappings(f0, mapping) } });
  const col = base.state.get(PEOPLE).fields.find((f) => f.id === P.knownBy);
  col.type = "singleLineText";
  await sink.prepareTable({ force: true });
  assert.equal(store.get("airtable_config").mapping.knownBy, undefined, "precondition: dropped while text");
  col.type = "multipleCollaborators";
  await sink.prepareTable({ force: true });
  assert.equal(store.get("airtable_config").mapping.knownBy, P.knownBy);
});
