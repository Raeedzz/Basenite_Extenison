/**
 * The Basanite OS — Live layout: table and column names, types, and link
 * targets as they are in that base, including the ones that must never be
 * touched (the recruiting Roles table, unrelated Companies links, DELETE ME).
 */
const link = (id, name, target) => ({ id, name, type: "multipleRecordLinks", options: { linkedTableId: target } });
const f = (id, name, type) => ({ id, name, type });

export const PEOPLE = "tblkNyZryAUzBkc3G";
export const COMPANIES = "tblAdFMu2Reuh3hPg";
export const WORK = "tbl4AOs1LWsUNMEWh";
export const NOTES = "tblxIl1sNemDmkl1g";
export const EDUCATION = "tbluLictF87ElIsEY";
export const ROLES = "tblAs3Vi0OrZzYjNZ";

export const BASANITE_TABLES = [
  {
    id: PEOPLE,
    name: "People",
    fields: [
      f("fldqwePau2SiMdzzW", "Name", "singleLineText"),
      f("fldvyrmtV2q06ip6k", "LinkedIn", "url"),
      f("fld3BmFW5JllGAygg", "Headline", "singleLineText"),
      f("fldmJANiFBbhvmlDf", "Location", "singleLineText"),
      link("fldzReVjmXKu618yz", "Work history", WORK),
      link("flddIyGX4W7BKfj19", "Worked at", COMPANIES),
      link("fldSPy2fWWELX0wKZ", "Education", EDUCATION),
      link("fldL70B4fJbFB4tSy", "Notes", NOTES),
      f("fldPKigKRaF2OZl7S", "Last note", "rollup"),
      link("fldi7jFNhhkLJCLmV", "Roles", ROLES),
      link("fld6F1WO8GBqO9TL7", "Companies", COMPANIES),
      link("fldbic0J90xFTmFJn", "Current company", COMPANIES),
      link("fldpst66YX7LQJK3R", "Companies (Founders)", COMPANIES),
      f("fldBasaniteId0001", "Basanite ID", "singleLineText"),
      f("fldReviewState001", "Review state", "singleSelect"),
      f("fldCanonical00001", "Canonical version", "singleLineText"),
      f("fldSource00000001", "Source", "singleSelect"),
      f("fldSetupSample001", "Setup sample — Title", "singleLineText"),
      link("fldIRzEraQrrRWzCR", "DELETE ME (old Education link)", EDUCATION),
      {
        id: "fldxnxDdEM3pbrs6X",
        name: "Enrichment review",
        type: "singleSelect",
        options: { choices: ["Sources checked", "Conflicting sources", "Unresolved", "Added By Branch"].map((name, i) => ({ id: `sel${i}`, name })) },
      },
      f("fldmzPV4cmQLf8KV2", "Referred By", "singleLineText"),
      f("fldC0cY3rR5dWzKB9", "Known by", "multipleCollaborators"),
      f("fldgPl6eKZLPIuLHw", "Photo", "multipleAttachments"),
    ],
  },
  {
    id: COMPANIES,
    name: "Companies",
    fields: [
      f("fldzBJ1c98Y5wviTm", "Name", "singleLineText"),
      f("fldrtMFdA0cHj9Aeh", "LinkedIn", "url"),
      f("fldCLrrYTiMG8nrxo", "About", "multilineText"),
      f("fldXCHnaWiGzwjjUW", "Logo", "multipleAttachments"),
      f("fldTxY46iThubn8HK", "Website", "url"),
      f("fldxYiGlqXGXlsPV0", "Sector", "singleLineText"),
      link("fldPyE13fnzRefyih", "Work history", WORK),
      link("fldnj4lQo4vBTAGws", "People", PEOPLE),
      link("fldM8pfO1luPPGEXo", "Notes", NOTES),
    ],
  },
  {
    id: WORK,
    name: "Work history",
    fields: [
      f("fldzS7Pv9ocq6aueG", "Role", "formula"),
      f("fldXwAfDqpN13BSwM", "Title", "singleLineText"),
      link("flduTDvxs0L1eWyWD", "Company", COMPANIES),
      f("fldeCDU9qwRMwyESH", "Company Name", "multipleLookupValues"),
      link("fldjmSvXmRCd98JMk", "Person", PEOPLE),
      f("fldxJuN6ScIhcneZq", "Description", "multilineText"),
      f("fldGS87PaAX4csC1l", "Location", "singleLineText"),
      f("fldYPAJskFkfTScdy", "Timeframe", "singleLineText"),
      f("fldfsvlMrvrGJCdFA", "Start", "date"),
      f("fldC4oBixQUijH3HT", "End", "date"),
      f("fldtrGvHwTQlsAO7A", "Current", "checkbox"),
    ],
  },
  {
    id: NOTES,
    name: "Notes",
    fields: [
      f("fldd8yycHFyKsVpdM", "Summary", "formula"),
      f("fldqUcXvJMCcoCagi", "Note", "multilineText"),
      link("fld14DfOrMdGbHQoI", "Person", PEOPLE),
      link("fld7Yv8zgAbLM4zSi", "Company", COMPANIES),
    ],
  },
  {
    id: EDUCATION,
    name: "Education",
    fields: [
      f("fldk389mX9pLnMj62", "Name", "singleLineText"),
      f("fldDqDzDWfQAYOxoS", "LinkedIn URL", "url"),
      f("fldgTt4dOwtEVRLNc", "Logo", "multipleAttachments"),
      link("fldMG4qXi0PD6vTHV", "People", PEOPLE),
      link("flduR4OmOvSkSIuiP", "DELETE ME (old link)", PEOPLE),
    ],
  },
  {
    id: ROLES,
    name: "Roles",
    fields: [
      f("fldRoleTitle00001", "Title", "singleLineText"),
      link("fldRoleCompany001", "Company", COMPANIES),
      link("fldRoleManager001", "Hiring manager", PEOPLE),
    ],
  },
];

