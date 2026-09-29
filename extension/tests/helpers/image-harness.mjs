// Shared setup for the image and edge-case tests: a chrome.storage stub, the real Basanite
// layout in the strict fake, and stubbed image downloads / company details.

export const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null) return Object.fromEntries(store);
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.map((key) => [key, store.get(key)]));
      },
      async set(next) { for (const [key, value] of Object.entries(next)) store.set(key, structuredClone(value)); },
      async remove(keys) { for (const key of [].concat(keys)) store.delete(key); },
    },
  },
};

export const fields = await import(`../../lib/airtable-fields.js`);
export const linked = await import(`../../lib/airtable-linked.js`);
export const sink = await import(`../../lib/airtable-sink.js`);
export const linkedSync = await import(`../../lib/airtable-linked-sync.js`);
export const images = await import(`../../lib/image-check.js`);
export const { BASE_ID, fakeBase } = await import(`./fake-airtable.mjs`);
export const basanite = await import(`./basanite-base.mjs`);
export const { BASANITE_TABLES, COMPANIES, EDUCATION, PEOPLE } = basanite;

export const P = {
  name: "fldqwePau2SiMdzzW",
  linkedin: "fldvyrmtV2q06ip6k",
  headline: "fld3BmFW5JllGAygg",
  photo: "fldgPl6eKZLPIuLHw",
  source: "fldSource00000001",
  knownBy: "fldC0cY3rR5dWzKB9",
};
export const C = { name: "fldzBJ1c98Y5wviTm", linkedin: "fldrtMFdA0cHj9Aeh", logo: "fldXCHnaWiGzwjjUW" };

export const later = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;
export const past = Math.floor(Date.now() / 1000) - 3600;
export const cdn = (id, { e = later, t = "sig1" } = {}) =>
  `https://media.licdn.com/dms/image/v2/${id}/profile-displayphoto-shrink_800_800/0?e=${e}&v=beta&t=${t}`;
export const GHOST = "https://static.licdn.com/aero-v1/sc/h/9c8pery4andzj6ohjkjp54ma2";

export const state = { details: {} };

/**
 * `tables` lets a test add columns; `mapping` patches the suggested mapping.
 */
export function setup(records = {}, { broken = [], tables: tweak = (t) => t, mapping = {}, config = {} } = {}) {
  store.clear();
  sink.forgetTableState();
  const layout = tweak(structuredClone(BASANITE_TABLES));
  const tables = layout.map((table) => ({ ...table, records: records[table.id] || [] }));
  const base = fakeBase({ baseId: BASE_ID, tables });
  globalThis.fetch = base.handle;
  const people = layout.find((table) => table.id === PEOPLE);
  store.set("airtable_config", {
    token: "patTESTTOKEN.0123456789abcdef",
    baseId: BASE_ID,
    tableId: PEOPLE,
    tableName: "People",
    fields: people.fields,
    mapping: { ...fields.suggestMapping(people.fields), ...mapping },
    stampValue: "Added By Branch",
    userId: "usrME000000000001",
    baseName: "Basanite OS — Live",
    linked: linked.suggestLinked(layout, PEOPLE),
    baseTables: sink.summarizeTables(layout),
    schemaAt: Date.now(),
    ...config,
  });
  const checked = [];
  images.setImageFetcher(async (url) => {
    checked.push(url);
    return broken.some((part) => url.includes(part)) ? null : { contentType: "image/jpeg", bytes: new TextEncoder().encode(url) };
  });
  const asked = [];
  state.details = {};
  linkedSync.setCompanyDetailsProvider(async (id) => {
    asked.push(id);
    const hit = state.details[id];
    return typeof hit === "function" ? hit() : hit || null;
  });
  return { base, asked, checked };
}

export const person = (slug, extra = {}) => ({
  name: `Person ${slug}`,
  headline: `Headline ${slug}`,
  linkedinUrl: `https://www.linkedin.com/in/${slug}`,
  photoUrl: cdn(`photo-${slug}`),
  ...extra,
});
