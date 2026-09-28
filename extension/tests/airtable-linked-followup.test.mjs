import test from "node:test";
import assert from "node:assert/strict";
const H = "./helpers/image-harness.mjs";
const { C, COMPANIES, linkedSync, setup, sink, state } = await import(H);
const SECTOR = "fldxYiGlqXGXlsPV0";

test("a company Industry held back for a follow-up that fails is tried again next sync", async () => {
  const selectSector = (tables) => {
    const f = tables.find((t) => t.id === COMPANIES).fields.find((x) => x.id === SECTOR);
    Object.assign(f, { type: "singleSelect", options: { choices: [] } });
    return tables;
  };
  const { base } = setup({}, { tables: selectSector });
  linkedSync.forgetLinkedState();
  state.details = { 7: { universalName: "acme", name: "Acme", about: "About", industry: "Software" } };
  const inner = globalThis.fetch;
  let failFollowUps = true;
  globalThis.fetch = async (input, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (failFollowUps && init.method === "PATCH" && String(input).endsWith(`/${COMPANIES}`) && body?.typecast === true) {
      return new Response(JSON.stringify({ error: { type: "INVALID_MULTIPLE_CHOICE_OPTIONS", message: "Insufficient permissions to create new select option" } }), { status: 422 });
    }
    return inner(input, init);
  };
  const row = (slug) => ({ name: `P ${slug}`, linkedinUrl: `https://www.linkedin.com/in/${slug}`,
    experience: [{ title: "CTO", company: "Acme", companyUrn: "urn:li:fsd_company:7", startDate: "2020-01", isCurrent: true }],
    _earthosEnrichment: { status: "complete" } });
  await sink.writePeople([row("a")]);
  const acme = () => base.rows(COMPANIES).find((r) => r.fields[C.name] === "Acme");
  assert.equal(acme().fields[SECTOR], undefined, "sanity: follow-up failed");
  failFollowUps = false; // e.g. the base owner granted the permission / transient failure
  await sink.writePeople([row("b")]);
  assert.equal(acme().fields[SECTOR], "Software", "Industry is never retried: the index says it's filled");
});
