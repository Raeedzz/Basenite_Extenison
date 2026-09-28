/**
 * Writing a profile's companies, jobs, and schools into their own tables.
 *
 *   Companies and Schools are shared lists someone may already curate: a row
 *   is found by LinkedIn page, then by name, and on a row that exists only
 *   blank cells are filled. Nothing is ever cleared or deleted.
 *   Work history rows are the extension's: one per person + company + title +
 *   start month, kept current by fingerprint like People cells.
 *
 * Runs inside airtable-sink's write queue; never on its own.
 */

import {
  AirtableError,
  attachmentsFailed,
  createRecords,
  getRecordsByIds,
  listRecords,
  lockedFieldOf,
  RECORDS_PER_REQUEST,
  updateRecords,
} from "./airtable-client.js";
import { attachmentFor, cellValue, fingerprint, imageExpired, imageUrl, normalizeName } from "./airtable-fields.js";
import { dropBrokenImages } from "./image-check.js";
import {
  linkedinPath,
  linkedinUrlFor,
  linkedReady,
  roleKey,
} from "./airtable-linked.js";
import { createRowStore } from "./row-store.js";

const LOG = (...args) => console.log("[Airtable:Linked]", ...args);

const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DETAILS_KEY = "linkedin_company_details";
// A company LinkedIn wouldn't describe is asked about again after this long.
const DETAILS_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const DETAIL_KEYS = new Set(["about", "website", "industry", "linkedinUrl"]);

// ─── Company details from LinkedIn ───────────────────────────────────────────

let detailsProvider = null;
let detailsCache = null;
let progressHook = null;

/** Told how the LinkedIn company lookups are going, so the panel isn't silent meanwhile. */
export function setLinkedProgressHook(hook) {
  progressHook = typeof hook === "function" ? hook : null;
}

function reportLookup(done, total, name) {
  try {
    void Promise.resolve(progressHook?.({ done, total, name })).catch(() => {});
  } catch { /* progress is cosmetic */ }
}

/** The worker supplies how to ask LinkedIn about a company (see linkedin-graph.js). */
export function setCompanyDetailsProvider(provider) {
  detailsProvider = typeof provider === "function" ? provider : null;
}

async function loadDetails() {
  if (!detailsCache) {
    const stored = await chrome.storage.local.get(DETAILS_KEY);
    detailsCache = new Map(Object.entries(stored[DETAILS_KEY] || {}));
  }
  return detailsCache;
}

/** Cached details, `null` for a known miss, `undefined` when never asked. */
async function cachedDetails(companyId) {
  if (!companyId) return null;
  const cache = await loadDetails();
  const hit = cache.get(companyId);
  if (!hit) return undefined;
  if (hit.missing) return Date.now() - hit.at > DETAILS_RETRY_MS ? undefined : null;
  return hit;
}

// After LinkedIn signs out or throttles, company lookups pause this long.
const DETAILS_PAUSE_MS = 10 * 60 * 1000;
let detailsPausedUntil = 0;
const detailsPaused = () => Date.now() < detailsPausedUntil;

async function fetchDetails(companyId, progress = null) {
  const cache = await loadDetails();
  // Paused: the company rows are still written, and their blank details are
  // filled on a later sync. A company lookup never fails the Airtable write.
  if (Date.now() < detailsPausedUntil) return null;
  if (progress) reportLookup(progress.done, progress.total, progress.name);
  let details = null;
  if (detailsProvider) {
    try {
      details = await detailsProvider(companyId);
    } catch (error) {
      if (/SESSION_EXPIRED|RATE_LIMITED|signed out/i.test(error?.message || "")) {
        // The capture itself hears about a real sign-out or throttle on its next request.
        detailsPausedUntil = Date.now() + DETAILS_PAUSE_MS;
        LOG(`Company lookups paused (${error.message}); details are filled on a later sync`);
        return null;
      }
      LOG(`No details for company ${companyId}:`, error?.message || error);
    }
  }
  const before = cache.get(companyId);
  // A failed re-ask (for a fresh logo) keeps what was known, and waits before asking again.
  const kept = !details && before && !before.missing ? { ...before, logoTriedAt: Date.now() } : null;
  cache.set(companyId, details ? { ...details, at: Date.now() } : kept ? { ...kept, at: Date.now() } : { missing: true, at: Date.now() });
  await chrome.storage.local.set({ [DETAILS_KEY]: Object.fromEntries(cache) });
  return details || kept;
}

