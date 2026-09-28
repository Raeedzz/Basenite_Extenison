/**
 * Where captured people land: one Airtable table, matched on LinkedIn URL.
 *
 * The extension keeps, per table, which record holds each person and a
 * fingerprint of every cell it last wrote there. A write then costs requests
 * only for cells whose value actually moved, which is what makes a soft sync
 * twelve times a day affordable: a network that did not change sends nothing.
 * A cell someone edited by hand in Airtable is left alone until LinkedIn's own
 * value changes.
 *
 * The record index is rebuilt from the table itself once a day (and at
 * the start of every full sync), so people added by hand are matched instead
 * of duplicated and rows deleted in Airtable are recreated.
 */

import {
  canMap,
  canonicalLinkedinUrl,
  extractPerson,
  fingerprint,
  linkedinKey,
  offerNewMappings,
  planCells,
  SOURCE_FIELDS,
  suggestStampValue,
} from "./airtable-fields.js";
import {
  AirtableError,
  attachmentsFailed,
  createRecords,
  getRecordsByIds,
  listRecords,
  listTables,
  lockedFieldOf,
  RECORDS_PER_REQUEST,
  updateRecords,
} from "./airtable-client.js";
import { dropBrokenImages } from "./image-check.js";
import {
  extractLinked,
  linkedReady,
  offerNewPeopleLinks,
  peopleTableMismatch,
  pruneLinked,
  suggestLinked,
} from "./airtable-linked.js";
import {
  emptyLinkedTally,
  forgetLinkedState,
  markLinkedStale,
  persistLinked,
  prepareLinked,
  resetLinkedState,
  resolvePeopleLinks,
  syncWorkHistory,
} from "./airtable-linked-sync.js";

const LOG = (...args) => console.log("[Airtable]", ...args);

export const CONFIG_KEY = "airtable_config";
export const LAST_WRITE_KEY = "airtable_last_write";
const ROWS_PREFIX = "airtable_rows";
const BUCKETS = 32;

const SCHEMA_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// Set while a write is sending; still set at the next write means it was cut off.
const WRITE_OPEN_KEY = "airtable_write_open";
export const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ─── Config ──────────────────────────────────────────────────────────────────

export async function readConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const config = stored[CONFIG_KEY];
  return config && typeof config === "object" ? config : {};
}

// What's remembered per table, so switching tables and back restores your mapping.
const PER_TABLE = ["mapping", "mappingSeen", "stampValue", "linked", "linkedChosen", "linkedSeen"];

