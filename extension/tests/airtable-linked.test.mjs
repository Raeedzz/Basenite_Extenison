/**
 * Linked tables against the real Basanite OS — Live layout: names, types,
 * and link targets as they are in that base, including the tables and
 * columns that must never be touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { suggestMapping } from "../lib/airtable-fields.js";
import {
  extractLinked,
  linkedinPath,
  linkedReady,
  monthStart,
  pruneLinked,
  roleKey,
  suggestLinked,
} from "../lib/airtable-linked.js";

import {
  BASANITE_TABLES,
  COMPANIES,
  EDUCATION,
  NOTES,
  PEOPLE,
  ROLES,
  WORK,
} from "./helpers/basanite-base.mjs";

test("the Basanite base lands on exactly the tables and columns in the spec", () => {
  const linked = suggestLinked(BASANITE_TABLES, PEOPLE);

  assert.equal(linked.companies.tableId, COMPANIES);
  assert.deepEqual(linked.companies.fields, {
    name: "fldzBJ1c98Y5wviTm",
    linkedinUrl: "fldrtMFdA0cHj9Aeh",
    about: "fldCLrrYTiMG8nrxo",
    logo: "fldXCHnaWiGzwjjUW",
    website: "fldTxY46iThubn8HK",
    industry: "fldxYiGlqXGXlsPV0",
  });

  assert.equal(linked.workHistory.tableId, WORK, "picked the recruiting Roles table");
  assert.deepEqual(linked.workHistory.fields, {
    title: "fldXwAfDqpN13BSwM",
    company: "flduTDvxs0L1eWyWD",
    person: "fldjmSvXmRCd98JMk",
    description: "fldxJuN6ScIhcneZq",
    location: "fldGS87PaAX4csC1l",
    timeframe: "fldYPAJskFkfTScdy",
    start: "fldfsvlMrvrGJCdFA",
    end: "fldC4oBixQUijH3HT",
    current: "fldtrGvHwTQlsAO7A",
  });

  assert.equal(linked.schools.tableId, EDUCATION);
  assert.deepEqual(linked.schools.fields, {
    name: "fldk389mX9pLnMj62",
    linkedinUrl: "fldDqDzDWfQAYOxoS",
    logo: "fldgTt4dOwtEVRLNc",
  });

  assert.deepEqual(linked.peopleLinks, { workedAt: "flddIyGX4W7BKfj19", currentCompany: "fldbic0J90xFTmFJn", schools: "fldSPy2fWWELX0wKZ" });
  assert.deepEqual(linkedReady(linked), { companies: true, workHistory: true, schools: true, workedAt: true, currentCompany: true, schoolsLink: true });

  // Schemas ride along for cell typing; only the chosen tables and columns count.
  const chosen = JSON.stringify([
    linked.peopleLinks,
    ...["companies", "workHistory", "schools"].map((key) => ({ tableId: linked[key].tableId, fields: linked[key].fields })),
  ]);
  for (const forbidden of [ROLES, "fldi7jFNhhkLJCLmV", "fld6F1WO8GBqO9TL7",
    "fldpst66YX7LQJK3R", "fldIRzEraQrrRWzCR", "flduR4OmOvSkSIuiP", NOTES]) {
    assert.equal(chosen.includes(forbidden), false, `${forbidden} was chosen`);
  }
});

test("People's own columns map to the spec, and the ones it forbids stay unmapped", () => {
  const mapping = suggestMapping(BASANITE_TABLES[0].fields);
  assert.equal(mapping.linkedinUrl, "fldvyrmtV2q06ip6k");
  assert.equal(mapping.name, "fldqwePau2SiMdzzW");
  assert.equal(mapping.headline, "fld3BmFW5JllGAygg");
  assert.equal(mapping.location, "fldmJANiFBbhvmlDf");
  assert.deepEqual(Object.keys(mapping).sort(), ["createdStamp", "headline", "knownBy", "linkedinUrl", "location", "name", "photo", "referredBy"]);
  assert.equal(mapping.photo, "fldgPl6eKZLPIuLHw");
  assert.equal(mapping.knownBy, "fldC0cY3rR5dWzKB9");
  assert.equal(mapping.createdStamp, "fldxnxDdEM3pbrs6X");
  assert.equal(mapping.referredBy, "fldmzPV4cmQLf8KV2");
  for (const forbidden of ["fldSource00000001", "fldBasaniteId0001", "fldReviewState001", "fldCanonical00001", "fldSetupSample001"]) {
    assert.equal(Object.values(mapping).includes(forbidden), false, `${forbidden} was mapped`);
  }
});

test("a saved choice that stops fitting drops out on reload, and nothing new is added", () => {
  const linked = suggestLinked(BASANITE_TABLES, PEOPLE);
  const retyped = structuredClone(BASANITE_TABLES);
  retyped[2].fields.find((field) => field.id === "fldfsvlMrvrGJCdFA").type = "singleLineText";
  const pruned = pruneLinked(retyped, PEOPLE, { ...linked, schools: undefined });
  assert.equal(pruned.workHistory.fields.start, undefined, "a retyped Start column stayed mapped");
  assert.equal(pruned.workHistory.fields.title, "fldXwAfDqpN13BSwM");
  assert.equal(pruned.schools, undefined, "pruning added a table nobody chose");
  assert.equal(pruned.peopleLinks.schools, undefined);
});

test("LinkedIn pages compare however they were written", () => {
  for (const url of [
    "https://www.linkedin.com/company/acme/",
    "http://linkedin.com/company/ACME?trk=x#about",
    "https://uk.linkedin.com/company/acme/about/",
    "www.linkedin.com/company/acme",
  ]) {
    assert.equal(linkedinPath(url), "company/acme", url);
  }
  assert.equal(linkedinPath("https://www.linkedin.com/school/1234/"), "school/1234");
  assert.equal(linkedinPath("https://www.linkedin.com/in/ada"), null);
  assert.equal(monthStart("2020-3"), "2020-03-01");
  assert.equal(monthStart("2020"), "2020-01-01");
  assert.equal(monthStart(""), "");
  assert.equal(roleKey("recP", "recC", "  Partner ", "2023-01-01"), roleKey("recP", "recC", "partner", "2023-01"));
});

test("a profile yields its companies, one job per role, and its schools", () => {
  const linked = extractLinked({
    experience: [
      { title: "Partner", company: "Basanite", companyUrn: "urn:li:fsd_company:4242", companyLogoUrl: "https://media.licdn.com/logo.png",
        location: "New York", startDate: "2023-01", description: "Seed.", isCurrent: true },
      { title: "Principal", company: "Engines Ltd", companyUrn: "urn:li:fsd_company:77", startDate: "2020-01", endDate: "2022-12", isCurrent: false },
      { title: "Associate", company: "Engines Ltd", companyUrn: "urn:li:fsd_company:77", startDate: "2018-01", endDate: "2019-12", isCurrent: false },
      { title: "Advisor", company: "No Page Co", startDate: "2017" },
    ],
    education: [
      { school: "MIT", schoolUrn: "urn:li:fsd_school:5678", degree: "MBA" },
      { school: "MIT", schoolUrn: "urn:li:fsd_school:5678", degree: "SM" },
      { school: "Local College" },
    ],
  });
  assert.deepEqual([...linked.companies.keys()], ["id:4242", "id:77", "name:no page co"]);
  assert.equal(linked.companies.get("id:4242").linkedinPath, "company/4242");
  assert.equal(linked.roles.length, 4);
  assert.deepEqual(linked.roles[0], {
    companyKey: "id:4242", title: "Partner", description: "Seed.", location: "New York",
    timeframe: "2023-01 – present", start: "2023-01-01", end: "", current: true,
  });
  assert.equal(linked.roles[1].end, "2022-12-01");
  assert.equal(linked.roles[1].current, false);
  // No end date and no flag: still there.
  assert.equal(linked.roles[3].current, true);
  assert.deepEqual([...linked.schools.keys()], ["id:5678", "name:local college"]);

  const bare = extractLinked({ name: "Base row", bio: "No profile pass" });
  assert.equal(bare.companies.size + bare.roles.length + bare.schools.size, 0);
});

test("setup starts on People, not whichever table is listed first", async () => {
  const { suggestPeopleTable, peopleTableMismatch } = await import("../lib/airtable-linked.js");
  const DEX = "tbltFO5Xa1tckP4Hy";
  const withDex = [
    { id: DEX, name: "Dex Contacts", fields: [{ id: "fldDexName0000001", name: "Name", type: "singleLineText" }, { id: "fldDexLinkedIn001", name: "LinkedIn", type: "url" }] },
    ...BASANITE_TABLES,
  ];
  assert.equal(suggestPeopleTable(withDex).id, PEOPLE);
  // The exact misconfiguration from the first live test.
  assert.deepEqual(peopleTableMismatch(withDex, DEX), { id: PEOPLE, name: "People", via: "Work history" });
  assert.equal(peopleTableMismatch(withDex, PEOPLE), null);
});

test("a setup saved before Current company existed gets it offered once, and a Skip sticks", async () => {
  const { offerNewPeopleLinks } = await import("../lib/airtable-linked.js");
  const old = suggestLinked(BASANITE_TABLES, PEOPLE);
  delete old.peopleLinks.currentCompany;
  const first = offerNewPeopleLinks(BASANITE_TABLES, PEOPLE, old, undefined);
  assert.equal(first.linked.peopleLinks.currentCompany, "fldbic0J90xFTmFJn");
  assert.equal(first.linked.peopleLinks.workedAt, "flddIyGX4W7BKfj19");
  // Skipped afterwards: not offered again.
  delete first.linked.peopleLinks.currentCompany;
  const later = offerNewPeopleLinks(BASANITE_TABLES, PEOPLE, first.linked, first.linkedSeen);
  assert.equal(later.linked.peopleLinks.currentCompany, undefined);
});

test("the current company is the first ongoing role's, the same one Title reads", () => {
  const linked = extractLinked({
    experience: [
      { title: "Founder/CEO", company: "LEANSTACK", companyUrn: "urn:li:fsd_company:1", isCurrent: true },
      { title: "Advisor", company: "Wire", companyUrn: "urn:li:fsd_company:2", isCurrent: true },
      { title: "PM", company: "Old", companyUrn: "urn:li:fsd_company:3", startDate: "2010-01", endDate: "2012-01", isCurrent: false },
    ],
  });
  assert.equal(linked.currentCompanyKey, "id:1");
  const between = extractLinked({ experience: [{ title: "CTO", company: "Gone", endDate: "2024-01", isCurrent: false }] });
  assert.equal(between.currentCompanyKey, null);
});
