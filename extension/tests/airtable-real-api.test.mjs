/**
 * Behaviour of the real Airtable API the fake now copies: formulas by field
 * id, 200 answers whose attachments failed, 403 on one locked column, and
 * typecast off (a new select choice goes in a follow-up).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { C, COMPANIES, P, PEOPLE, basanite, cdn, linkedSync, person, setup, sink, state } from "./helpers/image-harness.mjs";

const WORK = basanite.WORK;
const W = { title: "fldXwAfDqpN13BSwM", company: "flduTDvxs0L1eWyWD", person: "fldjmSvXmRCd98JMk", start: "fldfsvlMrvrGJCdFA" };

const rowFor = (base, slug) => base.rows(PEOPLE).find((row) => row.fields[P.linkedin] === `https://www.linkedin.com/in/${slug}`);

test("the LinkedIn column renamed in Airtable: lookups still work, nothing fails or duplicates", async () => {
  const { base } = setup();
  await sink.writePeople([person("ada")]);
  // Renamed in Airtable after the extension read the schema; a teammate adds Bo.
  base.state.get(PEOPLE).fields.find((field) => field.id === P.linkedin).name = "LinkedIn profile";
  base.state.get(PEOPLE).records.set("recTEAMMATEBO0001", { id: "recTEAMMATEBO0001", fields: { [P.linkedin]: "https://www.linkedin.com/in/bo" } });
  const tally = await sink.writePeople([person("bo")]);
  assert.equal(tally.failed, 0);
  assert.equal(base.rows(PEOPLE).filter((row) => row.fields[P.linkedin]?.endsWith("/in/bo")).length, 1);
});

test("a photo Airtable couldn't attach (200, partialSuccess) is sent again next sync", async () => {
  const { base } = setup();
  base.faults.partialAttachments = 1;
  await sink.writePeople([person("ada")]);
  assert.equal(rowFor(base, "ada").fields[P.photo], undefined);
  await sink.writePeople([person("ada")]);
  assert.equal(rowFor(base, "ada").fields[P.photo]?.[0]?.source, cdn("photo-ada"));
});

test("a column this token may not write (403) is left out; everything else lands", async () => {
  const { base } = setup();
  base.faults.lockedFields.add(P.headline);
  const tally = await sink.writePeople([person("ada"), person("bo")]);
  assert.equal(tally.created, 2);
  assert.equal(tally.failed, 0);
  assert.equal(rowFor(base, "ada").fields[P.headline], undefined);
  assert.equal(rowFor(base, "ada").fields[P.name], "Person ada");
});

test("a person adopted from a teammate's row doesn't get their job twice", async () => {
  const { base } = setup({});
  linkedSync.forgetLinkedState();
  state.details = { 7: { universalName: "acme", name: "Acme", about: "Acme about" } };
  const withJob = (slug) => ({
    name: `Person ${slug}`,
    linkedinUrl: `https://www.linkedin.com/in/${slug}`,
    experience: [{ title: "CTO", company: "Acme", companyUrn: "urn:li:fsd_company:7", startDate: "2020-01", isCurrent: true }],
    _earthosEnrichment: { status: "complete" },
  });
  await sink.writePeople([withJob("mine")]);
  const acme = base.rows(COMPANIES).find((row) => row.fields[C.name] === "Acme");
  // A teammate's extension writes the same person and their job.
  base.state.get(PEOPLE).records.set("recTEAMMATEX00001", { id: "recTEAMMATEX00001", fields: { [P.name]: "Person x", [P.linkedin]: "https://www.linkedin.com/in/x" } });
  base.state.get(WORK).records.set("recTEAMWORKX00001", { id: "recTEAMWORKX00001", fields: {
    [W.title]: "CTO", [W.company]: [acme.id], [W.person]: ["recTEAMMATEX00001"], [W.start]: "2020-01-01" } });
  await sink.writePeople([withJob("x")]);
  assert.equal(base.rows(PEOPLE).filter((row) => row.fields[P.linkedin] === "https://www.linkedin.com/in/x").length, 1);
  assert.equal(base.rows(WORK).filter((row) => row.fields[W.person]?.[0] === "recTEAMMATEX00001").length, 1, "the job was written twice");
});