export async function writeConfig(patch) {
  const next = { ...(await readConfig()), ...patch, updatedAt: Date.now() };
  if (next.baseId && next.tableId && PER_TABLE.some((key) => key in patch)) {
    const key = `${next.baseId}:${next.tableId}`;
    next.tableSetups = {
      ...(next.tableSetups || {}),
      [key]: Object.fromEntries(PER_TABLE.map((name) => [name, next[name] ?? null])),
    };
  }
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

/** The mapping last used with this table, if it has been set up before. */
export function savedSetupFor(config, baseId, tableId) {
  return config.tableSetups?.[`${baseId}:${tableId}`] || null;
}

// What Disconnect leaves behind: nothing about the base, or the people in it.
const LOCAL_DATA = /^(airtable_|linkedin_company_details$|bulk_enrich_job$|company_capture$|earthos_li_progress$|earthos_li_reciprocity_probed$)/;

/** Disconnect: the token, the setup, and every local index and cache made for this base. */
export function clearConfig() {
  // After any write in flight, never in the middle of one.
  return queue(async () => {
    const everything = await chrome.storage.local.get(null).catch(() => ({}));
    const keys = Object.keys(everything || {}).filter((key) => LOCAL_DATA.test(key));
    await chrome.storage.local.remove([...new Set([CONFIG_KEY, ...keys])]);
    state = null;
    lockedFields.clear();
    forgetLinkedState();
  });
}

function fieldsById(config) {
  return new Map((config.fields || []).map((field) => [field.id, field]));
}

/** Why this config cannot take a write yet, or null when it can. */
export function configProblem(config) {
  if (!config?.token) return "Connect Airtable in the side panel first.";
  if (!config.baseId || !config.tableId) return "Pick the Airtable base and table people go into.";
  // People go where the base's own Work history links them, nowhere else.
  const mismatch = peopleTableMismatch(config.baseTables || [], config.tableId);
  if (mismatch) {
    return `People belong in ${mismatch.name} (that's where ${mismatch.via} links them), not ${config.tableName}. Switch the table in setup.`;
  }
  const key = fieldsById(config).get(config.mapping?.linkedinUrl);
  if (!canMap("linkedinUrl", key)) return "Map a LinkedIn URL column in the side panel — it's how people are matched.";
  return null;
}

export async function isConfigured() {
  return configProblem(await readConfig()) === null;
}

async function requireConfig() {
  const config = await readConfig();
  const problem = configProblem(config);
  if (problem) throw new AirtableError(problem, { status: 401 });
  return config;
}

/** Every table in the base with its columns, for the linked-table pickers. */
export function summarizeTables(tables) {
  return tables.map((table) => ({
    id: table.id,
    name: table.name,
    fields: table.fields.map(({ id, name, type, options }) => ({
      id, name, type, ...(options?.linkedTableId ? { options: { linkedTableId: options.linkedTableId } } : {}),
    })),
  }));
}

/**
 * Re-read the table's columns. A column deleted or retyped in Airtable leaves
 * the mapping, rather than failing every write that names it.
 */
export async function refreshSchema(config) {
  const tables = await listTables(config.token, config.baseId);
  const table = tables.find((candidate) => candidate.id === config.tableId);
  if (!table) throw new AirtableError(`The table "${config.tableName || config.tableId}" is gone from this base.`, { status: 404 });
  const fields = table.fields.map(({ id, name, type, options }) => ({ id, name, type, options }));
  const live = new Map(fields.map((field) => [field.id, field]));
  const kept = Object.fromEntries(
    Object.entries(config.mapping || {}).filter(([key, fieldId]) => canMap(key, live.get(fieldId))),
  );
  // A key whose column went away (deleted or retyped) is offered again once a column fits.
  const dropped = new Set(Object.keys(config.mapping || {}).filter((key) => !(key in kept)));
  const seenBefore = config.mappingSeen ? config.mappingSeen.filter((key) => !dropped.has(key)) : config.mappingSeen;
  const { mapping, mappingSeen } = offerNewMappings(fields, kept, seenBefore);
  const marker = fields.find((field) => field.id === mapping.createdStamp);
  const choices = (marker?.options?.choices || []).map((choice) => choice.name);
  const stampValue = !marker ? null : choices.includes(config.stampValue) ? config.stampValue : suggestStampValue(marker);
  // A setup that never had linked tables chosen gets them matched by name;
  // one that did keeps its choices, minus anything that no longer fits.
  const chosen = config.linkedChosen
    ? pruneLinked(tables, config.tableId, config.linked || {})
    : suggestLinked(tables, config.tableId, config.linked || {});
  const { linked, linkedSeen } = offerNewPeopleLinks(tables, config.tableId, chosen, config.linkedSeen);
  return writeConfig({
    fields, mapping, mappingSeen, stampValue, linked, linkedSeen, linkedChosen: true, baseTables: summarizeTables(tables), tableName: table.name, schemaAt: Date.now(),
  });
}

// ─── Row state ───────────────────────────────────────────────────────────────

let state = null;

function tableKey(config) {
  return `${config.baseId}:${config.tableId}`;
}

function bucketOf(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % BUCKETS;
}

function bucketKey(table, bucket) {
  return `${ROWS_PREFIX}:${table}:${bucket}`;
}

async function loadState(config) {
  const table = tableKey(config);
  if (state?.table === table) return state;
  const keys = Array.from({ length: BUCKETS }, (_, bucket) => bucketKey(table, bucket));
  const metaKey = `${ROWS_PREFIX}:${table}:meta`;
  const stored = await chrome.storage.local.get([...keys, metaKey]);
  const rows = new Map();
  for (const key of keys) {
    for (const [person, row] of Object.entries(stored[key] || {})) rows.set(person, row);
  }
  state = { table, rows, indexedAt: Number(stored[metaKey]?.indexedAt) || 0, dirty: new Set() };
  return state;
}

function setRow(person, row) {
  // The member id outlives every rewrite of the row's fingerprints.
  const previous = state.rows.get(person);
  if (!row.m && previous?.m && previous.r === row.r) row = { ...row, m: previous.m };
  state.rows.set(person, row);
  state.dirty.add(bucketOf(person));
  if (row.m && row.r) memberIndex().set(row.m, person);
}

async function persist() {
  if (!state || state.dirty.size === 0) return;
  const buckets = Array.from({ length: BUCKETS }, () => ({}));
  for (const [person, row] of state.rows) buckets[bucketOf(person)][person] = row;
  const writes = { [`${ROWS_PREFIX}:${state.table}:meta`]: { indexedAt: state.indexedAt } };
  for (const bucket of state.dirty) writes[bucketKey(state.table, bucket)] = buckets[bucket];
  state.dirty.clear();
  await chrome.storage.local.set(writes);
}

/** Rows the extension knows a LinkedIn member id for: member id → person key. */
function memberIndex() {
  if (!state.byMember) {
    state.byMember = new Map();
    for (const [person, row] of state.rows) if (row.m && row.r) state.byMember.set(row.m, person);
  }
  return state.byMember;
}

/**
 * People about to be created may have been added since the index was read,
 * by a teammate's extension or by hand. Ask Airtable for their LinkedIn URLs
 * (a loose FIND, confirmed here by slug) and adopt any row it finds.
 */
async function adoptAddedRows(config, keys, writeStartedAt) {
  // Only an index read during this very write already knows the whole table.
  if (!keys.length || state.indexedAt >= writeStartedAt) return 0;
  const keyField = config.mapping.linkedinUrl;
  const quote = (text) => `"${text.replace(/["\\]/g, "\\$&")}"`;
  let adopted = 0;
  for (const group of chunk(keys, RECORDS_PER_REQUEST)) {
    const needles = [...new Set(group.flatMap((key) => [key, encodeURIComponent(key).toLowerCase()]))];
    // By field id: a column renamed since the schema was read still resolves.
    const formula = `OR(${needles.map((needle) => `FIND(${quote(`/in/${needle}`)}, LOWER({${keyField}}))`).join(",")})`;
    let records;
    try {
      records = await listRecords(config.token, config.baseId, config.tableId, { fieldIds: [keyField], formula });
    } catch (error) {
      const refused = error instanceof AirtableError && error.status >= 400 && error.status < 500
        && ![401, 403, 429].includes(error.status);
      if (!refused) throw error;
      // Airtable wouldn't run the lookup: read the whole table instead.
      LOG("People lookup refused; reading the whole table instead:", error.message);
      await rebuildIndex(config);
      return keys.filter((key) => state.rows.get(key)?.r).length;
    }
    const wanted = new Set(group);
    for (const record of records) {
      const person = linkedinKey(record.fields?.[keyField]);
      if (!person || !wanted.has(person) || state.rows.get(person)?.r) continue;
      setRow(person, { r: record.id, h: {} });
      adopted++;
    }
  }
  if (adopted) {
    state.byMember = null;
    LOG(`${adopted} people were already in ${config.tableName || "the table"}; updating them instead of adding`);
  }
  return adopted;
}

/** Match every row in the table to a person by its LinkedIn URL. */
async function rebuildIndex(config) {
  const keyField = config.mapping.linkedinUrl;
  const records = await listRecords(config.token, config.baseId, config.tableId, { fieldIds: [keyField] });
  const seen = new Map();
  for (const record of records) {
    const person = linkedinKey(record.fields?.[keyField]);
    if (person && !seen.has(person)) seen.set(person, record.id);
  }
  for (const [person, recordId] of seen) {
    const row = state.rows.get(person);
    // A different record than the one written to means the fingerprints
    // describe some other row; send everything again.
    if (row?.r !== recordId) setRow(person, { r: recordId, h: {}, ...(row?.m ? { m: row.m } : {}) });
  }
  for (const person of [...state.rows.keys()]) {
    if (!seen.has(person)) {
      state.rows.delete(person);
      state.dirty.add(bucketOf(person));
    }
  }
  state.indexedAt = Date.now();
  state.byMember = null;
  state.dirty.add(0);
  await persist();
  LOG(`Indexed ${seen.size} people in ${config.tableName || config.tableId}`);
}

/**
 * Bring schema and index up to date. `force` rebuilds the index regardless of
 * age — a full sync does, so it starts from what the table holds right now.
 */
export async function prepareTable({ force = false } = {}) {
  return queue(async () => {
    let config = await requireConfig();
    if (force || Date.now() - Number(config.schemaAt || 0) > SCHEMA_MAX_AGE_MS) {
      config = await refreshSchema(config);
      const problem = configProblem(config);
      if (problem) throw new AirtableError(problem, { status: 401 });
    }
    await loadState(config);
    if (force || Date.now() - state.indexedAt > INDEX_MAX_AGE_MS) await rebuildIndex(config);
    await prepareLinked(config, { force });
    return config;
  });
}

// ─── Writes ──────────────────────────────────────────────────────────────────

// One write at a time. Airtable's rate limit is per base, so concurrency buys
// nothing, and serial planning is what stops two captures that meet the same
// new person from both creating a row for them.
let writeQueue = Promise.resolve();

function queue(operation) {
  const task = writeQueue.then(operation, operation);
  writeQueue = task.catch(() => {});
  return task;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Later sightings of a person fill in what earlier ones in the batch lacked. */
function mergePeople(people) {
  const byKey = new Map();
  for (const person of people) {
    const key = linkedinKey(person.linkedinUrl);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, person);
      continue;
    }
    const merged = { ...previous };
    for (const [field, value] of Object.entries(person)) {
      const empty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
      if (!empty) merged[field] = value;
    }
    byKey.set(key, merged);
  }
  return byKey;
}

