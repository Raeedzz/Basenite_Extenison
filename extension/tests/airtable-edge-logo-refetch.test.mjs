import test from "node:test";
import assert from "node:assert/strict";
import { C, COMPANIES, GHOST, cdn, linkedSync, past, setup, sink, state, store } from "./helpers/image-harness.mjs";

const row = (slug) => ({
  name: `Person ${slug}`,
  linkedinUrl: `https://www.linkedin.com/in/${slug}`,
  experience: [{ title: "Analyst", company: "Blank Co", companyUrn: "urn:li:fsd_company:1", startDate: "2021-01" }],
  _earthosEnrichment: { status: "complete" },
});

const blankCo = { id: "recCOMPBLANK00001", fields: { [C.name]: "Blank Co", [C.linkedin]: "https://www.linkedin.com/company/blank-co" } };

test("a cached placeholder logo isn't re-asked every sync", async () => {
  const { asked } = setup({ [COMPANIES]: [blankCo] });
  // Cached details whose logo is LinkedIn's placeholder: the company has no real logo.
  store.set("linkedin_company_details", {
    1: { universalName: "blank-co", name: "Blank Co", logoUrl: GHOST, at: Date.now() },
  });
  state.details = { 1: { universalName: "blank-co", name: "Blank Co", logoUrl: GHOST } };
  await sink.writePeople([row("p1")]);
  await sink.writePeople([row("p2")]);
  await sink.writePeople([row("p3")]);
  // Spec: refetch only when the cached URL has EXPIRED; a placeholder hasn't.
  assert.deepEqual(asked, [], `LinkedIn was asked ${asked.length} times for a company whose cached logo is a placeholder`);
});

test("a failed logo re-ask is retried after the wait, not never", async () => {
  const { base, asked } = setup({ [COMPANIES]: [blankCo] });
  store.set("linkedin_company_details", {
    1: { universalName: "blank-co", name: "Blank Co", logoUrl: cdn("logo-old", { e: past }), at: Date.now() },
  });
  // First re-ask fails transiently (the provider swallows non-session errors and yields null).
  state.details = { 1: null };
  await sink.writePeople([row("p1")]);
  assert.deepEqual(asked, ["1"]);
  // LinkedIn is healthy again; weeks pass.
  state.details = { 1: { universalName: "blank-co", name: "Blank Co", logoUrl: cdn("logo-new") } };
  const realNow = Date.now;
  Date.now = () => realNow() + 30 * 24 * 3600 * 1000;
  try {
    await sink.writePeople([row("p2")]);
  } finally {
    Date.now = realNow;
  }
  const logo = base.state.get(COMPANIES).records.get("recCOMPBLANK00001").fields[C.logo];
  assert.ok(asked.length > 1, "a blank Logo is never looked up again after one failed re-ask (cache now holds logoUrl: \"\")");
  assert.ok(logo, "Logo stays blank forever");
});

test("a company lookup LinkedIn refuses as signed out doesn't fail the write, or add a company it can't match; a later sync does", async () => {
  // A teammate's row for the same company, under its LinkedIn page.
  const { base } = setup({ [COMPANIES]: [{ id: "recCOMPTEAMMATE01", fields: { [C.name]: "Basanite", [C.linkedin]: "https://www.linkedin.com/company/basanite" } }] });
  let signedOut = true;
  state.details = { 4242: () => {
    if (signedOut) throw new Error("SESSION_EXPIRED");
    return { universalName: "basanite", name: "Basanite", about: "Seed fund." };
  } };
  const row = {
    name: "Ada Lovelace",
    linkedinUrl: "https://www.linkedin.com/in/ada",
    experience: [{ title: "Partner", company: "Basanite", companyUrn: "urn:li:fsd_company:4242", startDate: "2023-01", isCurrent: true }],
    _earthosEnrichment: { status: "complete" },
  };
  const tally = await sink.writePeople([row]);
  assert.equal(tally.created, 1, "the person wasn't written");
  assert.equal(base.rows(COMPANIES).length, 1, "a second Basanite was made while its LinkedIn page was unknown");

  // Signed back in, lookups resumed: matched to the teammate's row, About filled.
  signedOut = false;
  linkedSync.forgetLinkedState();
  await sink.writePeople([row]);
  assert.equal(base.rows(COMPANIES).length, 1);
  assert.equal(base.state.get(COMPANIES).records.get("recCOMPTEAMMATE01").fields.fldCLrrYTiMG8nrxo, "Seed fund.");
});
