import test from "node:test";
import assert from "node:assert/strict";
const H = "./helpers/image-harness.mjs";
const { P, PEOPLE, person, setup, sink } = await import(H);
const MARKER = "fldxnxDdEM3pbrs6X";

test("a select choice removed in Airtable since the schema was read doesn't fail the create", async () => {
  const { base } = setup();
  // Someone tidies the marker column's choices (schema cached for up to 6h).
  const live = base.state.get(PEOPLE);
  live.fields = live.fields.map((f) => (f.id === MARKER
    ? { ...f, options: { choices: f.options.choices.filter((c) => c.name !== "Added By Branch") } } : f));
  const tally = await sink.writePeople([person("ada"), person("bo")]);
  assert.equal(tally.failed, 0, `creates failed: ${tally.errors[0]}`);
  assert.equal(base.rows(PEOPLE).length, 2);
});
