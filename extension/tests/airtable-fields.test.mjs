import test from "node:test";
import assert from "node:assert/strict";
import {
  canMap,
  cellValue,
  extractPerson,
  linkedinKey,
  newFieldSpec,
  planCells,
  SOURCE_FIELDS,
  suggestMapping,
} from "../lib/airtable-fields.js";
import { MAPPING, TABLE_FIELDS } from "./helpers/fake-airtable.mjs";

const byId = new Map(TABLE_FIELDS.map((field) => [field.id, field]));

test("LinkedIn URLs match however they were pasted", () => {
  for (const url of [
    "https://www.linkedin.com/in/Ada-Lovelace",
    "linkedin.com/in/ada-lovelace/",
    "https://uk.linkedin.com/in/ada-lovelace?trk=abc",
    "http://www.linkedin.com/in/ada%2Dlovelace/details/experience/",
  ]) {
    assert.equal(linkedinKey(url), "ada-lovelace", url);
  }
  assert.equal(linkedinKey("https://www.linkedin.com/company/acme"), null);
  assert.equal(linkedinKey(""), null);
});

test("a connection row keeps its headline; an enriched one adds title, company, and about", () => {
  const base = extractPerson({
    name: "Ada Lovelace",
    bio: "Analyst of engines",
    linkedinUrl: "https://www.linkedin.com/in/ada",
    connectedAt: "2024-03-05T10:00:00.000Z",
  }, { source: "LinkedIn connection", degree: "1st" });
  assert.equal(base.headline, "Analyst of engines");
  assert.equal(base.about, "");
  assert.equal(base.firstName, "Ada");
  assert.equal(base.lastName, "Lovelace");
  assert.equal(base.degree, "1st");
  assert.equal(base.title, "");

  const enriched = extractPerson({
    name: "Ada Lovelace",
    headline: "Analyst of engines",
    bio: "I write programs for machines that do not exist yet.",
    linkedinUrl: "https://www.linkedin.com/in/ada",
    experience: [
      { title: "Advisor", company: "Old Co", startDate: "2019-01", endDate: "2020-01", isCurrent: false },
      { title: "Analyst", company: "Engines Ltd", startDate: "2020-02", isCurrent: true },
    ],
    education: [{ school: "Home", degree: "Tutoring", field: "Mathematics" }],
    skills: [{ name: "Math" }, "Poetry"],
    _earthosEnrichment: { status: "complete" },
  });
  assert.equal(enriched.headline, "Analyst of engines");
  assert.equal(enriched.about, "I write programs for machines that do not exist yet.");
  assert.equal(enriched.title, "Analyst");
  assert.equal(enriched.company, "Engines Ltd");
  assert.equal(enriched.school, "Home");
  assert.deepEqual(enriched.skills, ["Math", "Poetry"]);
  assert.equal(enriched.experience, "Advisor at Old Co\nAnalyst at Engines Ltd");
  assert.equal(enriched.experienceDates, "2019-01 – 2020-01\n2020-02 – present");
});

test("a row with no LinkedIn URL has nothing to match on", () => {
  assert.equal(extractPerson({ name: "LinkedIn Member", linkedinUrl: "" }), null);
});

test("mutual results carry a count, zero included, and one line per person", () => {
  const person = extractPerson({
    linkedinUrl: "https://www.linkedin.com/in/target",
    bridges: [
      { name: "Grace Hopper", linkedinUrl: "https://www.linkedin.com/in/grace" },
      { name: "Alan Turing", linkedinUrl: "https://www.linkedin.com/in/alan" },
    ],
    totalBridges: 2,
  });
  assert.equal(person.mutualCount, 2);
  assert.equal(person.mutualConnections, "Grace Hopper — https://www.linkedin.com/in/grace\nAlan Turing — https://www.linkedin.com/in/alan");
  assert.equal(extractPerson({ linkedinUrl: "https://www.linkedin.com/in/x", bridges: [] }).mutualCount, 0);
});

