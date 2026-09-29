/**
 * Photos and logos into Basanite OS — Live: blank-only, never re-sent for the
 * same image, placeholders and expired links skipped, a dead link skipped
 * without failing the rest of the record, and company logos fetched once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { attachmentFor, imageUrl, suggestMapping } from "../lib/airtable-fields.js";
import { suggestLinked } from "../lib/airtable-linked.js";
import { summarizeTables } from "../lib/airtable-sink.js";
import { BASE_ID, fakeBase } from "./helpers/fake-airtable.mjs";
import { BASANITE_TABLES, COMPANIES, EDUCATION, PEOPLE } from "./helpers/basanite-base.mjs";

const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.map((key) => [key, store.get(key)]));
      },
      async set(next) { for (const [key, value] of Object.entries(next)) store.set(key, value); },
      async remove(keys) { for (const key of [].concat(keys)) store.delete(key); },
    },
  },
};

const sink = await import("../lib/airtable-sink.js");
const linkedSync = await import("../lib/airtable-linked-sync.js");
const images = await import("../lib/image-check.js");

const PHOTO = "fldgPl6eKZLPIuLHw";
const NAME = "fldqwePau2SiMdzzW";
const HEADLINE = "fld3BmFW5JllGAygg";
const C = { name: "fldzBJ1c98Y5wviTm", logo: "fldXCHnaWiGzwjjUW" };
const E = { name: "fldk389mX9pLnMj62", logo: "fldgTt4dOwtEVRLNc" };

const later = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
const past = Math.floor(Date.now() / 1000) - 3600;
const cdn = (id, { e = later, t = "sig1" } = {}) =>
  `https://media.licdn.com/dms/image/v2/${id}/profile-displayphoto-shrink_800_800/0?e=${e}&v=beta&t=${t}`;
const GHOST = "https://static.licdn.com/aero-v1/sc/h/9c8pery4andzj6ohjkjp54ma2";

let details = {};
function setup(records = {}, { broken = [] } = {}) {
  store.clear();
  sink.forgetTableState();
  const tables = BASANITE_TABLES.map((table) => ({ ...table, records: records[table.id] || [] }));
  const base = fakeBase({ baseId: BASE_ID, tables });
  globalThis.fetch = base.handle;
  const people = BASANITE_TABLES.find((table) => table.id === PEOPLE);
  store.set("airtable_config", {
    token: "patTESTTOKEN.0123456789abcdef",
    baseId: BASE_ID,
    tableId: PEOPLE,
    tableName: "People",
    fields: people.fields,
    mapping: suggestMapping(people.fields),
    stampValue: "Added By Branch",
    userId: "usrME000000000001",
    baseName: "Basanite OS — Live",
    linked: suggestLinked(BASANITE_TABLES, PEOPLE),
    baseTables: summarizeTables(BASANITE_TABLES),
    schemaAt: Date.now(),
  });
  const checked = [];
  images.setImageFetcher(async (url) => {
    checked.push(url);
    return broken.some((part) => url.includes(part)) ? null : { contentType: "image/jpeg", bytes: new TextEncoder().encode(url) };
  });
  const asked = [];
  details = {};
  linkedSync.setCompanyDetailsProvider(async (id) => {
    asked.push(id);
    return details[id] || null;
  });
  return { base, asked, checked };
}

const person = (slug, extra = {}) => ({
  name: `Person ${slug}`,
  headline: `Headline ${slug}`,
  linkedinUrl: `https://www.linkedin.com/in/${slug}`,
  photoUrl: cdn(`photo-${slug}`),
  ...extra,
});

const photoWrites = (base) => base.writes(PEOPLE).flatMap((entry) => entry.body.records).filter((record) => PHOTO in record.fields);

test("image URLs: placeholders, expired links, and non-https are never sent", () => {
  assert.equal(imageUrl(cdn("a")), cdn("a"));
  assert.equal(imageUrl(GHOST), "");
  assert.equal(imageUrl("https://static-exp1.licdn.com/sc/h/ghost-person.png"), "");
  assert.equal(imageUrl(cdn("a", { e: past })), "", "an expired LinkedIn link was accepted");
  assert.equal(imageUrl("http://media.licdn.com/x.jpg"), "");
  assert.deepEqual(attachmentFor(cdn("a"), "Ada Lovelace"), { url: cdn("a"), filename: "ada-lovelace.jpg" });
  assert.equal(attachmentFor(GHOST, "ada"), null);
});

test("a new person gets their photo, named by slug; a re-signed URL for the same photo isn't re-sent", async () => {
  const { base } = setup();
  await sink.writePeople([person("ada")]);
  const [row] = base.rows(PEOPLE);
  assert.equal(row.fields[PHOTO].length, 1);
  assert.equal(row.fields[PHOTO][0].source, cdn("photo-ada"));
  assert.equal(row.fields[PHOTO][0].filename, "ada.jpg");

  const touches = () => base.log.filter((entry) => entry.path.endsWith(`/${PEOPLE}`)).length;
  const before = touches();
  await sink.writePeople([person("ada", { photoUrl: cdn("photo-ada", { t: "sig2" }) })]);
  assert.equal(touches(), before, "the same photo was planned again under a fresh signature");

  // A new LinkedIn photo still never replaces the one in Airtable.
  await sink.writePeople([person("ada", { photoUrl: cdn("photo-ada-new"), headline: "Changed" })]);
  assert.equal(row.fields[HEADLINE], "Changed");
  assert.equal(row.fields[PHOTO][0].source, cdn("photo-ada"), "a photo already in Airtable was replaced");
  assert.equal(row.fields[PHOTO].length, 1, "a photo was appended");
});

test("an existing person: a blank Photo is filled, an uploaded one is never touched", async () => {
  const uploaded = [{ id: "attMINE", url: "https://v5.airtableusercontent.com/mine", filename: "mine.png" }];
  const { base } = setup({
    [PEOPLE]: [
      { id: "recPERSONBLANK001", fields: { [NAME]: "Blank", "fldvyrmtV2q06ip6k": "https://www.linkedin.com/in/blank" } },
      { id: "recPERSONOWNED001", fields: { [NAME]: "Owned", "fldvyrmtV2q06ip6k": "https://www.linkedin.com/in/owned", [PHOTO]: uploaded } },
    ],
  });
  await sink.writePeople([person("blank"), person("owned")]);
  const rows = base.state.get(PEOPLE).records;
  assert.equal(rows.get("recPERSONBLANK001").fields[PHOTO][0].source, cdn("photo-blank"));
  assert.deepEqual(rows.get("recPERSONOWNED001").fields[PHOTO], uploaded);
  assert.ok(photoWrites(base).every((record) => record.id !== "recPERSONOWNED001"), "Photo was sent for a row that has one");

  // Later syncs don't keep offering it either.
  const before = photoWrites(base).length;
  await sink.writePeople([person("blank"), person("owned")]);
  assert.equal(photoWrites(base).length, before);
});

test("no real photo: the placeholder avatar and an expired link leave Photo out", async () => {
  const { base, checked } = setup();
  await sink.writePeople([person("ghost", { photoUrl: GHOST }), person("stale", { photoUrl: cdn("old", { e: past }) })]);
  assert.equal(base.rows(PEOPLE).length, 2);
  assert.equal(photoWrites(base).length, 0);
  assert.equal(checked.length, 0, "a placeholder was even checked");
});

test("a photo that won't download is skipped; the rest of the record lands, and it's tried again next sync", async () => {
  const { base } = setup({}, { broken: ["photo-bad"] });
  const tally = await sink.writePeople([person("bad"), person("good")]);
  assert.equal(tally.created, 2);
  assert.equal(tally.failed, 0);
  const rows = base.rows(PEOPLE);
  const bad = rows.find((row) => row.fields[NAME] === "Person bad");
  assert.equal(bad.fields[PHOTO], undefined);
  assert.equal(bad.fields[HEADLINE], "Headline bad", "the rest of the record didn't land");
  assert.ok(rows.find((row) => row.fields[NAME] === "Person good").fields[PHOTO]);

  // LinkedIn later serves a photo that loads: the blank cell is filled.
  await sink.writePeople([person("bad", { photoUrl: cdn("photo-fixed") })]);
  assert.equal(bad.fields[PHOTO][0].source, cdn("photo-fixed"));
});

const ADA = {
  name: "Ada Lovelace",
  linkedinUrl: "https://www.linkedin.com/in/ada",
  experience: [
    { title: "Partner", company: "Basanite", companyUrn: "urn:li:fsd_company:4242", startDate: "2023-01", isCurrent: true,
      companyLogoUrl: cdn("logo-basanite") },
    { title: "Principal", company: "Engines Ltd", companyUrn: "urn:li:fsd_company:77", startDate: "2020-01", endDate: "2022-12" },
  ],
  education: [{ school: "MIT", schoolUrn: "urn:li:fsd_school:5678", schoolLogoUrl: cdn("logo-mit") }],
  _earthosEnrichment: { status: "complete" },
};

test("company and school logos: new rows get them, filled blanks too, curated ones never change", async () => {
  const curated = [{ id: "attCURATED", url: "https://v5.airtableusercontent.com/c", filename: "c.png" }];
  const { base, asked } = setup({
    [COMPANIES]: [{ id: "recCOMPENGINES001", fields: { [C.name]: "Engines Ltd", [C.logo]: curated } }],
  });
  details = {
    4242: { universalName: "basanite", name: "Basanite", logoUrl: cdn("logo-basanite-details") },
    77: { universalName: "engines-ltd", name: "Engines Ltd", logoUrl: cdn("logo-engines") },
  };
  await sink.writePeople([ADA]);
  const basanite = base.rows(COMPANIES).find((row) => row.fields[C.name] === "Basanite");
  // The profile's own logo comes first; it's the freshest link.
  assert.equal(basanite.fields[C.logo][0].source, cdn("logo-basanite"));
  assert.equal(basanite.fields[C.logo][0].filename, "basanite.jpg");
  assert.deepEqual(base.state.get(COMPANIES).records.get("recCOMPENGINES001").fields[C.logo], curated);
  const mit = base.rows(EDUCATION).find((row) => row.fields[E.name] === "MIT");
  assert.equal(mit.fields[E.logo][0].source, cdn("logo-mit"));
  assert.deepEqual(asked.sort(), ["4242", "77"]);

  // Again: nothing re-sent, LinkedIn not asked again.
  const writes = base.writes(COMPANIES).length + base.writes(EDUCATION).length;
  await sink.writePeople([ADA]);
  assert.equal(base.writes(COMPANIES).length + base.writes(EDUCATION).length, writes);
  assert.equal(asked.length, 2);
});

test("a blank logo whose cached link has expired is fetched again, once; a filled one never is", async () => {
  const { base, asked } = setup({
    [COMPANIES]: [
      { id: "recCOMPBLANK00001", fields: { [C.name]: "Blank Co", "fldrtMFdA0cHj9Aeh": "https://www.linkedin.com/company/blank-co" } },
      { id: "recCOMPFILLED0001", fields: { [C.name]: "Filled Co", "fldrtMFdA0cHj9Aeh": "https://www.linkedin.com/company/filled-co",
        [C.logo]: [{ id: "attX", url: "https://v5.airtableusercontent.com/x", filename: "x.png" }] } },
    ],
  });
  // What an earlier sync cached: links that have since expired.
  store.set("linkedin_company_details", {
    1: { universalName: "blank-co", name: "Blank Co", logoUrl: cdn("logo-blank-old", { e: past }), at: Date.now() },
    2: { universalName: "filled-co", name: "Filled Co", logoUrl: cdn("logo-filled-old", { e: past }), at: Date.now() },
  });
  details = { 1: { universalName: "blank-co", name: "Blank Co", logoUrl: cdn("logo-blank-new") } };
  const row = (slug, companies) => ({
    name: `Person ${slug}`,
    linkedinUrl: `https://www.linkedin.com/in/${slug}`,
    experience: companies.map(([name, id]) => ({ title: "Analyst", company: name, companyUrn: `urn:li:fsd_company:${id}`, startDate: "2021-01" })),
    _earthosEnrichment: { status: "complete" },
  });
  await sink.writePeople([row("p1", [["Blank Co", 1], ["Filled Co", 2]])]);
  assert.deepEqual(asked, ["1"], "a company whose Logo is filled was looked up again");
  assert.equal(base.state.get(COMPANIES).records.get("recCOMPBLANK00001").fields[C.logo][0].source, cdn("logo-blank-new"));

  await sink.writePeople([row("p2", [["Blank Co", 1], ["Filled Co", 2]])]);
  assert.deepEqual(asked, ["1"], "a logo was fetched again after it was filled");
});

test("a logo that won't download is skipped without failing the company", async () => {
  const { base } = setup({}, { broken: ["logo-basanite"] });
  details = { 4242: { universalName: "basanite", name: "Basanite", about: "Seed fund.", logoUrl: "" } };
  const tally = await sink.writePeople([ADA]);
  assert.equal(tally.linkedFailed, 0);
  const basanite = base.rows(COMPANIES).find((row) => row.fields[C.name] === "Basanite");
  assert.equal(basanite.fields[C.logo], undefined);
  assert.equal(basanite.fields["fldCLrrYTiMG8nrxo"], "Seed fund.", "the rest of the company didn't land");
  images.setImageFetcher(null);
});

test("only LinkedIn's image CDN is ever checked or handed to Airtable", () => {
  assert.equal(imageUrl("https://media-exp1.licdn.com/dms/image/a.jpg"), "https://media-exp1.licdn.com/dms/image/a.jpg");
  assert.equal(imageUrl("https://evil.example/licdn.com/a.jpg"), "");
  assert.equal(imageUrl("https://licdn.com.evil.io/a.jpg"), "");
  assert.equal(imageUrl("https://127.0.0.1/a.jpg"), "");
});