function recoverable(error) {
  return error instanceof AirtableError && (error.status === 404 || error.status === 422);
}

/**
 * Select values a strict create held back, sent to the rows just created. If
 * that fails, their fingerprints are forgotten so the next sync sends them again.
 */
async function sendHeldBack(config, followUps) {
  if (!followUps.length) return;
  try {
    await updateRecords(config.token, config.baseId, config.tableId, followUps.map(({ id, fields }) => ({ id, fields })));
    await rememberChoices(config, followUps.map(({ fields }) => fields));
  } catch (error) {
    LOG("Couldn't add select values after create:", error?.message || error);
    for (const { item, id, fields } of followUps) {
      const hashes = { ...item.hashes };
      for (const [key, fieldId] of Object.entries(config.mapping || {})) if (fieldId in fields) delete hashes[key];
      setRow(item.key, { r: id, h: hashes, ...(item.memberId ? { m: item.memberId } : {}) });
    }
    await persist();
  }
}

/** Choices a typecast follow-up just added, so later rows send them straight away. */
async function rememberChoices(config, fieldSets) {
  let added = false;
  const fields = (config.fields || []).map((field) => {
    if (!["singleSelect", "multipleSelects"].includes(field.type)) return field;
    const names = new Set((field.options?.choices || []).map((choice) => choice.name));
    const fresh = [...new Set(fieldSets.flatMap((set) => (field.id in set ? [].concat(set[field.id]) : [])))]
      .filter((name) => typeof name === "string" && !names.has(name));
    if (!fresh.length) return field;
    added = true;
    return { ...field, options: { ...field.options, choices: [...(field.options?.choices || []), ...fresh.map((name) => ({ name }))] } };
  });
  if (!added) return;
  config.fields = fields;
  await writeConfig({ fields });
}

