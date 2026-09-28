/**
 * Known by on a setup saved before it existed, and across two people syncing
 * the same contact: everyone who has them ends up listed, nobody is removed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { offerNewMappings, seenMappings, suggestMapping } from "../lib/airtable-fields.js";
import { BASANITE_TABLES, P, PEOPLE, person, setup, sink, store } from "./helpers/image-harness.mjs";

const PEOPLE_FIELDS = BASANITE_TABLES.find((table) => table.id === PEOPLE).fields;
const ME = "usrME000000000001";
const COLLEAGUE = "usrCOLLEAGUE00001";
const knownBy = (row) => (row.fields[P.knownBy] || []).map((user) => user.id);

test("a setup saved before Known by existed picks it up, and adds you next to whoever already knows them", async () => {
  // Saved mapping without Known by, from before it was tracked; schema due a refresh.
  const { base } = setup({
    [PEOPLE]: [{ id: "recSHAREDCONTACT1", fields: { [P.name]: "Shared", [P.linkedin]: "https://www.linkedin.com/in/shared", [P.knownBy]: [{ id: COLLEAGUE }] } }],
  }, { mapping: { knownBy: undefined, photo: undefined }, config: { schemaAt: 0 } });
  await sink.writePeople([person("shared"), person("mine-only")]);
  const config = store.get("airtable_config");
  assert.equal(config.mapping.knownBy, P.knownBy, "Known by never got mapped");
  const rows = base.rows(PEOPLE);
  assert.deepEqual(knownBy(rows.find((row) => row.id === "recSHAREDCONTACT1")), [COLLEAGUE, ME]);
  assert.deepEqual(knownBy(rows.find((row) => row.fields[P.name] === "Person mine-only")), [ME]);
});

test("the same contact synced by two people lists both, in either order, and never drops one", async () => {
  const { base } = setup();
  await sink.writePeople([person("both")]);
  // The colleague's extension: their own token, their own local state.
  const mine = store.get("airtable_config");
  for (const key of [...store.keys()]) if (key !== "airtable_config") store.delete(key);
  sink.forgetTableState();
  store.set("airtable_config", { ...mine, userId: COLLEAGUE });
  await sink.writePeople([person("both")]);
  const [row] = base.rows(PEOPLE);
  assert.deepEqual(knownBy(row), [ME, COLLEAGUE]);

  // Back to me: nothing to add, nothing removed, no write.
  store.set("airtable_config", { ...mine });
  sink.forgetTableState();
  const writes = base.writes(PEOPLE).length;
  await sink.writePeople([person("both")]);
  assert.deepEqual(knownBy(row), [ME, COLLEAGUE]);
  assert.equal(base.writes(PEOPLE).length, writes);
});

test("a field you unmapped yourself stays unmapped; one never offered is mapped once its column appears", () => {
  const suggested = suggestMapping(PEOPLE_FIELDS);
  const { knownBy: _dropped, ...mapping } = suggested;
  // Saved from the panel with Known by deliberately left empty.
  const seen = seenMappings(PEOPLE_FIELDS, mapping, null);
  assert.equal(offerNewMappings(PEOPLE_FIELDS, mapping, seen).mapping.knownBy, undefined);

  // No Network column yet: not seen, so adding the column later maps it.
  const withoutNetwork = offerNewMappings(PEOPLE_FIELDS, suggested, seen);
  assert.equal(withoutNetwork.mapping.inNetwork, undefined);
  const added = [...PEOPLE_FIELDS, { id: "fldNETWORK0000001", name: "Network", type: "singleSelect", options: { choices: [] } }];
  assert.equal(offerNewMappings(added, suggested, withoutNetwork.mappingSeen).mapping.inNetwork, "fldNETWORK0000001");
});