// ─── Indexes ─────────────────────────────────────────────────────────────────

let stores = null;

function storesFor(config) {
  const linked = config.linked || {};
  const id = [config.baseId, linked.companies?.tableId, linked.schools?.tableId, linked.workHistory?.tableId].join(":");
  if (stores?.id === id) return stores;
  const prefix = (tableId) => `airtable_linked:${config.baseId}:${tableId}`;
  stores = {
    id,
    companies: linked.companies?.tableId ? createRowStore(prefix(linked.companies.tableId)) : null,
    schools: linked.schools?.tableId ? createRowStore(prefix(linked.schools.tableId)) : null,
    workHistory: linked.workHistory?.tableId ? createRowStore(prefix(linked.workHistory.tableId)) : null,
    lookups: new Map(),
  };
  return stores;
}

/** Save every linked index, whatever state the write that touched them ended in. */
export async function persistLinked() {
  if (!stores) return;
  for (const store of [stores.companies, stores.schools, stores.workHistory]) await store?.persist();
}

// Set when Airtable refused a link: the linked tables changed under the index.
let staleNext = false;

/** Re-read the linked tables on the next write (a link was refused as stale). */
export function markLinkedStale() {
  staleNext = true;
}

export function forgetLinkedState() {
  stores = null;
  detailsCache = null;
  detailsPausedUntil = 0;
}

export async function resetLinkedState(config) {
  const current = storesFor(config);
  for (const store of [current.companies, current.schools, current.workHistory]) await store?.remove();
  stores = null;
}

function blank(value) {
  return value === null || value === undefined || value === ""
    || (Array.isArray(value) && value.length === 0);
}

function firstId(value) {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}

/** Name and LinkedIn-page lookups over a shared list (companies or schools). */
function lookupsFor(kind, store) {
  const cached = stores.lookups.get(kind);
  if (cached) return cached;
  const byPath = new Map();
  const byName = new Map();
  for (const [recordId, entry] of store.entries()) addLookup({ byPath, byName }, recordId, entry);
  const built = { byPath, byName };
  stores.lookups.set(kind, built);
  return built;
}

function addLookup(lookups, recordId, entry) {
  if (entry.p && !lookups.byPath.has(entry.p)) lookups.byPath.set(entry.p, recordId);
  if (entry.n) {
    if (!lookups.byName.has(entry.n)) lookups.byName.set(entry.n, []);
    lookups.byName.get(entry.n).push(recordId);
  }
}

async function indexShared(config, kind) {
  const part = config.linked[kind];
  const store = stores[kind];
  const fieldIds = Object.values(part.fields);
  const records = await listRecords(config.token, config.baseId, part.tableId, { fieldIds });
  const next = new Map();
  for (const record of records) {
    const values = record.fields || {};
    const filled = {};
    for (const [key, fieldId] of Object.entries(part.fields)) filled[key] = !blank(values[fieldId]);
    next.set(record.id, {
      n: normalizeName(values[part.fields.name]),
      p: linkedinPath(values[part.fields.linkedinUrl]),
      e: filled,
      // Only the extension knows a typed-in name was folded into this row.
      ...(store.get(record.id)?.x ? { x: 1 } : {}),
    });
  }
  store.replace(next);
  stores.lookups.delete(kind);
  await store.persist();
  LOG(`Indexed ${next.size} rows in ${part.tableName}`);
}

async function indexWorkHistory(config) {
  const part = config.linked.workHistory;
  const store = stores.workHistory;
  const f = part.fields;
  const fieldIds = [f.person, f.company, f.title, f.start].filter(Boolean);
  const records = await listRecords(config.token, config.baseId, part.tableId, { fieldIds });
  const byRecord = new Map([...store.entries()].map(([key, row]) => [row.r, { key, row }]));
  const next = new Map();
  for (const record of records) {
    const values = record.fields || {};
    const key = roleKey(firstId(values[f.person]), firstId(values[f.company]), values[f.title], values[f.start] || "");
    if (next.has(key)) continue;
    // Fingerprints survive only for the same record under the same identity.
    const previous = byRecord.get(record.id);
    next.set(key, { r: record.id, h: previous?.key === key ? previous.row.h || {} : {} });
  }
  store.replace(next);
  await store.persist();
  LOG(`Indexed ${next.size} rows in ${part.tableName}`);
}