/** Airtable refused a select value this schema says exists: the choice was deleted or renamed. */
function staleChoice(error) {
  return error instanceof AirtableError && error.status === 422 && error.type === "INVALID_MULTIPLE_CHOICE_OPTIONS";
}

// Columns Airtable said this token may not write (403 naming the column), per
// table, for as long as the worker lives: left out of every write after that.
const lockedFields = new Map();

function lockedFor(config) {
  const key = tableKey(config);
  if (!lockedFields.has(key)) lockedFields.set(key, new Set());
  return lockedFields.get(key);
}

/** A 403 about one column: lock it, drop it from the group, and say whether to retry. */
function lockColumn(config, error, group) {
  const named = error instanceof AirtableError && error.status === 403 ? lockedFieldOf(error.message) : null;
  if (!named) return false;
  const field = (config.fields || []).find((candidate) => candidate.id === named || candidate.name === named);
  // The LinkedIn URL is how a row is found again: without it, fail the row instead.
  if (!field || lockedFor(config).has(field.id) || field.id === config.mapping?.linkedinUrl) return false;
  lockedFor(config).add(field.id);
  LOG(`Airtable won't let this token write "${field.name}"; leaving it out`);
  const key = Object.entries(config.mapping || {}).find(([, fieldId]) => fieldId === field.id)?.[0];
  for (const item of group) {
    delete item.fields[field.id];
    if (key) delete item.hashes[key];
  }
  return true;
}

function withoutLocked(config, fields) {
  const locked = lockedFor(config);
  return locked.size ? Object.fromEntries(Object.entries(fields).filter(([fieldId]) => !locked.has(fieldId))) : fields;
}

/**
 * Every write goes with typecast off: a record id is then only ever a link,
 * never a name Airtable might make a new linked record from. Select values
 * that aren't choices yet are held back and sent after in a typecast update,
 * which adds the choice.
 */
function splitChoices(config, item) {
  const fields = withoutLocked(config, item.fields);
  if (item.choicesStale) {
    // Airtable said a choice this schema lists is gone: every select waits for
    // the typecast follow-up, and the marker (an exact existing choice) is left out.
    const byId = fieldsById(config);
    const select = (fieldId) => ["singleSelect", "multipleSelects"].includes(byId.get(fieldId)?.type);
    const stamp = config.mapping?.createdStamp;
    const now = Object.fromEntries(Object.entries(fields).filter(([fieldId]) => !select(fieldId)));
    const later = Object.fromEntries(Object.entries(fields).filter(([fieldId]) => select(fieldId) && fieldId !== stamp));
    return { now, later: Object.keys(later).length ? later : null };
  }
  const now = onlyExistingChoices(config, fields);
  const later = Object.fromEntries(Object.entries(fields).filter(([fieldId]) => !(fieldId in now)));
  return { now, later: Object.keys(later).length ? later : null };
}

/** Airtable landed the row but not its photo: forget the photo so the next sync sends it again. */
function forgetFailedPhotos(config, result, group) {
  const photo = photoField(config);
  if (!photo || !attachmentsFailed(result)) return;
  for (const item of group) {
    if (!(photo in item.fields)) continue;
    if (item.previous?.photo) item.hashes.photo = item.previous.photo;
    else delete item.hashes.photo;
  }
  LOG("Airtable couldn't attach some photos; they're sent again next sync");
}

async function sendCreates(config, items, tally, attempt = 0) {
  for (const group of chunk(items, RECORDS_PER_REQUEST)) {
    const heldBack = new Map();
    try {
      const records = group.map((item) => {
        const { now, later } = splitChoices(config, item);
        if (later) heldBack.set(item, later);
        return { fields: now };
      });
      const created = await createRecords(config.token, config.baseId, config.tableId, records, { typecast: false });
      forgetFailedPhotos(config, created, group);
      group.forEach((item, index) => {
        const record = created[index];
        if (record?.id) setRow(item.key, { r: record.id, h: item.hashes, ...(item.memberId ? { m: item.memberId } : {}) });
      });
      tally.created += group.length;
      await persist();
      await sendHeldBack(config, group
        .map((item, index) => ({ item, id: created[index]?.id, fields: heldBack.get(item) }))
        .filter((entry) => entry.id && entry.fields));
    } catch (error) {
      if (isCollaboratorError(error, config, group)) {
        // Finish the write without Known by; don't try it again.
        await blockKnownBy(config);
        await sendCreates(config, withoutKnownBy(config, group), tally, attempt);
        continue;
      }
      if (lockColumn(config, error, group)) {
        await sendCreates(config, group, tally, attempt);
        continue;
      }
      if (staleChoice(error) && !group.some((item) => item.choicesStale)) {
        await sendCreates(config, group.map((item) => Object.assign(item, { choicesStale: true })), tally, attempt);
        continue;
      }
      if (error.ambiguous && attempt === 0) {
        // The rows may have landed. Look before sending them again.
        LOG("Create outcome unknown; re-reading the table before retrying");
        await rebuildIndex(config);
        const missing = [];
        const followUps = [];
        for (const item of group) {
          const landed = state.rows.get(item.key)?.r;
          if (landed) {
            setRow(item.key, { r: landed, h: item.hashes, ...(item.memberId ? { m: item.memberId } : {}) });
            tally.created++;
            if (heldBack.has(item)) followUps.push({ item, id: landed, fields: heldBack.get(item) });
          } else {
            missing.push(item);
          }
        }
        await sendHeldBack(config, followUps);
        await sendCreates(config, missing, tally, 1);
        continue;
      }
      if (!recoverable(error)) throw error;
      if (group.length > 1) {
        // One bad value fails the whole request; find it by sending singly.
        for (const item of group) await sendCreates(config, [item], tally, attempt);
        continue;
      }
      tally.failed++;
      tally.errors.push(error.message);
    }
  }
  return tally;
}