test("values are shaped to the column type, and empty never overwrites", () => {
  assert.equal(cellValue("", { type: "singleLineText" }), undefined);
  assert.equal(cellValue(null, { type: "number" }), undefined);
  assert.equal(cellValue([], { type: "multipleSelects" }), undefined);
  assert.equal(cellValue("a\nb", { type: "singleLineText" }), "a; b");
  assert.equal(cellValue("a\nb", { type: "multilineText" }), "a\nb");
  assert.equal(cellValue("2024-03-05T10:00:00.000Z", { type: "date" }), "2024-03-05");
  assert.equal(cellValue("nonsense", { type: "date" }), undefined);
  assert.equal(cellValue(0, { type: "number" }), 0);
  assert.equal(cellValue(true, { type: "checkbox" }), true);
  assert.equal(cellValue(true, { type: "singleLineText" }), "Yes");
  assert.deepEqual(cellValue(["Math", "Poetry"], { type: "multipleSelects" }), ["Math", "Poetry"]);
  assert.equal(cellValue(["Math", "Poetry"], { type: "singleLineText" }), "Math, Poetry");
  assert.deepEqual(cellValue("https://media.licdn.com/p.jpg", { type: "multipleAttachments" }), [{ url: "https://media.licdn.com/p.jpg" }]);
  assert.equal(cellValue("x", { type: "formula" }), undefined);
});

test("columns are pre-mapped from their names, once each, only where the type fits", () => {
  const mapping = suggestMapping([
    ...TABLE_FIELDS,
    { id: "fldLinkedInText", name: "LinkedIn Profile", type: "singleLineText" },
    { id: "fldPhotoNum", name: "Photo", type: "number" },
  ]);
  assert.equal(mapping.linkedinUrl, "fldLinkedIn");
  assert.equal(mapping.name, "fldName");
  assert.equal(mapping.title, "fldTitle");
  assert.equal(mapping.company, "fldCompany");
  assert.equal(mapping.connectedAt, "fldConnected");
  // Source is chosen by hand only: an existing "Source" column is often someone else's.
  assert.equal(mapping.source, undefined);
  assert.equal(mapping.degree, "fldDegree");
  assert.equal(mapping.photo, undefined, "a number column can't hold a photo");
  assert.equal(Object.values(mapping).includes("fldFormula"), false);
  assert.equal(new Set(Object.values(mapping)).size, Object.values(mapping).length);
});

test("an existing choice survives auto-mapping; a column that changed type does not", () => {
  const mapping = suggestMapping(TABLE_FIELDS, { title: "fldNotes", company: "fldGone" });
  assert.equal(mapping.title, "fldNotes");
  assert.equal(mapping.company, "fldCompany");
  assert.equal(canMap("linkedinUrl", { type: "number" }), false);
  assert.equal(canMap("linkedinUrl", { type: "singleLineText" }), true);
});

test("only changed cells are sent; the URL and source are written once", () => {
  const person = extractPerson({
    name: "Ada Lovelace",
    bio: "Analyst",
    linkedinUrl: "https://www.linkedin.com/in/ada",
  }, { source: "LinkedIn connection", degree: "1st" });

  const create = planCells(person, MAPPING, byId, null);
  assert.equal(create.changed, true);
  assert.equal(create.fields.fldLinkedIn, "https://www.linkedin.com/in/ada");
  assert.equal(create.fields.fldSource, "LinkedIn connection");

  const again = planCells(person, MAPPING, byId, create.hashes);
  assert.equal(again.changed, false);

  const moved = planCells({ ...person, headline: "Engineer" }, MAPPING, byId, create.hashes);
  assert.equal(moved.changed, true);
  assert.deepEqual(Object.keys(moved.fields).sort(), ["fldHeadline"]);

  // A row found in the table but never written by the extension: fill it, but
  // leave its URL and where it came from alone.
  const adopted = planCells(person, MAPPING, byId, {});
  assert.equal(adopted.fields.fldLinkedIn, undefined);
  assert.equal(adopted.fields.fldSource, undefined);
  assert.equal(adopted.fields.fldName, "Ada Lovelace");

  // Re-mapping a field re-sends it.
  const remapped = planCells(person, { ...MAPPING, headline: "fldNotes" }, byId, create.hashes);
  assert.deepEqual(Object.keys(remapped.fields), ["fldNotes"]);
});

test("every capture field can be created as a column", () => {
  for (const source of SOURCE_FIELDS) {
    const spec = newFieldSpec(source.key);
    assert.equal(spec.name, source.label);
    assert.ok(canMap(source.key, { type: spec.type }), `${source.key} can't go in the column it creates`);
  }
});