/** Load (and when stale or forced, rebuild) every configured linked index. */
export async function prepareLinked(config, { force: forced = false } = {}) {
  const ready = linkedReady(config.linked);
  if (!ready.companies && !ready.schools) return;
  const force = forced || staleNext;
  staleNext = false;
  storesFor(config);
  if (ready.companies) {
    await stores.companies.load();
    if (force || Date.now() - stores.companies.indexedAt > INDEX_MAX_AGE_MS) await indexShared(config, "companies");
  }
  if (ready.schools) {
    await stores.schools.load();
    if (force || Date.now() - stores.schools.indexedAt > INDEX_MAX_AGE_MS) await indexShared(config, "schools");
  }
  if (ready.workHistory) {
    await stores.workHistory.load();
    if (force || Date.now() - stores.workHistory.indexedAt > INDEX_MAX_AGE_MS) await indexWorkHistory(config);
  }
}

// ─── Writes ──────────────────────────────────────────────────────────────────

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function schemaOf(part) {
  return new Map((part.schema || []).map((field) => [field.id, field]));
}

function recoverable(error) {
  return error instanceof AirtableError && (error.status === 404 || error.status === 422);
}

/** Send `items` ({ fields, ... }) as creates, 10 per request; one bad row fails alone. */
/**
 * Typecast stays off, so a record id is only ever a link (never a name Airtable
 * might make a new record from). Select values that aren't choices yet go in
 * a typecast follow-up, which adds the choice.
 */
function splitChoices(part, fields, stale = false) {
  const schema = schemaOf(part);
  const now = {};
  const later = {};
  for (const [fieldId, value] of Object.entries(fields)) {
    const field = schema.get(fieldId);
    const choices = new Set((field?.options?.choices || []).map((choice) => choice.name));
    const select = field?.type === "singleSelect" || field?.type === "multipleSelects";
    // stale: Airtable said a listed choice is gone, so no choice is trusted.
    const isNew = select && (stale || [].concat(value).some((name) => !choices.has(name)));
    (isNew ? later : now)[fieldId] = value;
  }
  return { now, later: Object.keys(later).length ? later : null };
}

/** The typecast follow-up; false when it failed (the cells then count as still blank). */
async function followUp(config, part, entries) {
  if (!entries.length) return true;
  try {
    await updateRecords(config.token, config.baseId, part.tableId, entries.map(({ id, fields }) => ({ id, fields })));
    return true;
  } catch (error) {
    LOG(`Couldn't add new choices in ${part.tableName}:`, error?.message || error);
    return false;
  }
}

function staleChoice(error) {
  return error instanceof AirtableError && error.status === 422 && error.type === "INVALID_MULTIPLE_CHOICE_OPTIONS";
}

// A row can't do without these; a locked one fails the row instead of being left out.
const REQUIRED_KEYS = new Set(["name", "person", "company", "title"]);

/** Airtable couldn't attach some logos: leave those cells counted as blank, so they're tried again. */
function dropFailedAttachments(part, result, group) {
  if (!attachmentsFailed(result)) return;
  const schema = schemaOf(part);
  for (const item of group) {
    for (const fieldId of Object.keys(item.fields)) if (schema.get(fieldId)?.type === "multipleAttachments") delete item.fields[fieldId];
  }
}

/** A 403 naming one column this token can't write: drop it from the group. */
function dropLockedColumn(part, error, group) {
  const named = error instanceof AirtableError && error.status === 403 ? lockedFieldOf(error.message) : null;
  const field = named && (part.schema || []).find((candidate) => candidate.id === named || candidate.name === named);
  if (!field || !group.some((item) => field.id in item.fields)) return false;
  const key = Object.entries(part.fields || {}).find(([, fieldId]) => fieldId === field.id)?.[0];
  if (REQUIRED_KEYS.has(key)) return false;
  LOG(`Airtable won't let this token write "${field.name}" in ${part.tableName}; leaving it out`);
  for (const item of group) delete item.fields[field.id];
  return true;
}

