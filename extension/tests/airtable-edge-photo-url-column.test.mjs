import test from "node:test";
import assert from "node:assert/strict";
import { PEOPLE, P, cdn, person, setup, sink, store } from "./helpers/image-harness.mjs";
test("Photo mapped to a url column writes the URL once, re-signed URLs aren't re-sent, filled cell kept", async () => {
  const toUrl = (tables) => { tables.find((t) => t.id === PEOPLE).fields.find((f) => f.id === P.photo).type = "url"; return tables; };
  const { base, checked } = setup({}, { tables: toUrl });
  await sink.writePeople([person("ada")]);
  assert.equal(base.rows(PEOPLE)[0].fields[P.photo], cdn("photo-ada"));
  const n = base.writes(PEOPLE).length;
  await sink.writePeople([person("ada", { photoUrl: cdn("photo-ada", { t: "sig2" }) })]);
  assert.equal(base.writes(PEOPLE).length, n);
  await sink.writePeople([person("ada", { photoUrl: cdn("photo-new"), headline: "x" })]);
  assert.equal(base.rows(PEOPLE)[0].fields[P.photo], cdn("photo-ada"));
  // pre-change hashes: wipe stored hashes, cell filled -> not replaced
  sink.forgetTableState();
  for (const [k, v] of store) if (k.startsWith("airtable_rows:") && !k.endsWith(":meta")) for (const r of Object.values(v)) r.h = {};
  await sink.writePeople([person("ada", { photoUrl: cdn("photo-other") })]);
  assert.equal(base.rows(PEOPLE)[0].fields[P.photo], cdn("photo-ada"));
});
