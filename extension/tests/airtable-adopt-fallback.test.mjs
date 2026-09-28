import test from "node:test";
import assert from "node:assert/strict";
const H = "./helpers/image-harness.mjs";
const { C, COMPANIES, P, PEOPLE, basanite, linkedSync, setup, sink, state } = await import(H);
const WORK = basanite.WORK;
const W = { title: "fldXwAfDqpN13BSwM", company: "flduTDvxs0L1eWyWD", person: "fldjmSvXmRCd98JMk", start: "fldfsvlMrvrGJCdFA" };

test("adopt fallback (lookup refused → full rebuild) still re-reads linked tables", async () => {
  const { base } = setup({});
  linkedSync.forgetLinkedState();
  state.details = { 7: { universalName: "acme", name: "Acme", about: "Acme about" } };
  const withJob = (slug) => ({
    name: `Person ${slug}`, linkedinUrl: `https://www.linkedin.com/in/${slug}`,
    experience: [{ title: "CTO", company: "Acme", companyUrn: "urn:li:fsd_company:7", startDate: "2020-01", isCurrent: true }],
    _earthosEnrichment: { status: "complete" },
  });
  await sink.writePeople([withJob("mine")]);
  const acme = base.rows(COMPANIES).find((row) => row.fields[C.name] === "Acme");
  base.state.get(PEOPLE).records.set("recTEAMMATEX00001", { id: "recTEAMMATEX00001", fields: { [P.name]: "Person x", [P.linkedin]: "https://www.linkedin.com/in/x" } });
  base.state.get(WORK).records.set("recTEAMWORKX00001", { id: "recTEAMWORKX00001", fields: {
    [W.title]: "CTO", [W.company]: [acme.id], [W.person]: ["recTEAMMATEX00001"], [W.start]: "2020-01-01" } });
  // Airtable refuses the filtered People lookup (e.g. formula too complex / INVALID_FILTER_BY_FORMULA).
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/${PEOPLE}/listRecords`) && /FIND\(/.test(init.body || "")) {
      return new Response(JSON.stringify({ error: { type: "INVALID_FILTER_BY_FORMULA", message: "nope" } }), { status: 422 });
    }
    return inner(input, init);
  };
  await sink.writePeople([withJob("x")]);
  assert.equal(base.rows(PEOPLE).filter((row) => row.fields[P.linkedin] === "https://www.linkedin.com/in/x").length, 1, "sanity");
  assert.equal(base.rows(WORK).filter((row) => row.fields[W.person]?.[0] === "recTEAMMATEX00001").length, 1, "the job was written twice");
});