/** Send `items` ({ fields, ... }) as creates, 10 per request; one bad row fails alone. */
async function create(config, part, items, onCreated, tally, stale = false) {
  for (const group of chunk(items, RECORDS_PER_REQUEST)) {
    try {
      const split = group.map((item) => splitChoices(part, item.fields, stale));
      const created = await createRecords(config.token, config.baseId, part.tableId, split.map(({ now }) => ({ fields: now })), { typecast: false });
      dropFailedAttachments(part, created, group);
      const entries = group
        .map((item, index) => ({ item, id: created[index]?.id, fields: split[index].later }))
        .filter((entry) => entry.id && entry.fields);
      if (!(await followUp(config, part, entries))) {
        for (const { item, fields } of entries) for (const fieldId of Object.keys(fields)) delete item.fields[fieldId];
      }
      group.forEach((item, index) => created[index]?.id && onCreated(item, created[index].id));
    } catch (error) {
      if (dropLockedColumn(part, error, group)) {
        await create(config, part, group, onCreated, tally, stale);
        continue;
      }
      if (staleChoice(error) && !stale) {
        await create(config, part, group, onCreated, tally, true);
        continue;
      }
      if (!recoverable(error)) throw error;
      if (group.length > 1) {
        for (const item of group) await create(config, part, [item], onCreated, tally, stale);
        continue;
      }
      tally.linkedFailed++;
      tally.errors.push(error.message);
    }
  }
}

async function update(config, part, items, onUpdated, tally, onGone = null, stale = false) {
  for (const group of chunk(items, RECORDS_PER_REQUEST)) {
    try {
      const split = group.map((item) => ({ item, ...splitChoices(part, item.fields, stale) }));
      const sendable = split.filter(({ now }) => Object.keys(now).length);
      const updated = sendable.length
        ? await updateRecords(config.token, config.baseId, part.tableId, sendable.map(({ item, now }) => ({ id: item.id, fields: now })), { typecast: false })
        : [];
      dropFailedAttachments(part, updated, group);
      const entries = split.filter(({ later }) => later).map(({ item, later }) => ({ item, id: item.id, fields: later }));
      if (!(await followUp(config, part, entries))) {
        for (const { item, fields } of entries) for (const fieldId of Object.keys(fields)) delete item.fields[fieldId];
      }
      group.forEach((item) => onUpdated(item));
    } catch (error) {
      if (dropLockedColumn(part, error, group)) {
        await update(config, part, group.filter((item) => Object.keys(item.fields).length), onUpdated, tally, onGone, stale);
        continue;
      }
      if (staleChoice(error) && !stale) {
        await update(config, part, group, onUpdated, tally, onGone, true);
        continue;
      }
      if (!recoverable(error)) throw error;
      if (group.length > 1) {
        for (const item of group) await update(config, part, [item], onUpdated, tally, onGone, stale);
        continue;
      }
      if (error.status === 404 && onGone) {
        onGone(group[0]);
        continue;
      }
      tally.linkedFailed++;
      tally.errors.push(error.message);
    }
  }
}

/** Cell values for the columns this part maps, skipping anything empty. */
function cells(part, values, keys = Object.keys(part.fields)) {
  const schema = schemaOf(part);
  const out = {};
  for (const key of keys) {
    const fieldId = part.fields[key];
    const value = fieldId ? cellValue(values[key], schema.get(fieldId)) : undefined;
    if (value !== undefined) out[fieldId] = value;
  }
  return out;
}

/**
 * A logo is wanted but the only URL on hand is a cached one that has expired:
 * ask LinkedIn again. A company LinkedIn shows no logo (or only its
 * placeholder) for isn't re-asked, nor is one whose last re-ask failed lately.
 */
function staleLogo(part, entity, details, blankKeys) {
  return Boolean(part.fields.logo) && blankKeys.includes("logo")
    && !imageUrl(entity.logoUrl) && imageExpired(details?.logoUrl)
    && !(Date.now() - Number(details.logoTriedAt || 0) < DETAILS_RETRY_MS);
}