async function sendUpdates(config, items, tally, byId) {
  for (const group of chunk(items, RECORDS_PER_REQUEST)) {
    try {
      const split = group.map((item) => ({ item, ...splitChoices(config, item) }));
      const sendable = split.filter(({ now }) => Object.keys(now).length);
      const updated = sendable.length
        ? await updateRecords(config.token, config.baseId, config.tableId, sendable.map(({ item, now }) => ({ id: item.id, fields: now })), { typecast: false })
        : [];
      forgetFailedPhotos(config, updated, group);
      for (const item of group) setRow(item.key, { r: item.id, h: item.hashes });
      tally.updated += group.length;
      await sendHeldBack(config, split.filter(({ later }) => later).map(({ item, later }) => ({ item, id: item.id, fields: later })));
    } catch (error) {
      if (lockColumn(config, error, group)) {
        await sendUpdates(config, group.filter((item) => Object.keys(item.fields).length), tally, byId);
        for (const item of group) if (!Object.keys(item.fields).length) setRow(item.key, { r: item.id, h: item.hashes });
        continue;
      }
      if (staleChoice(error) && !group.some((item) => item.choicesStale)) {
        await sendUpdates(config, group.map((item) => Object.assign(item, { choicesStale: true })), tally, byId);
        continue;
      }
      if (isCollaboratorError(error, config, group)) {
        await blockKnownBy(config);
        const rest = withoutKnownBy(config, group).filter((item) => Object.keys(item.fields).length);
        for (const item of group) if (!Object.keys(item.fields).length) setRow(item.key, { r: item.id, h: item.hashes });
        await sendUpdates(config, rest, tally, byId);
        continue;
      }
      if (!recoverable(error)) throw error;
      if (group.length > 1) {
        for (const item of group) await sendUpdates(config, [item], tally, byId);
        continue;
      }
      const [item] = group;
      // Recreate only a row that's really gone; anything else is a value
      // Airtable refused, and a second copy of the person is never the fix.
      const stillThere = (await getRecordsByIds(config.token, config.baseId, config.tableId, [item.id],
        { fieldIds: [config.mapping.linkedinUrl] })).length > 0;
      if (stillThere) {
        // Most often a link to a company or school deleted since the index was
        // read: send the rest now, and the links next time from a fresh index.
        markLinkedStale();
        const linkIds = new Set((item.links || []).map((link) => link.fieldId));
        const kept = Object.fromEntries(Object.entries(item.fields).filter(([fieldId]) => !linkIds.has(fieldId)));
        if (!item.retried && linkIds.size && Object.keys(kept).length < Object.keys(item.fields).length) {
          const hashes = { ...item.hashes };
          for (const link of item.links) hashes[`link:${link.key}`] = item.previous?.[`link:${link.key}`];
          if (Object.keys(kept).length) await sendUpdates(config, [{ ...item, fields: kept, hashes, links: [], retried: true }], tally, byId);
          else setRow(item.key, { r: item.id, h: hashes });
          continue;
        }
        tally.failed++;
        tally.errors.push(error.message);
        continue;
      }
      // Deleted in Airtable since the index was built: recreate the row, the
      // same way any new person is created.
      const plan = planCells(item.person, config.mapping, byId, null);
      await dropBrokenImages([plan], [photoField(config)], () => delete plan.hashes.photo);
      const memberId = state.rows.get(item.key)?.m || item.person.memberId || null;
      state.rows.delete(item.key);
      await sendCreates(config, [{ key: item.key, fields: plan.fields, hashes: plan.hashes, person: item.person, memberId }], tally);
    }
  }
  return tally;
}

// On an existing person, every column the extension doesn't own fills blanks
// only (or replaces what the extension itself wrote there). Owned: Headline and
// the sync timestamp; create-only and match-key columns are never updated.
const FILL_KEYS = new Set(SOURCE_FIELDS
  .filter((source) => source.fill || (!source.owned && !source.createOnly && !source.required && !source.union))
  .map((source) => source.key));