test("real-world column names land where they belong", () => {
  const columns = [
    ["fA", "Full Name", "singleLineText"],
    ["fB", "LinkedIn Profile URL", "url"],
    ["fC", "Current Title", "singleLineText"],
    ["fD", "Current Company", "singleLineText"],
    ["fE", "Work Experience", "multilineText"],
    ["fF", "Education History", "multilineText"],
    ["fG", "Past Companies", "multilineText"],
    ["fH", "Previous Company", "singleLineText"],
    ["fI", "Schools", "multipleSelects"],
    ["fJ", "Date", "singleLineText"],
    ["fK", "Notes", "multilineText"],
    ["fL", "Companies Worked At", "multipleSelects"],
  ].map(([id, name, type]) => ({ id, name, type }));
  const mapping = suggestMapping(columns);
  assert.equal(mapping.name, "fA");
  assert.equal(mapping.linkedinUrl, "fB");
  assert.equal(mapping.title, "fC");
  assert.equal(mapping.company, "fD");
  assert.equal(mapping.experience, "fE");
  assert.equal(mapping.education, "fF");
  assert.equal(mapping.previousCompany, "fH");
  assert.equal(mapping.schools, "fI");
  // Two columns want past companies; the exact one wins, and the other is
  // never handed to "Current company" just because it says "companies".
  assert.equal(mapping.pastCompanies, "fG");
  assert.notEqual(mapping.company, "fL");
  const claimed = new Set(Object.values(mapping));
  assert.equal(claimed.has("fJ"), false, "a bare 'Date' column was claimed");
  assert.equal(claimed.has("fK"), false);
});

test("where they are now and everywhere they've been", () => {
  const person = extractPerson({
    linkedinUrl: "https://www.linkedin.com/in/ada",
    experience: [
      { title: "Partner", company: "Basanite", startDate: "2023-01", isCurrent: true },
      { title: "Principal", company: "Engines Ltd", startDate: "2020-01", endDate: "2022-12", isCurrent: false },
      { title: "Associate", company: "Engines Ltd", startDate: "2018-01", endDate: "2019-12", isCurrent: false },
      { title: "Analyst", company: "Old Bank", startDate: "2016-01", endDate: "2017-12", isCurrent: false },
    ],
    education: [{ school: "MIT", degree: "MBA" }, { school: "Oxford", degree: "BA" }, { school: "MIT" }],
    _earthosEnrichment: { status: "complete" },
  });
  assert.equal(person.title, "Partner");
  assert.equal(person.company, "Basanite");
  assert.equal(person.previousTitle, "Principal");
  assert.equal(person.previousCompany, "Engines Ltd");
  assert.deepEqual(person.pastCompanies, ["Engines Ltd", "Old Bank"]);
  assert.equal(person.experience.split("\n").length, 4, "past roles were dropped from Experience");
  assert.match(person.experience, /^Analyst at Old Bank$/m);
  assert.equal(person.experienceDates.split("\n")[3], "2016-01 – 2017-12", "timeframes drifted out of line with roles");
  assert.deepEqual(person.schools, ["MIT", "Oxford"]);
  assert.equal(person.education.split("\n").length, 3);

  // Between jobs: no current role, and the last one counts as past.
  const between = extractPerson({
    linkedinUrl: "https://www.linkedin.com/in/bo",
    experience: [{ title: "CTO", company: "Gone Co", startDate: "2020-01", endDate: "2024-06" }],
  });
  assert.equal(between.company, "");
  assert.equal(between.previousCompany, "Gone Co");
});

test("Experience stays one line per role; the rest goes to Additional info only when mapped", () => {
  const row = {
    linkedinUrl: "https://www.linkedin.com/in/ada",
    experience: [
      {
        title: "Partner", company: "Basanite", companyUrn: "urn:li:fsd_company:4242", location: "New York",
        startDate: "2023-01", isCurrent: true, description: "Leads seed.\n\n\n\nBoard seats at three companies.",
      },
      { title: "Analyst", company: "Old Bank", startDate: "2016-01", endDate: "2017-12", isCurrent: false },
    ],
    licenses: [{ name: "CFA", issuingOrg: "CFA Institute", startDate: "2019-06" }],
    volunteering: [{ role: "Mentor", organization: "Code Club", cause: "Education", startDate: "2021-01" }],
    _earthosEnrichment: { status: "complete" },
  };
  const person = extractPerson(row);
  assert.equal(person.experience, "Partner at Basanite\nAnalyst at Old Bank");
  assert.equal(person.experienceDates, "2023-01 – present\n2016-01 – 2017-12");
  assert.equal(person.additionalInfo, [
    "Roles",
    "Partner at Basanite · New York · https://www.linkedin.com/company/4242",
    "  Leads seed.",
    "",
    "  Board seats at three companies.",
    "",
    "Certifications",
    "CFA — CFA Institute (2019-06)",
    "",
    "Volunteering",
    "Mentor at Code Club (Education, 2021-01 – present)",
  ].join("\n"));

  // Optional: with no column mapped, nothing is sent for it.
  const byId = new Map(TABLE_FIELDS.map((field) => [field.id, field]));
  const plan = planCells(person, MAPPING, byId, null);
  assert.equal(Object.values(plan.fields).some((value) => String(value).includes("Board seats")), false);
  assert.equal(suggestMapping([{ id: "fX", name: "Additional Info", type: "multilineText" }]).additionalInfo, "fX");
});