function sharedValues(kind, entity, details) {
  if (kind === "schools") {
    const slug = normalizeName(entity.name) || entity.linkedinPath;
    return { name: entity.name, linkedinUrl: linkedinUrlFor(entity.linkedinPath), logo: attachmentFor(entity.logoUrl, slug) };
  }
  const path = details?.universalName ? `company/${String(details.universalName).toLowerCase()}` : entity.linkedinPath;
  const slug = details?.universalName || normalizeName(details?.name || entity.name) || path;
  return {
    name: details?.name || entity.name,
    linkedinUrl: linkedinUrlFor(path),
    about: details?.about || "",
    logo: attachmentFor(entity.logoUrl, slug) || attachmentFor(details?.logoUrl, slug),
    website: details?.website || "",
    industry: details?.industry || "",
  };
}

/**
 * Find or create each company (or school), filling blanks on rows that exist.
 * Returns entity key → record id.
 */
// Companies and schools are shared with teammates and hand edits: a list read
// longer ago than this is read again before anything is found or created.
const SHARED_FRESH_MS = 10 * 60 * 1000;

async function resolveShared(config, kind, entities, tally) {
  const part = config.linked[kind];
  const store = stores[kind];
  if (entities.size && Date.now() - store.indexedAt > SHARED_FRESH_MS) await indexShared(config, kind);
  const lookups = lookupsFor(kind, store);
  const ids = new Map();
  const creates = [];
  const patches = [];

  const match = (entity, details) => {
    const paths = [
      details?.universalName ? `company/${String(details.universalName).toLowerCase()}` : null,
      entity.linkedinPath,
    ].filter(Boolean);
    for (const path of paths) {
      const hit = lookups.byPath.get(path);
      if (hit) return hit;
    }
    for (const name of [entity.name, details?.name]) {
      const candidates = lookups.byName.get(normalizeName(name)) || [];
      // A company row that already names a LinkedIn page is someone else's
      // unless the page matched above, or the extension folded this typed-in
      // name into it itself (x); schools match on name alone.
      const hit = kind === "schools" ? candidates[0]
        : candidates.find((id) => !store.get(id)?.p) || candidates.find((id) => store.get(id)?.x);
      if (hit) return hit;
    }
    return null;
  };

  // Only companies LinkedIn is asked about count toward "looking up N".
  const toLookUp = kind === "companies"
    ? (await Promise.all([...entities.values()].map(async (entity) => ((await cachedDetails(entity.companyId)) === undefined ? 1 : 0))))
      .reduce((sum, value) => sum + value, 0)
    : 0;
  let looked = 0;
  const lookup = async (entity) => {
    looked++;
    return fetchDetails(entity.companyId, { done: looked, total: Math.max(toLookUp, looked), name: entity.name });
  };

  for (const entity of entities.values()) {
    const companyId = kind === "companies" ? entity.companyId : null;
    let details = kind === "companies" ? await cachedDetails(companyId) : null;
    // Not in the cache: LinkedIn is asked below (and, while paused, can't answer).
    const neverAsked = details === undefined;
    let recordId = match(entity, details);
    if (!recordId && details === undefined) {
      details = await lookup(entity);
      recordId = match(entity, details);
    }
    if (recordId) {
      ids.set(entity.key, recordId);
      const entry = store.get(recordId);
      const blanks = Object.keys(part.fields).filter((key) => !entry?.e?.[key]);
      if (blanks.length === 0) continue;
      if (details === undefined && blanks.some((key) => DETAIL_KEYS.has(key))) details = await lookup(entity);
      else if (kind === "companies" && staleLogo(part, entity, details, blanks)) details = (await lookup(entity)) ?? details;
      const fields = cells(part, sharedValues(kind, entity, details), blanks);
      // Two entries on one profile can land on the same row: one patch, first value wins.
      const pending = patches.find((item) => item.id === recordId);
      if (pending) pending.fields = { ...fields, ...pending.fields };
      else if (Object.keys(fields).length) patches.push({ id: recordId, fields, keys: blanks });
      continue;
    }
    if (details === undefined || (kind === "companies" && staleLogo(part, entity, details, ["logo"]))) {
      details = (await lookup(entity)) ?? (details || null);
    }
    // Lookups paused (LinkedIn signed out or throttling): without its page this
    // company can't be matched to a row that has one, so it waits for a later
    // sync rather than risk a second row.
    if (kind === "companies" && entity.companyId && neverAsked && !details && detailsPaused()) continue;
    const values = sharedValues(kind, entity, details);
    if (!values.name) continue;
    // Already being created for someone else in this batch (the same company
    // reached once by its LinkedIn id and once by name): one row, both keys.
    const path = linkedinPath(values.linkedinUrl);
    const name = normalizeName(values.name);
    const twin = creates.find((item) => (path && item.path === path)
      || (name && item.name === name && (!path || !item.path || kind === "schools")));
    if (twin) {
      twin.keys.push(entity.key);
      if (kind === "companies" && Boolean(path) !== Boolean(twin.path)) {
        // A typed-in name folded into a LinkedIn page: the row is the page's,
        // and remembers the name (x) so the next sync finds it again.
        if (path) Object.assign(twin, { entity, path, name, values, fields: cells(part, values) });
        twin.alias = true;
      }
      continue;
    }
    creates.push({ entity, keys: [entity.key], path, name, values, fields: cells(part, values) });
  }

  // A logo that won't download is left out; the blank Logo is tried again next sync.
  await dropBrokenImages(creates, [part.fields.logo]);
  await create(config, part, creates, (item, recordId) => {
    const entry = {
      n: normalizeName(item.values.name),
      p: linkedinPath(item.values.linkedinUrl),
      e: Object.fromEntries(Object.entries(part.fields).map(([key, fieldId]) => [key, fieldId in item.fields])),
      ...(item.alias ? { x: 1 } : {}),
    };
    store.set(recordId, entry);
    addLookup(lookups, recordId, entry);
    for (const key of item.keys) ids.set(key, recordId);
    tally.linked[`${kind}Created`]++;
  }, tally);
  // The index can be a day old: re-read the cells about to be filled, and
  // leave any someone has filled since.
  for (const group of chunk(patches, RECORDS_PER_REQUEST)) {
    const fieldIds = [...new Set(group.flatMap((item) => Object.keys(item.fields)))];
    const records = await getRecordsByIds(config.token, config.baseId, part.tableId, group.map((item) => item.id), { fieldIds });
    const current = new Map(records.map((record) => [record.id, record.fields || {}]));
    for (const item of group) {
      const now = current.get(item.id);
      if (!now) {
        item.fields = {};
        continue;
      }
      const entry = store.get(item.id);
      for (const [key, fieldId] of Object.entries(part.fields)) {
        if (fieldId in item.fields && !blank(now[fieldId])) {
          delete item.fields[fieldId];
          if (entry) entry.e[key] = true;
        }
      }
    }
  }
  await dropBrokenImages(patches, [part.fields.logo]);
  const toPatch = patches.filter((item) => Object.keys(item.fields).length);
  await update(config, part, toPatch, (item) => {
    const entry = store.get(item.id);
    for (const [key, fieldId] of Object.entries(part.fields)) {
      if (fieldId in item.fields) entry.e[key] = true;
    }
    if (item.fields[part.fields.linkedinUrl]) {
      entry.p = linkedinPath(item.fields[part.fields.linkedinUrl]);
      addLookup(lookups, item.id, entry);
    }
    store.set(item.id, entry);
    tally.linked[`${kind}Filled`]++;
  }, tally, (item) => {
    // Deleted in Airtable: forget it so it's found or created fresh next time.
    store.delete(item.id);
    stores.lookups.delete(kind);
  });
  await store.persist();
  return ids;
}

