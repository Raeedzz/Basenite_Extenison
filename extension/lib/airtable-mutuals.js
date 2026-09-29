/**
 * Mutuals: one row per pair of People LinkedIn shows as connected, both sides
 * linked. Create-only, by field id, typecast off. A pair already there (either
 * way round) is left exactly as it is, and nothing here edits or deletes a
 * row. People's own mutual columns fill in from the links; they're only read.
 */
import { createRecords, getRecordsByIds, listRecords, RECORDS_PER_REQUEST } from "./airtable-client.js";
import { linkedinKey } from "./airtable-fields.js";
import { peopleRecordIds, readConfig, writePeople } from "./airtable-sink.js";

const LOG = (...args) => console.log("[Airtable:Mutuals]", ...args);

export const MUTUALS = {
  table: "tblGXBDu4veC1PZlh",
  pair: "fldN8QQGhJiwyWvYY",
  personA: "flduaBmjW0BU9zcFs",
  personB: "fldzWRZT0gTsXMP9t",
  source: "fld3JhXjBEo31dc7x",
  observed: "fldTL0qdCxT29AzzC",
};

const SOURCE = "Branch";
const READ_BATCH = 100;

/** The base has Mutuals with every column written, both people linking to People. */
export function mutualsReady(baseTables, peopleTableId) {
  const table = (baseTables || []).find((candidate) => candidate.id === MUTUALS.table);
  const field = (id) => table?.fields.find((candidate) => candidate.id === id);
  const toPeople = (id) => field(id)?.type === "multipleRecordLinks" && field(id).options?.linkedTableId === peopleTableId;
  return Boolean(table) && [MUTUALS.pair, MUTUALS.source, MUTUALS.observed].every(field)
    && toPeople(MUTUALS.personA) && toPeople(MUTUALS.personB);
}

/** People's links back to Mutuals (as A, as B). */
function backLinks(baseTables, peopleTableId) {
  const people = (baseTables || []).find((candidate) => candidate.id === peopleTableId);
  return (people?.fields || [])
    .filter((field) => field.type === "multipleRecordLinks" && field.options?.linkedTableId === MUTUALS.table)
    .map((field) => field.id);
}

/** The sync's date in Chicago, as YYYY-MM-DD. */
export function observedDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const pairKey = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
const only = (value) => (Array.isArray(value) && value.length === 1 ? value[0] : null);

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function byIds(config, table, ids, fieldIds) {
  const records = [];
  for (const group of chunk(ids, READ_BATCH)) records.push(...await getRecordsByIds(config.token, config.baseId, table, group, { fieldIds }));
  return records;
}

/** Every pair already in Mutuals that involves one of these people, read once. */
async function existingPairs(config, personIds) {
  const links = backLinks(config.baseTables, config.tableId);
  let rows;
  if (links.length) {
    const people = await byIds(config, config.tableId, personIds, links);
    const ids = [...new Set(people.flatMap((record) => links.flatMap((fieldId) => record.fields?.[fieldId] || [])))];
    rows = await byIds(config, MUTUALS.table, ids, [MUTUALS.personA, MUTUALS.personB]);
  } else {
    rows = await listRecords(config.token, config.baseId, MUTUALS.table, { fieldIds: [MUTUALS.personA, MUTUALS.personB] });
  }
  const pairs = new Set();
  for (const record of rows) {
    const a = only(record.fields?.[MUTUALS.personA]);
    const b = only(record.fields?.[MUTUALS.personB]);
    if (a && b) pairs.add(pairKey(a, b));
  }
  return pairs;
}

/** Names for the Pair label: LinkedIn's where known, else the People row's. */
async function fillNames(config, names, ids) {
  const nameField = config.mapping?.name;
  const missing = ids.filter((id) => !names.get(id));
  if (!nameField || !missing.length) return;
  for (const record of await byIds(config, config.tableId, missing, [nameField])) {
    const name = record.fields?.[nameField];
    if (typeof name === "string" && name.trim()) names.set(record.id, name.trim());
  }
}

/** Ten per request; a refused group goes again singly so one bad pair doesn't sink the rest. */
async function sendCreates(config, items, tally, pairs) {
  for (const group of chunk(items, RECORDS_PER_REQUEST)) {
    try {
      await createRecords(config.token, config.baseId, MUTUALS.table, group.map(({ fields }) => ({ fields })), { typecast: false });
      tally.created += group.length;
      for (const item of group) pairs.add(item.key);
    } catch (error) {
      if (group.length > 1 && error?.status === 422) {
        for (const item of group) await sendCreates(config, [item], tally, pairs);
        continue;
      }
      // Never resent now: one that may have landed is read back next sync, not sent twice.
      tally.failed += group.length;
      LOG(`Couldn't add ${group.length} pair(s); trying again next sync:`, error?.message || error);
    }
  }
}

