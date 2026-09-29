// Images go to Airtable as uploaded bytes. Given a LinkedIn URL, Airtable fetches
// it later and silently drops the attachment when LinkedIn's CDN refuses it.
import test from "node:test";
import assert from "node:assert/strict";
import { BASE_ID, C, COMPANIES, P, PEOPLE, cdn, person, setup, sink, store } from "./helpers/image-harness.mjs";

const uploads = (base) => base.log.filter((entry) => entry.path.endsWith("/uploadAttachment"));
const recordWrites = (base) => base.log.filter((entry) => entry.method !== "GET" && !entry.path.endsWith("/uploadAttachment")
  && !entry.path.endsWith("/listRecords"));
const photoOf = (base, slug) => base.rows(PEOPLE).find((row) => row.fields[P.name] === `Person ${slug}`)?.fields[P.photo];

test("photos and logos are uploaded as bytes; no record write carries a LinkedIn URL", async () => {
  const { base } = setup();
  await sink.writePeople([person("ada", {
    experience: [{ title: "Partner", company: "Basanite", companyUrn: "urn:li:fsd_company:4242", isCurrent: true, companyLogoUrl: cdn("logo-b") }],
    _earthosEnrichment: { status: "complete" },
  })]);
  assert.equal(photoOf(base, "ada")[0].source, cdn("photo-ada"));
  assert.equal(photoOf(base, "ada")[0].filename, "ada.jpg");
  assert.equal(base.rows(COMPANIES)[0].fields[C.logo][0].source, cdn("logo-b"));
  assert.equal(uploads(base).length, 2);
  assert.ok(!JSON.stringify(recordWrites(base).map((entry) => entry.body)).includes("licdn.com"), "a LinkedIn URL went into a record write");
});

test("a failed upload leaves the cell blank, and the next sync uploads it", async () => {
  const { base } = setup();
  base.faults.partialAttachments = 1;
  const tally = await sink.writePeople([person("ada")]);
  assert.equal(tally.created, 1);
  assert.equal(photoOf(base, "ada"), undefined);
  await sink.writePeople([person("ada", { photoUrl: cdn("photo-ada", { t: "sig2" }) })]);
  assert.equal(photoOf(base, "ada")[0].source, cdn("photo-ada", { t: "sig2" }));
  assert.equal(photoOf(base, "ada").length, 1);
});

test("a create whose answer was lost but landed leaves its photo for the next sync", async () => {
  const { base } = setup();
  base.faults.saveThenFail = 1;
  await sink.writePeople([person("ada")]);
  assert.equal(base.rows(PEOPLE).length, 1);
  assert.equal(photoOf(base, "ada"), undefined);
  await sink.writePeople([person("ada")]);
  assert.equal(photoOf(base, "ada")[0].source, cdn("photo-ada"));
});

test("photo marks from URL-style writes are cleared once, so dropped photos come back", async () => {
  const { base } = setup();
  await sink.writePeople([person("ada"), person("bob")]);
  // What Airtable did to most URL attachments: dropped them after the write.
  delete base.rows(PEOPLE).find((row) => row.fields[P.name] === "Person ada").fields[P.photo];
  await sink.writePeople([person("ada")]);
  assert.equal(photoOf(base, "ada"), undefined, "a photo marked sent was re-sent without the reset");

  // An index saved before the fix.
  const meta = `airtable_rows:${BASE_ID}:${PEOPLE}:meta`;
  store.set(meta, { indexedAt: store.get(meta).indexedAt });
  sink.forgetTableState();
  const before = uploads(base).length;
  await sink.writePeople([person("ada"), person("bob")]);
  assert.equal(photoOf(base, "ada")[0].source, cdn("photo-ada"));
  assert.equal(photoOf(base, "bob").length, 1, "a photo that was there got another");
  assert.equal(uploads(base).length, before + 1);

  // Once only.
  sink.forgetTableState();
  delete base.rows(PEOPLE).find((row) => row.fields[P.name] === "Person ada").fields[P.photo];
  await sink.writePeople([person("ada")]);
  assert.equal(photoOf(base, "ada"), undefined);
});

test("an update's photo is downloaded once: the check's bytes are the ones uploaded", async () => {
  const { base, checked } = setup({
    [PEOPLE]: [{ id: "recPERSONBLANK001", fields: { [P.name]: "Person ada", [P.linkedin]: "https://www.linkedin.com/in/ada" } }],
  });
  await sink.writePeople([person("ada")]);
  assert.equal(photoOf(base, "ada")[0].source, cdn("photo-ada"));
  assert.deepEqual(checked, [cdn("photo-ada")]);
});

test("a row deleted in Airtable is recreated even when its only change is the photo", async () => {
  const { base } = setup({}, { broken: ["photo-ada"] });
  await sink.writePeople([person("ada")]);
  assert.equal(photoOf(base, "ada"), undefined);
  base.state.get(PEOPLE).records.delete(base.rows(PEOPLE)[0].id);
  const tally = await sink.writePeople([person("ada", { photoUrl: cdn("photo-new") })]);
  assert.equal(base.rows(PEOPLE).length, 1, "the deleted row wasn't recreated");
  assert.equal(tally.created, 1);
  assert.equal(photoOf(base, "ada")[0].source, cdn("photo-new"));
});