/**
 * Companies and schools for every person in the batch. Returns, per person
 * key, the record ids their People link columns should include.
 */
export async function resolvePeopleLinks(config, people, tally) {
  const ready = linkedReady(config.linked);
  storesFor(config);
  const companies = new Map();
  const schools = new Map();
  // The same company or school on several profiles: one entity, with a logo if any of them had one.
  const gather = (into, entries) => {
    for (const [key, entity] of entries || []) {
      const seen = into.get(key);
      if (!seen) into.set(key, entity);
      else if (!imageUrl(seen.logoUrl) && imageUrl(entity.logoUrl)) into.set(key, { ...seen, logoUrl: entity.logoUrl });
    }
  };
  for (const person of people.values()) {
    gather(companies, person.linked?.companies);
    gather(schools, person.linked?.schools);
  }
  const companyIds = ready.companies && companies.size ? await resolveShared(config, "companies", companies, tally) : new Map();
  const schoolIds = ready.schools && schools.size ? await resolveShared(config, "schools", schools, tally) : new Map();
  const perPerson = new Map();
  for (const [key, person] of people) {
    if (!person.linked) continue;
    const ids = (entities, resolved) => [...new Set([...(entities?.keys() || [])].map((entity) => resolved.get(entity)).filter(Boolean))];
    const current = person.linked.currentCompanyKey ? companyIds.get(person.linked.currentCompanyKey) : null;
    perPerson.set(key, {
      workedAt: ready.workedAt ? ids(person.linked.companies, companyIds) : [],
      currentCompany: ready.currentCompany && current ? [current] : [],
      schools: ready.schoolsLink ? ids(person.linked.schools, schoolIds) : [],
    });
  }
  return { perPerson, companyIds };
}

