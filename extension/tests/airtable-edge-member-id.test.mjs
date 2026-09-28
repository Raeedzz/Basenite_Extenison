import test from "node:test";
import assert from "node:assert/strict";
import { PEOPLE, person, setup, sink } from "./helpers/image-harness.mjs";
test("without a recreate, a restart + new URL for the same member id updates the row", async () => {
  const { base } = setup();
  await sink.writePeople([person("ada-old", { memberId: "ACoAAada" })]);
  await sink.writePeople([person("ada-old", { memberId: "ACoAAada", headline: "Changed" })]);
  sink.forgetTableState();
  await sink.writePeople([person("ada-new", { memberId: "ACoAAada", name: "Person ada-old" })]);
  assert.equal(base.rows(PEOPLE).length, 1);
});