// Union: only ever adds to what the cell holds (Known by).
const UNION_KEYS = new Set(SOURCE_FIELDS.filter((source) => source.union).map((source) => source.key));
// Blank-only: never replaces anything, not even what the extension wrote itself.
const BLANK_ONLY_KEYS = new Set(SOURCE_FIELDS.filter((source) => source.fill === "blank").map((source) => source.key));

/**
 * Who "Known by" gets: the Airtable user the token belongs to, or the email
 * set as an override for a shared token. Nothing once Airtable has said this
 * account can't be set there.
 */
export function syncUserFor(config) {
  if (config.knownByBlocked) return null;
  if (config.syncAsEmail) return { email: config.syncAsEmail };
  return config.userId ? { id: config.userId } : null;
}

function sameUser(left, right) {
  if (left?.id && right?.id) return left.id === right.id;
  const email = (user) => String(user?.email || "").toLowerCase();
  return Boolean(email(left)) && email(left) === email(right);
}

/**
 * Airtable refusing the Known by value. Its real answer is a generic 422
 * ("Cannot parse value … for field Known by"), so the column is recognised by
 * name or id, in a request that actually carried it.
 */
function isCollaboratorError(error, config, group = []) {
  const fieldId = config.mapping?.knownBy;
  if (!fieldId || !(error instanceof AirtableError) || error.status !== 422) return false;
  if (!group.some((item) => fieldId in (item.fields || {}))) return false;
  const text = `${error.type || ""} ${error.message || ""}`;
  const name = fieldsById(config).get(fieldId)?.name;
  return /collaborator/i.test(text) || text.includes(fieldId) || Boolean(name && new RegExp(`field "?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\s*$`, "i").test(error.message || ""));
}

/** Airtable won't take this user in Known by: stop sending it and say so once. */
async function blockKnownBy(config) {
  if (config.knownByBlocked) return;
  config.knownByBlocked = true;
  await writeConfig({
    knownByBlocked: true,
    notice: `Your Airtable account isn't a collaborator on ${config.baseName || "this base"}, so Known by can't be set. Ask the base owner to invite you.`,
  });
  LOG("Known by rejected: not a collaborator; skipping it from now on");
}

function withoutKnownBy(config, items) {
  const fieldId = config.mapping?.knownBy;
  for (const item of items) {
    if (!fieldId) continue;
    delete item.fields[fieldId];
    // Not written, so not remembered as written.
    if (item.previous?.knownBy) item.hashes.knownBy = item.previous.knownBy;
    else delete item.hashes.knownBy;
  }
  return items;
}

/**
 * The new-row marker, when it's usable: a mapped single select whose chosen
 * value is one of its existing choices (it goes out with typecast off).
 */
export function stampFor(config) {
  const field = fieldsById(config).get(config.mapping?.createdStamp);
  const value = config.stampValue;
  if (field?.type !== "singleSelect" || !value) return null;
  return (field.options?.choices || []).some((choice) => choice.name === value) ? { fieldId: field.id, value } : null;
}

/**
 * With typecast off, a select value Airtable doesn't already have fails the
 * whole request. Keep only existing choices; the marker is checked up front.
 */
function onlyExistingChoices(config, fields) {
  const byId = fieldsById(config);
  const out = {};
  for (const [fieldId, value] of Object.entries(fields)) {
    const field = byId.get(fieldId);
    const choices = new Set((field?.options?.choices || []).map((choice) => choice.name));
    if (field?.type === "singleSelect") {
      if (choices.has(value)) out[fieldId] = value;
    } else if (field?.type === "multipleSelects") {
      // All or nothing: a partial list sent now would be recorded as the whole.
      const all = Array.isArray(value) ? value : [];
      if (all.every((name) => choices.has(name))) out[fieldId] = all;
    } else {
      out[fieldId] = value;
    }
  }
  return out;
}

/** The People Photo column, when it's an attachment column. */
function photoField(config) {
  const fieldId = config.mapping?.photo;
  return fieldsById(config).get(fieldId)?.type === "multipleAttachments" ? fieldId : null;
}

function blankCell(value) {
  return value === null || value === undefined || value === ""
    || (Array.isArray(value) && value.length === 0);
}

/** People link columns and the record ids each person's row should include. */
function linkColumns(config, links) {
  const ready = linkedReady(config.linked);
  const peopleLinks = config.linked?.peopleLinks || {};
  return [
    ready.workedAt && { key: "workedAt", mode: "union", fieldId: peopleLinks.workedAt, ids: links?.workedAt || [] },
    ready.currentCompany && { key: "currentCompany", mode: "fill", fieldId: peopleLinks.currentCompany, ids: links?.currentCompany || [] },
    ready.schoolsLink && { key: "schools", mode: "union", fieldId: peopleLinks.schools, ids: links?.schools || [] },
  ].filter((column) => column && column.ids.length);
}

const linkHash = (ids) => fingerprint([...ids].sort());

/**
 * Settle an update against what the row holds now. A fill column is written
 * only while blank, or while it still holds exactly what the extension last
 * put there; anything a person typed stays. Link columns add to what's there
 * and never drop a link.
 */
