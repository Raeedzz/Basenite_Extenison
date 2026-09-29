// What makes a table enrich fast: company details asked ahead of the write,
// and images uploaded side by side, without asking or uploading anything twice.
import test from "node:test";
import assert from "node:assert/strict";
import { COMPANIES, P, PEOPLE, cdn, person, setup, sink, state, store } from "./helpers/image-harness.mjs";

const job = (company, id) => ({ title: "Engineer", company, companyUrn: `urn:li:fsd_company:${id}`, isCurrent: true });
const photoOf = (base, slug) => base.rows(PEOPLE).find((row) => row.fields[P.name] === `Person ${slug}`)?.fields[P.photo];

test("company details asked ahead of a write are the ones it uses: each company once", async () => {
  const { asked } = setup();
  // Before any write the index isn't loaded: nothing is asked ahead.
  await sink.prefetchLinkedDetails([person("ada", { experience: [job("Acme", 1)] })]);
  assert.deepEqual(asked, []);
  await sink.writePeople([person("ada", { experience: [job("Acme", 1)] })]);
  assert.deepEqual(asked, ["1"]);

  const bob = person("bob", { experience: [job("Acme", 1), job("Beta", 2), job("Gamma", 3)] });
  await sink.prefetchLinkedDetails([bob]);
  assert.deepEqual(asked, ["1", "2", "3"]);
  await sink.writePeople([bob]);
  assert.deepEqual(asked, ["1", "2", "3"], "the write asked again about a company already asked about");
});

test("a company asked about ahead while the write before it runs is asked once", async () => {
  const { asked } = setup();
  await sink.writePeople([person("ada")]);
  state.details["5"] = () => new Promise((resolve) => setTimeout(() => resolve({ name: "Five", universalName: "five" }), 1500));
  const bob = person("bob", { experience: [job("Five", 5)] });
  await Promise.all([sink.prefetchLinkedDetails([bob]), sink.writePeople([bob])]);
  assert.deepEqual(asked, ["5"]);
});

test("companies are asked about ahead a few at a time", async () => {
  const { asked } = setup();
  await sink.writePeople([person("ada")]);
  let inFlight = 0;
  let most = 0;
  for (const id of ["11", "12", "13", "14", "15", "16"]) {
    state.details[id] = async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight--;
      return { name: `Co ${id}` };
    };
  }
  await sink.prefetchLinkedDetails([person("bob", { experience: ["11", "12", "13", "14", "15", "16"].map((id) => job(`Co ${id}`, id)) })]);
  assert.equal(asked.length, 6);
  assert.ok(most > 1 && most <= 3, `${most} at once`);
});

test("a company whose details are already in Airtable isn't asked about ahead", async () => {
  setup();
  const fieldsOf = store.get("airtable_config").linked.companies.fields;
  const filled = { name: "Acme", linkedinUrl: "https://www.linkedin.com/company/7", about: "We make things.",
    website: "https://acme.example", industry: "Software" };
  const { asked, base } = setup({ [COMPANIES]: [{
    id: "recCOMPFILLED0001",
    fields: Object.fromEntries(Object.entries(filled).filter(([key]) => fieldsOf[key]).map(([key, value]) => [fieldsOf[key], value])),
  }] });
  await sink.writePeople([person("ada")]);
  await sink.prefetchLinkedDetails([person("bob", { experience: [job("Acme", 7)] })]);
  assert.deepEqual(asked, []);
  await sink.writePeople([person("bob", { experience: [job("Acme", 7)] })]);
  assert.deepEqual(asked, [], "the write itself doesn't ask either");
  assert.equal(base.rows(COMPANIES).length, 1);
});

test("images upload side by side, and one that fails is still retried next sync", async () => {
  const { base } = setup();
  let inFlight = 0;
  let most = 0;
  globalThis.fetch = async (input, init) => {
    if (!String(input).endsWith("/uploadAttachment")) return base.handle(input, init);
    most = Math.max(most, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 300));
    inFlight--;
    return base.handle(input, init);
  };
  base.faults.partialAttachments = 1;
  const slugs = ["a1", "a2", "a3", "a4", "a5", "a6"];
  await sink.writePeople(slugs.map((slug) => person(slug)));
  assert.ok(most > 1, "uploads went one at a time");
  assert.equal(slugs.filter((slug) => photoOf(base, slug)?.length === 1).length, 5);

  await sink.writePeople(slugs.map((slug) => person(slug)));
  assert.ok(slugs.every((slug) => photoOf(base, slug)?.length === 1), "a photo is missing or doubled");
  assert.ok(slugs.every((slug) => photoOf(base, slug)[0].source === cdn(`photo-${slug}`)));
});
