import test from "node:test";
import assert from "node:assert/strict";
import { C, COMPANIES, EDUCATION, PEOPLE, cdn, linkedSync, setup, sink, state } from "./helpers/image-harness.mjs";

// One profile: the same company once linked on LinkedIn (URN) and once typed in (no URN).
const ada = {
  name: "Ada Lovelace",
  linkedinUrl: "https://www.linkedin.com/in/ada",
  experience: [
    { title: "Partner", company: "Acme", companyUrn: "urn:li:fsd_company:1", startDate: "2023-01", isCurrent: true },
    { title: "Intern", company: "Acme", startDate: "2015-01", endDate: "2015-06" },
  ],
  _earthosEnrichment: { status: "complete" },
};

test("a company with and without a LinkedIn page on one profile: one row", async () => {
  const { base } = setup();
  state.details = { 1: { universalName: "acme", name: "Acme" } };
  await sink.writePeople([ada]);
  assert.equal(base.rows(COMPANIES).length, 1);
});

test("re-syncing that profile adds no company rows", async () => {
  const { base } = setup();
  state.details = { 1: { universalName: "acme", name: "Acme" } };
  await sink.writePeople([ada]);
  const first = base.rows(COMPANIES).length;
  await sink.writePeople([ada]);
  assert.equal(base.rows(COMPANIES).length, first, "the second sync added a company");
  const names = base.rows(COMPANIES).map((row) => `${row.fields[C.name]} ${row.fields[C.linkedin] || "(no LinkedIn)"}`);
  assert.equal(names.length, 1, `companies after the same profile synced twice: ${JSON.stringify(names)}`);
});

test("re-syncing it name-only first adds no company rows either", async () => {
  const { base } = setup();
  state.details = { 1: { universalName: "acme", name: "Acme" } };
  const flipped = { ...ada, experience: [...ada.experience].reverse() };
  await sink.writePeople([flipped]);
  const first = base.rows(COMPANIES).length;
  await sink.writePeople([flipped]);
  await sink.writePeople([flipped]);
  assert.equal(base.rows(COMPANIES).length, first, "a later sync added a company");
  const names = base.rows(COMPANIES).map((row) => `${row.fields[C.name]} ${row.fields[C.linkedin] || "(no LinkedIn)"}`);
  assert.equal(names.length, 1, `companies: ${JSON.stringify(names)}`);
  assert.match(names[0], /linkedin\.com\/company\/acme/, "the row lost its LinkedIn page");
});

test("two entries matching one existing row patch it once, first logo wins", async () => {
  const { base } = setup({ [COMPANIES]: [{ id: "recCOMPACME000001", fields: { [C.name]: "Acme" } }] });
  state.details = { 1: { universalName: "acme", name: "Acme" } };
  const row = {
    ...ada,
    experience: [
      { ...ada.experience[0], companyLogoUrl: cdn("logo-one") },
      { ...ada.experience[1], companyLogoUrl: cdn("logo-two") },
    ],
  };
  await sink.writePeople([row]);
  const sent = base.log.filter((entry) => entry.path.endsWith(`/recCOMPACME000001/${C.logo}/uploadAttachment`));
  assert.equal(sent.length, 1, `Logo uploaded ${sent.length} times to one row`);
  assert.equal(base.state.get(COMPANIES).records.get("recCOMPACME000001").fields[C.logo][0].source, cdn("logo-one"));
});

test("the folded name still finds its row after the tables are re-read", async () => {
  const { base } = setup();
  state.details = { 1: { universalName: "acme", name: "Acme" } };
  await sink.writePeople([ada]);
  linkedSync.markLinkedStale();
  await sink.writePeople([ada]);
  assert.equal(base.rows(COMPANIES).length, 1);
});

const typed = (slug, company, school) => ({
  name: `Person ${slug}`,
  linkedinUrl: `https://www.linkedin.com/in/${slug}`,
  experience: [{ title: "Engineer", company, startDate: "2019-01" }],
  ...(school ? { education: [{ school, startDate: "2010" }] } : {}),
  _earthosEnrichment: { status: "complete" },
});

test("a company typed in by a later profile joins the one row with its LinkedIn page", async () => {
  const { base } = setup();
  state.details = { 1: { universalName: "acme", name: "Acme" } };
  await sink.writePeople([{ ...ada, experience: [ada.experience[0]] }]);
  await sink.writePeople([typed("bo", "Acme")]);
  assert.equal(base.rows(COMPANIES).length, 1, "a second, page-less Acme was created");
});

test("two companies with the name on different pages: a typed-in one joins neither", async () => {
  const { base } = setup({ [COMPANIES]: [
    { id: "recCOMPBRANCH0001", fields: { [C.name]: "Branch", [C.linkedin]: "https://www.linkedin.com/company/branchfurniture" } },
    { id: "recCOMPBRANCH0002", fields: { [C.name]: "Branch", [C.linkedin]: "https://www.linkedin.com/company/branchio" } },
  ] });
  await sink.writePeople([typed("bo", "Branch")]);
  assert.equal(base.rows(COMPANIES).length, 3);
});

test("names in any script are one row however often they're synced; punctuation isn't a company", async () => {
  const { base } = setup();
  for (let i = 0; i < 3; i++) {
    await sink.writePeople([typed("bo", "حكومي", "京都府立洛北高等学校"), typed("cy", "--")]);
    linkedSync.forgetLinkedState();
  }
  assert.deepEqual(base.rows(COMPANIES).map((row) => row.fields[C.name]), ["حكومي"]);
  assert.equal(base.rows(EDUCATION).length, 1);
});