/**
 * `targets`: [{ id, name, mutuals: [{ id | null, name }] }], ids being People
 * record ids (null: not in People). Returns { created, existing, skipped, failed }.
 */
export async function syncMutuals(config, targets, now = new Date()) {
  const tally = { created: 0, existing: 0, skipped: 0, failed: 0 };
  const named = targets.filter((target) => target.id);
  for (const target of targets) {
    const missing = target.mutuals.filter((mutual) => !mutual.id).length;
    tally.skipped += target.id ? missing : target.mutuals.length;
  }
  if (!named.length) return tally;
  const pairs = await existingPairs(config, [...new Set(named.map((target) => target.id))]);
  const names = new Map();
  const planned = new Map();
  for (const target of named) {
    if (target.name) names.set(target.id, target.name);
    for (const mutual of target.mutuals) {
      if (!mutual.id || mutual.id === target.id) continue;
      if (mutual.name && !names.has(mutual.id)) names.set(mutual.id, mutual.name);
      const key = pairKey(target.id, mutual.id);
      if (pairs.has(key) || planned.has(key)) {
        tally.existing++;
        continue;
      }
      planned.set(key, target.id < mutual.id ? [target.id, mutual.id] : [mutual.id, target.id]);
    }
  }
  if (!planned.size) return tally;
  await fillNames(config, names, [...new Set([...planned.values()].flat())]);
  const date = observedDate(now);
  const items = [...planned].map(([key, [a, b]]) => ({
    key,
    fields: {
      [MUTUALS.pair]: `${names.get(a) || a} <> ${names.get(b) || b}`,
      [MUTUALS.personA]: [a],
      [MUTUALS.personB]: [b],
      [MUTUALS.source]: SOURCE,
      [MUTUALS.observed]: date,
    },
  }));
  await sendCreates(config, items, tally, pairs);
  return tally;
}

export function mutualsLine(tally) {
  return `Mutuals: ${tally.created} new, ${tally.existing} already linked, ${tally.skipped} skipped (not in People)`
    + (tally.failed ? `, ${tally.failed} failed` : "");
}

/**
 * Mutual-finder results into Mutuals: each target paired with each of its
 * bridges. The target's own People row is written before this. A bridge not in
 * People is skipped, or with `createPeople` added there first (name, LinkedIn,
 * headline, photo) the way any captured person is. Null when the base has no
 * Mutuals table.
 */
export async function recordMutuals(results, { createPeople = false, now = new Date() } = {}) {
  const config = await readConfig();
  if (!mutualsReady(config.baseTables, config.tableId)) return null;
  const withBridges = (results || []).filter((result) => linkedinKey(result?.linkedinUrl) && Array.isArray(result?.bridges));
  const bridges = new Map();
  for (const result of withBridges) {
    for (const bridge of result.bridges) {
      const key = linkedinKey(bridge?.linkedinUrl);
      if (key && !bridges.has(key)) bridges.set(key, bridge);
    }
  }
  const urls = [...withBridges.map((result) => result.linkedinUrl), ...[...bridges.values()].map((bridge) => bridge.linkedinUrl)];
  let ids = await peopleRecordIds(urls);
  const missing = [...bridges].filter(([key]) => !ids.has(key)).map(([, bridge]) => bridge);
  if (createPeople && missing.length) {
    try {
      await writePeople(missing.map(({ name, linkedinUrl, headline, photoUrl }) => ({ name, linkedinUrl, headline, photoUrl })),
        { source: "Mutual finder" });
    } catch (error) {
      LOG("Couldn't add mutuals to People; they're skipped this time:", error?.message || error);
    }
    ids = await peopleRecordIds(urls);
  }
  const targets = withBridges.map((result) => ({
    id: ids.get(linkedinKey(result.linkedinUrl)) || null,
    name: result.profile?.name || null,
    mutuals: [...new Map(result.bridges
      .filter((bridge) => linkedinKey(bridge?.linkedinUrl))
      .map((bridge) => [linkedinKey(bridge.linkedinUrl), { id: ids.get(linkedinKey(bridge.linkedinUrl)) || null, name: bridge.name || null }]))
      .values()],
  }));
  const tally = await syncMutuals(await readConfig(), targets, now);
  LOG(mutualsLine(tally));
  return tally;
}