async function reconcileUpdates(config, items) {
  const fillIds = [...FILL_KEYS].map((key) => config.mapping[key]).filter(Boolean);
  const unionIds = [...UNION_KEYS].map((key) => config.mapping[key]).filter(Boolean);
  const needs = items.filter((item) => item.links.length || [...fillIds, ...unionIds].some((fieldId) => fieldId in item.fields));
  const readIds = [...new Set([...fillIds, ...unionIds, ...items.flatMap((item) => item.links.map((link) => link.fieldId))])];
  const current = new Map();
  for (const group of chunk(needs, RECORDS_PER_REQUEST)) {
    const records = await getRecordsByIds(config.token, config.baseId, config.tableId, group.map((item) => item.id), { fieldIds: readIds });
    for (const record of records) current.set(record.id, record.fields || {});
  }
  for (const item of needs) {
    const now = current.get(item.id);
    if (!now) continue; // Gone: sendUpdates recreates it.
    for (const key of FILL_KEYS) {
      const fieldId = config.mapping[key];
      if (!fieldId || !(fieldId in item.fields)) continue;
      const held = now[fieldId];
      if (blankCell(held)) continue;
      if (BLANK_ONLY_KEYS.has(key) || fingerprint([fieldId, held]) !== item.previous[key]) delete item.fields[fieldId];
    }
    for (const key of UNION_KEYS) {
      const fieldId = config.mapping[key];
      if (!fieldId || !(fieldId in item.fields)) continue;
      // Add, never replace: keep everyone already there, in Airtable's order.
      const existing = Array.isArray(now[fieldId]) ? now[fieldId] : [];
      const additions = item.fields[fieldId].filter((user) => !existing.some((held) => sameUser(held, user)));
      if (additions.length === 0) delete item.fields[fieldId];
      else item.fields[fieldId] = [...existing.map((held) => (held.id ? { id: held.id } : { email: held.email })), ...additions];
    }
    for (const link of item.links) {
      const existing = Array.isArray(now[link.fieldId]) ? now[link.fieldId] : [];
      if (link.mode === "fill") {
        // Blank, or still exactly what the extension put there: replace. Anything else was set by hand.
        const ours = !existing.length || linkHash(existing) === item.previous[`link:${link.key}`];
        if (ours && linkHash(existing) !== linkHash(link.ids)) item.fields[link.fieldId] = link.ids;
        continue;
      }
      const union = [...new Set([...existing, ...link.ids])];
      if (union.length > existing.length) item.fields[link.fieldId] = union;
    }
  }
  return items;
}

/**
 * Upsert captured people. `rows` are whatever a capture produced — connection
 * rows, enriched profiles, company people, mutual-finder results.
 *
 * With linked tables set up, a full profile also writes its companies and
 * schools (found or created, blanks filled), links them onto the person, and
 * writes one Work history row per job — in that order, so every link points
 * at a row that exists.
 *
 * Returns counts in the shape the import protocol reports: every row is
 * accepted (created, updated, or unchanged) or failed. A row with no LinkedIn
 * URL fails, since there is nothing to match it on.
 */