test("a role with no dates keeps its line, so timeframes stay aligned", () => {
  const person = extractPerson({
    linkedinUrl: "https://www.linkedin.com/in/x",
    experience: [
      { title: "Founder", company: "New Co", startDate: "2024-01", isCurrent: true },
      { title: "Advisor", company: "Undated Inc", isCurrent: false },
      { title: "Engineer", company: "Old Co", startDate: "2015-01", endDate: "2019-01", isCurrent: false },
    ],
  });
  assert.deepEqual(person.experienceDates.split("\n"), ["2024-01 – present", "—", "2015-01 – 2019-01"]);
  assert.equal(person.experience.split("\n").length, 3);
  assert.equal(suggestMapping([{ id: "fT", name: "Timeframe", type: "multilineText" }]).experienceDates, "fT");
});

test("education lists schools without dates; timeframes line up beside them", () => {
  const person = extractPerson({
    linkedinUrl: "https://www.linkedin.com/in/x",
    education: [
      { school: "MIT", degree: "MBA", field: "Finance", startDate: "2014", endDate: "2016" },
      { school: "Oxford", degree: "BA" },
      { school: "", degree: "", field: "" },
      { school: "Exeter", endDate: "2008" },
    ],
  });
  assert.equal(person.education, "MIT — MBA, Finance\nOxford — BA\nExeter");
  assert.equal(person.educationDates, "2014 – 2016\n—\n2008");
  assert.equal(suggestMapping([
    { id: "fE", name: "Education", type: "multilineText" },
    { id: "fD", name: "Education Dates", type: "multilineText" },
  ]).educationDates, "fD");
});

test("Network: in for 1st-degree connections, outside for everyone else, and in the column's own terms", () => {
  const first = extractPerson({ linkedinUrl: "https://www.linkedin.com/in/a" }, { degree: "1st" });
  const second = extractPerson({ linkedinUrl: "https://www.linkedin.com/in/b", connectionDegree: "2nd" });
  const unknown = extractPerson({ linkedinUrl: "https://www.linkedin.com/in/c" });
  assert.equal(first.inNetwork, true);
  assert.equal(second.inNetwork, false);
  assert.equal(unknown.inNetwork, null);

  const fields = new Map([
    ["fSel", { id: "fSel", type: "singleSelect" }],
    ["fBox", { id: "fBox", type: "checkbox" }],
    ["fTxt", { id: "fTxt", type: "singleLineText" }],
  ]);
  const cells = (person, fieldId) => planCells(person, { linkedinUrl: undefined, inNetwork: fieldId }, fields, null).fields[fieldId];
  assert.equal(cells(first, "fSel"), "In network");
  assert.equal(cells(second, "fSel"), "Outside network");
  assert.equal(cells(first, "fBox"), true);
  assert.equal(cells(second, "fBox"), false);
  assert.equal(cells(second, "fTxt"), "Outside network");
  assert.equal(cells(unknown, "fSel"), undefined, "an unknown degree was written");

  const mapping = suggestMapping([
    { id: "fN", name: "Network", type: "singleSelect" },
    { id: "fC", name: "Connected on", type: "date" },
    { id: "fD", name: "Degree", type: "singleSelect" },
  ]);
  assert.equal(mapping.inNetwork, "fN");
  assert.equal(mapping.connectedAt, "fC");
  assert.equal(mapping.degree, "fD");
  assert.equal(suggestMapping([{ id: "fI", name: "In network", type: "checkbox" }]).inNetwork, "fI");
});