/** One Work history row per job, linked to its person and company. */
export async function syncWorkHistory(config, jobs, companyIds, tally) {
  if (!linkedReady(config.linked).workHistory) return;
  const part = config.linked.workHistory;
  const store = stores.workHistory;
  const schema = schemaOf(part);
  const creates = [];
  const updates = [];
  const seen = new Set();
  // Same person, company, and start month under another title: the title was
  // edited on LinkedIn, so it's that row, retitled, not a second job.
  const byStart = new Map();
  for (const [key, row] of store.entries()) {
    const [person, company, , start] = key.split("|");
    if (start && row.r) byStart.set(`${person}|${company}|${start}`, key);
  }
  // Every job in this batch, keyed first, so a retitle can't swallow a row
  // that another current job still owns.
  const wanted = [];
  for (const { personId, roles } of jobs) {
    for (const role of roles) {
      const companyId = companyIds.get(role.companyKey);
      if (!personId || !companyId) continue;
      wanted.push({ personId, companyId, role, key: roleKey(personId, companyId, role.title, role.start) });
    }
  }
  const wantedKeys = new Set(wanted.map((job) => job.key));
  for (const { personId, companyId, role, key } of wanted) {
    if (seen.has(key)) continue;
    seen.add(key);
    const values = { ...role, company: [companyId], person: [personId] };
    const startMonth = role.start ? role.start.slice(0, 7) : "";
    const retitled = !store.get(key) && startMonth ? byStart.get(`${personId}|${companyId}|${startMonth}`) : null;
    if (retitled && retitled !== key && !wantedKeys.has(retitled) && store.get(retitled)?.r) {
      store.set(key, store.get(retitled));
      store.delete(retitled);
      byStart.delete(`${personId}|${companyId}|${startMonth}`);
    }
    const existing = store.get(key);
    const previous = existing ? existing.h || {} : null;
    const fields = {};
    const hashes = { ...(previous || {}) };
    for (const [roleName, fieldId] of Object.entries(part.fields)) {
      const value = cellValue(values[roleName], schema.get(fieldId));
      if (value === undefined) continue;
      const print = fingerprint([fieldId, value]);
      if (hashes[roleName] === print) continue;
      fields[fieldId] = value;
      hashes[roleName] = print;
    }
    if (!existing) creates.push({ key, fields, hashes });
    else if (Object.keys(fields).length) updates.push({ key, id: existing.r, fields, hashes });
  }
  await create(config, part, creates, (item, recordId) => {
    store.set(item.key, { r: recordId, h: item.hashes });
    tally.linked.workHistoryCreated++;
  }, tally);
  await update(config, part, updates, (item) => {
    store.set(item.key, { r: item.id, h: item.hashes });
    tally.linked.workHistoryUpdated++;
  }, tally, (item) => {
    // Deleted in Airtable: forget it, and the next sync creates it again.
    store.delete(item.key);
  });
  await store.persist();
}

export function emptyLinkedTally() {
  return {
    companiesCreated: 0,
    companiesFilled: 0,
    schoolsCreated: 0,
    schoolsFilled: 0,
    workHistoryCreated: 0,
    workHistoryUpdated: 0,
  };
}