export function writePeople(rows, { source = null, degree = null } = {}) {
  return queue(async () => {
    const writeStartedAt = Date.now();
    let config = await requireConfig();
    if (Date.now() - Number(config.schemaAt || 0) > SCHEMA_MAX_AGE_MS) config = await refreshSchema(config);
    const problem = configProblem(config);
    if (problem) throw new AirtableError(problem, { status: 401 });
    await loadState(config);
    // A write that never finished (worker killed, extension reloaded) may have
    // created rows the extension never recorded: re-read every table first.
    const interrupted = Boolean((await chrome.storage.local.get(WRITE_OPEN_KEY))[WRITE_OPEN_KEY]);
    if (interrupted) LOG("The last write didn't finish; re-reading tables before writing");
    if (interrupted || Date.now() - state.indexedAt > INDEX_MAX_AGE_MS) await rebuildIndex(config);
    const ready = linkedReady(config.linked);
    const linkedOn = ready.companies || ready.schools;
    if (linkedOn) await prepareLinked(config, { force: interrupted });
    await chrome.storage.local.set({ [WRITE_OPEN_KEY]: Date.now() });

    const byId = fieldsById(config);
    const tally = {
      rowCount: rows.length, created: 0, updated: 0, unchanged: 0, failed: 0, errors: [],
      linked: emptyLinkedTally(), linkedFailed: 0,
    };
    const now = new Date();
    const stamp = stampFor(config);
    const people = [];
    for (const row of rows) {
      const person = extractPerson(row, { source, degree, now });
      if (!person) {
        tally.failed++;
        continue;
      }
      // Only ever reaches a create: the marker is create-only.
      person.createdStamp = stamp?.value || "";
      const syncUser = syncUserFor(config);
      if (syncUser) person.knownBy = [syncUser];
      if (linkedOn) {
        const linked = extractLinked(row);
        if (linked.companies.size || linked.schools.size) person.linked = linked;
      }
      // LinkedIn's member id outlives a changed profile URL.
      const memberId = typeof row?.memberId === "string" && row.memberId ? row.memberId : null;
      if (memberId) person.memberId = memberId;
      people.push(person);
    }
    const merged = mergePeople(people);
    // Duplicates inside the batch still count once each toward accepted.
    const duplicates = people.length - merged.size;
    const adopted = await adoptAddedRows(config, [...merged.keys()].filter((key) => !state.rows.get(key)?.r), writeStartedAt);
    // Someone else's rows for these people may come with their jobs, companies
    // and schools already written: read those tables again before adding any.
    if (adopted && linkedOn) await prepareLinked(config, { force: true });

    // An error whose outcome is unknown leaves the marker set, so the retry
    // re-reads every table before creating anything.
    let unsure = false;
    try {
      // Companies and schools first, so the person can link to them.
      const { perPerson, companyIds } = linkedOn
        ? await resolvePeopleLinks(config, merged, tally)
        : { perPerson: new Map(), companyIds: new Map() };

      const creates = [];
      const updates = [];
      for (const [key, person] of merged) {
        // Same person under a new profile URL: their row, not a new one.
        if (!state.rows.get(key)?.r && person.memberId) {
          const previousKey = memberIndex().get(person.memberId);
          const moved = previousKey && state.rows.get(previousKey);
          if (moved?.r) setRow(key, { ...moved });
        }
        const existing = state.rows.get(key);
        const previous = existing ? existing.h || {} : null;
        const plan = planCells(person, config.mapping, byId, previous);
        const links = linkColumns(config, perPerson.get(key))
          .filter((link) => !previous || previous[`link:${link.key}`] !== linkHash(link.ids));
        for (const link of links) plan.hashes[`link:${link.key}`] = linkHash(link.ids);
        if (!plan.changed && links.length === 0) {
          tally.unchanged++;
          continue;
        }
        if (existing?.r) {
          updates.push({ key, id: existing.r, fields: plan.fields, hashes: plan.hashes, person, previous, links });
        } else {
          for (const link of links) plan.fields[link.fieldId] = link.ids;
          creates.push({ key, fields: plan.fields, hashes: plan.hashes, person, memberId: person.memberId || null });
        }
      }

      // A photo that won't download is left out, and tried again next sync.
      const photo = photoField(config);
      await dropBrokenImages(creates, [photo], (item) => delete item.hashes.photo);
      await sendCreates(config, creates, tally);
      await reconcileUpdates(config, updates);
      await dropBrokenImages(updates, [photo], (item) => {
        if (item.previous?.photo) item.hashes.photo = item.previous.photo;
        else delete item.hashes.photo;
      });
      const unhashed = new Set(SOURCE_FIELDS.filter((source) => source.hash === false)
        .map((source) => config.mapping[source.key]).filter(Boolean));
      const quiet = updates.filter((item) => Object.keys(item.fields).every((fieldId) => unhashed.has(fieldId)));
      for (const item of quiet) setRow(item.key, { r: item.id, h: item.hashes });
      tally.unchanged += quiet.length;
      await sendUpdates(config, updates.filter((item) => !quiet.includes(item)), tally, byId);

      // Jobs last: each Work history row links a person and a company that now exist.
      if (ready.workHistory) {
        const jobs = [];
        for (const [key, person] of merged) {
          if (person.linked?.roles.length) jobs.push({ personId: state.rows.get(key)?.r, roles: person.linked.roles });
        }
        await syncWorkHistory(config, jobs, companyIds, tally);
      }
    } catch (error) {
      if (error?.ambiguous) unsure = true;
      throw error;
    } finally {
      await persist();
      await persistLinked().catch(() => {});
      // Everything that landed is recorded; the next write needn't re-read.
      if (!unsure) await chrome.storage.local.remove(WRITE_OPEN_KEY);
    }
    tally.unchanged += duplicates;
    tally.accepted = tally.created + tally.updated + tally.unchanged;
    if (tally.errors.length) LOG(`${tally.errors.length} row(s) rejected:`, tally.errors[0]);
    await chrome.storage.local.set({
      [LAST_WRITE_KEY]: {
        at: Date.now(),
        source,
        created: tally.created,
        updated: tally.updated,
        unchanged: tally.unchanged,
        failed: tally.failed,
        linked: tally.linked,
        error: tally.errors[0] || null,
      },
    }).catch(() => {});
    return tally;
  });
}

/** Which rows already have a record in the table (soft sync skips enriching them). */
export async function knownPeople(rows) {
  await prepareTable();
  return rows.map((row) => {
    const key = linkedinKey(canonicalLinkedinUrl(row?.linkedinUrl) || "");
    return Boolean(key && state.rows.get(key)?.r);
  });
}

/** How many people the extension has matched to rows in the current table. */
export async function indexedPeopleCount() {
  const config = await readConfig();
  if (configProblem(config)) return 0;
  await loadState(config);
  return state.rows.size;
}

/** Forget fingerprints so the next sync rewrites every mapped cell. */
export function resetTableState() {
  return queue(async () => {
    const config = await readConfig();
    if (!config.baseId || !config.tableId) return;
    const table = tableKey(config);
    const keys = Array.from({ length: BUCKETS }, (_, bucket) => bucketKey(table, bucket));
    await chrome.storage.local.remove([...keys, `${ROWS_PREFIX}:${table}:meta`]);
    state = null;
    await resetLinkedState(config);
  });
}

/** Drop the in-memory row state; the next write reloads it for the configured table. */
export function forgetTableState() {
  state = null;
  forgetLinkedState();
}
