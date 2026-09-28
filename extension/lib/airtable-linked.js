/**
 * Linked tables: Companies, Work history (one row per job), and Schools, plus
 * the People link columns that point at them. Pure, so matching and
 * extraction are unit testable.
 *
 *   LINKED_TABLES     what each table holds and how its columns are recognised
 *   suggestLinked     base schema → which table and column plays each part
 *   extractLinked     captured profile → its companies, jobs, and schools
 *   linkedinPath      any LinkedIn company/school URL → one comparable key
 */

import { dateRange, isRetired, normalizeName, phraseScore } from "./airtable-fields.js";

const TEXT = ["singleLineText", "multilineText", "richText"];
const LONG = ["multilineText", "richText", "singleLineText"];
const URLISH = ["url", "singleLineText"];

/**
 * `fill` columns belong to whoever filled them first: on a row that already
 * exists they are written only while blank. `link` columns hold record ids of
 * another linked table (or "people").
 */
export const LINKED_TABLES = Object.freeze([
  {
    key: "companies",
    label: "Companies",
    names: ["companies", "company", "organizations", "organisations", "firms", "accounts"],
    fields: [
      { key: "name", label: "Name", types: ["singleLineText"], fill: true, required: true, names: ["name", "company name", "company"] },
      { key: "linkedinUrl", label: "LinkedIn", types: URLISH, fill: true, names: ["linkedin", "linkedin url", "linkedin page", "company linkedin"] },
      { key: "about", label: "About", types: LONG, fill: true, names: ["about", "description", "overview", "company description", "summary"] },
      { key: "logo", label: "Logo", types: ["multipleAttachments"], fill: true, names: ["logo", "company logo"] },
      { key: "website", label: "Website", types: URLISH, fill: true, names: ["website", "homepage", "site", "web", "domain"] },
      { key: "industry", label: "Industry", types: ["singleLineText", "singleSelect"], fill: true, names: ["industry", "sector", "vertical"] },
    ],
  },
  {
    key: "workHistory",
    label: "Work history",
    names: ["work history", "employment history", "experience", "positions", "jobs", "roles"],
    fields: [
      { key: "title", label: "Title", types: TEXT, required: true, names: ["title", "job title", "role title", "position"] },
      { key: "company", label: "Company", link: "companies", required: true, names: ["company", "employer", "organization"] },
      { key: "person", label: "Person", link: "people", required: true, names: ["person", "people", "contact", "employee"] },
      { key: "description", label: "Description", types: LONG, names: ["description", "role description", "job description", "details"] },
      { key: "location", label: "Location", types: TEXT, names: ["location", "city"] },
      { key: "timeframe", label: "Timeframe", types: TEXT, names: ["timeframe", "time frame", "tenure", "period", "dates"] },
      { key: "start", label: "Start", types: ["date", "dateTime"], names: ["start", "start date", "started", "from"] },
      { key: "end", label: "End", types: ["date", "dateTime"], names: ["end", "end date", "ended", "to"] },
      { key: "current", label: "Current", types: ["checkbox"], names: ["current", "is current", "current role", "active"] },
    ],
  },
  {
    key: "schools",
    label: "Schools",
    names: ["schools", "education", "universities", "school"],
    fields: [
      { key: "name", label: "Name", types: ["singleLineText"], fill: true, required: true, names: ["name", "school", "school name"] },
      { key: "linkedinUrl", label: "LinkedIn URL", types: URLISH, fill: true, names: ["linkedin url", "linkedin", "linkedin page"] },
      { key: "logo", label: "Logo", types: ["multipleAttachments"], fill: true, names: ["logo", "school logo"] },
    ],
  },
]);

export const LINKED_TABLE_BY_KEY = new Map(LINKED_TABLES.map((table) => [table.key, table]));

/**
 * People columns that link out. Work history reaches the person from its own
 * Person column (Airtable fills the reverse link), so it isn't listed here.
 */
/**
 * `union` links only ever gain records. `fill` links hold one current fact:
 * written into a blank cell, or over what the extension itself wrote last,
 * but never over something set by hand, and never cleared.
 */
export const PEOPLE_LINKS = Object.freeze([
  { key: "workedAt", label: "Companies worked at", target: "companies", mode: "union", names: ["worked at", "companies worked at", "employers", "companies"] },
  { key: "currentCompany", label: "Current company", target: "companies", mode: "fill", names: ["current company", "current employer", "works at"] },
  { key: "schools", label: "Schools attended", target: "schools", mode: "union", names: ["education", "schools", "schools attended", "attended"] },
]);

function linksTo(field, tableId) {
  return field?.type === "multipleRecordLinks" && Boolean(tableId) && field.options?.linkedTableId === tableId;
}

/** Can `field` play `role` (a LINKED_TABLES field), given the chosen table ids? */
export function canPlay(role, field, tableIds) {
  if (!field || isRetired(field)) return false;
  if (role.link) return linksTo(field, tableIds[role.link]);
  return role.types.includes(field.type);
}

function greedy(pairs, taken = new Set(), done = new Set()) {
  const chosen = {};
  pairs.sort((left, right) => right.score - left.score);
  for (const { key, id } of pairs) {
    if (done.has(key) || taken.has(id)) continue;
    chosen[key] = id;
    done.add(key);
    taken.add(id);
  }
  return chosen;
}

/** Map one table's columns onto its roles by name. Existing choices that still fit stay. */
function suggestColumns(def, table, tableIds, existing = {}) {
  const byId = new Map(table.fields.map((field) => [field.id, field]));
  const kept = {};
  const taken = new Set();
  for (const role of def.fields) {
    const fieldId = existing[role.key];
    if (fieldId && !taken.has(fieldId) && canPlay(role, byId.get(fieldId), tableIds)) {
      kept[role.key] = fieldId;
      taken.add(fieldId);
    }
  }
  const pairs = [];
  for (const role of def.fields) {
    if (kept[role.key]) continue;
    for (const field of table.fields) {
      if (taken.has(field.id) || !canPlay(role, field, tableIds)) continue;
      const score = phraseScore(role.label, role.names, field.name);
      if (score > 0) pairs.push({ key: role.key, id: field.id, score });
    }
  }
  return { ...kept, ...greedy(pairs, taken, new Set(Object.keys(kept))) };
}

/**
 * Pick the table for each linked role by name (never the People table), then
 * its columns, then the People link columns. `existing` is the saved config;
 * whatever in it still fits is kept.
 */
export function suggestLinked(tables, peopleTableId, existing = {}) {
  const list = (Array.isArray(tables) ? tables : []).filter((table) => table.id !== peopleTableId);
  const byId = new Map(list.map((table) => [table.id, table]));
  const tableIds = { people: peopleTableId };
  const taken = new Set();
  for (const def of LINKED_TABLES) {
    const saved = existing[def.key]?.tableId;
    if (saved && byId.has(saved) && !taken.has(saved)) {
      tableIds[def.key] = saved;
      taken.add(saved);
    }
  }
  const pairs = [];
  for (const def of LINKED_TABLES) {
    if (tableIds[def.key]) continue;
    for (const table of list) {
      if (taken.has(table.id)) continue;
      const score = phraseScore(def.label, def.names, table.name);
      if (score > 0) pairs.push({ key: def.key, id: table.id, score });
    }
  }
  Object.assign(tableIds, greedy(pairs, taken, new Set(Object.keys(tableIds))));

  const linked = {};
  for (const def of LINKED_TABLES) {
    const table = byId.get(tableIds[def.key]);
    if (!table) continue;
    linked[def.key] = {
      tableId: table.id,
      tableName: table.name,
      fields: suggestColumns(def, table, tableIds, existing[def.key]?.fields),
      schema: table.fields.map(({ id, name, type, options }) => ({ id, name, type, options })),
    };
  }
  const people = (Array.isArray(tables) ? tables : []).find((table) => table.id === peopleTableId);
  linked.peopleLinks = {};
  if (people) {
    const kept = {};
    const used = new Set();
    for (const link of PEOPLE_LINKS) {
      const fieldId = existing.peopleLinks?.[link.key];
      const field = people.fields.find((candidate) => candidate.id === fieldId);
      if (field && !used.has(fieldId) && !isRetired(field) && linksTo(field, tableIds[link.target])) {
        kept[link.key] = fieldId;
        used.add(fieldId);
      }
    }
    const linkPairs = [];
    for (const link of PEOPLE_LINKS) {
      if (kept[link.key]) continue;
      for (const field of people.fields) {
        if (used.has(field.id) || isRetired(field) || !linksTo(field, tableIds[link.target])) continue;
        const score = phraseScore(link.label, link.names, field.name);
        if (score > 0) linkPairs.push({ key: link.key, id: field.id, score });
      }
    }
    linked.peopleLinks = { ...kept, ...greedy(linkPairs, used, new Set(Object.keys(kept))) };
  }
  return linked;
}

/** Which linked parts have everything they need to run. */
export function linkedReady(linked) {
  const complete = (key) => {
    const part = linked?.[key];
    const def = LINKED_TABLE_BY_KEY.get(key);
    return Boolean(part?.tableId) && def.fields.every((role) => !role.required || part.fields?.[role.key]);
  };
  const companies = complete("companies");
  const schools = complete("schools");
  return {
    companies,
    workHistory: companies && complete("workHistory"),
    schools,
    workedAt: companies && Boolean(linked?.peopleLinks?.workedAt),
    currentCompany: companies && Boolean(linked?.peopleLinks?.currentCompany),
    schoolsLink: schools && Boolean(linked?.peopleLinks?.schools),
  };
}

// ─── LinkedIn identities ─────────────────────────────────────────────────────

/**
 * "company/acme" or "school/1234" from any LinkedIn company or school URL:
 * lowercased, host, query, hash, trailing slash and sub-pages dropped.
 */
export function linkedinPath(value) {
  const match = String(value || "").match(/linkedin\.com\/(company|school|showcase)\/([^/?#\s]+)/i);
  if (!match) return null;
  let slug = match[2];
  try { slug = decodeURIComponent(slug); } catch {}
  return `${match[1].toLowerCase() === "showcase" ? "company" : match[1].toLowerCase()}/${slug.trim().toLowerCase()}`;
}

export function linkedinUrlFor(path) {
  return path ? `https://www.linkedin.com/${path}` : "";
}

function idFromUrn(urn, kind) {
  return String(urn || "").match(new RegExp(`${kind}:(\\d+)$`))?.[1] || null;
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** "2020-01" → "2020-01-01", "2020" → "2020-01-01"; anything else → "". */
export function monthStart(value) {
  const match = clean(value).match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!match) return "";
  return `${match[1]}-${String(match[2] || 1).padStart(2, "0")}-01`;
}

export function companyKey(entity) {
  return entity.companyId ? `id:${entity.companyId}` : `name:${normalizeName(entity.name)}`;
}

/** One job's identity: the same person, company, title, and start month. */
export function roleKey(personId, companyId, title, start) {
  return [personId, companyId, normalizeName(title), clean(start).slice(0, 7)].join("|");
}

function ongoing(entry) {
  return entry.isCurrent === true || (entry.isCurrent === undefined && !clean(entry.endDate));
}

/**
 * The companies, jobs, and schools on one captured profile. Rows without a
 * full profile (the connection list's base rows) have none, and cost nothing.
 */
export function extractLinked(row) {
  const companies = new Map();
  const roles = [];
  const schools = new Map();
  for (const entry of Array.isArray(row?.experience) ? row.experience : []) {
    const name = clean(entry?.company);
    const companyId = idFromUrn(entry?.companyUrn, "company");
    if (!name && !companyId) continue;
    const company = {
      name,
      companyId,
      logoUrl: clean(entry?.companyLogoUrl),
      linkedinPath: companyId ? `company/${companyId}` : null,
    };
    const key = companyKey(company);
    if (!companies.has(key)) companies.set(key, { key, ...company });
    else if (!companies.get(key).logoUrl && company.logoUrl) companies.get(key).logoUrl = company.logoUrl;
    const title = clean(entry?.title);
    if (!title) continue;
    const current = ongoing(entry);
    roles.push({
      companyKey: key,
      title,
      description: clean(entry?.description),
      location: clean(entry?.location),
      timeframe: dateRange({ ...entry, isCurrent: current }),
      start: monthStart(entry?.startDate),
      end: current ? "" : monthStart(entry?.endDate),
      current,
    });
  }
  for (const entry of Array.isArray(row?.education) ? row.education : []) {
    const name = clean(entry?.school);
    const schoolId = idFromUrn(entry?.schoolUrn, "school");
    if (!name && !schoolId) continue;
    const key = schoolId ? `id:${schoolId}` : `name:${normalizeName(name)}`;
    if (schools.has(key)) {
      if (!schools.get(key).logoUrl) schools.get(key).logoUrl = clean(entry?.schoolLogoUrl);
    } else {
      schools.set(key, {
        key,
        name,
        schoolId,
        logoUrl: clean(entry?.schoolLogoUrl),
        linkedinPath: schoolId ? `school/${schoolId}` : null,
      });
    }
  }
  // The same role the Title column reads: the first ongoing one.
  const currentCompanyKey = roles.find((role) => role.current)?.companyKey || null;
  return { companies, roles, schools, currentCompanyKey };
}

/**
 * The saved linked config checked against a fresh schema: tables and columns
 * that are gone, retyped, or now point elsewhere drop out. Adds nothing new.
 */
export function pruneLinked(tables, peopleTableId, linked = {}) {
  const byId = new Map((Array.isArray(tables) ? tables : []).map((table) => [table.id, table]));
  const tableIds = { people: peopleTableId };
  for (const def of LINKED_TABLES) {
    const tableId = linked?.[def.key]?.tableId;
    if (tableId && byId.has(tableId) && tableId !== peopleTableId) tableIds[def.key] = tableId;
  }
  const out = {};
  for (const def of LINKED_TABLES) {
    const table = byId.get(tableIds[def.key]);
    if (!table) continue;
    const fieldsById = new Map(table.fields.map((field) => [field.id, field]));
    const fields = {};
    for (const role of def.fields) {
      const fieldId = linked[def.key].fields?.[role.key];
      if (fieldId && canPlay(role, fieldsById.get(fieldId), tableIds)) fields[role.key] = fieldId;
    }
    out[def.key] = {
      tableId: table.id,
      tableName: table.name,
      fields,
      schema: table.fields.map(({ id, name, type, options }) => ({ id, name, type, options })),
    };
  }
  const people = byId.get(peopleTableId);
  out.peopleLinks = {};
  for (const link of PEOPLE_LINKS) {
    const fieldId = linked?.peopleLinks?.[link.key];
    const field = people?.fields.find((candidate) => candidate.id === fieldId);
    if (field && !isRetired(field) && linksTo(field, tableIds[link.target])) out.peopleLinks[link.key] = fieldId;
  }
  return out;
}

const PEOPLE_TABLE = { label: "People", names: ["people", "contacts", "persons", "person", "leads", "network", "connections"] };

/**
 * The table people most likely live in: by name, plus weight for every other
 * table whose person/people link points at it (a Work history's Person column
 * says where people are better than any name).
 */
export function suggestPeopleTable(tables) {
  const list = Array.isArray(tables) ? tables : [];
  const pointedAt = new Map();
  for (const table of list) {
    for (const field of table.fields || []) {
      if (field.type !== "multipleRecordLinks" || isRetired(field)) continue;
      if (!/^(person|people|contact|contacts)$/.test(normalizeName(field.name))) continue;
      const target = field.options?.linkedTableId;
      if (target) pointedAt.set(target, (pointedAt.get(target) || 0) + 1);
    }
  }
  let best = null;
  for (const table of list) {
    const score = phraseScore(PEOPLE_TABLE.label, PEOPLE_TABLE.names, table.name) + (pointedAt.get(table.id) || 0) * 300;
    if (score > 0 && (!best || score > best.score)) best = { id: table.id, name: table.name, score };
  }
  return best;
}

/**
 * When the chosen people table isn't the one the linked tables point their
 * Person column at, linked tables can't work; this names the one they expect.
 */
export function peopleTableMismatch(tables, peopleTableId) {
  const list = Array.isArray(tables) ? tables : [];
  const workHistory = list.find((table) => normalizeName(table.name) === "work history")
    || list.find((table) => phraseScore(LINKED_TABLES[1].label, LINKED_TABLES[1].names, table.name) >= 1000);
  const personLink = workHistory?.fields?.find((field) => field.type === "multipleRecordLinks"
    && /^(person|people)$/.test(normalizeName(field.name)));
  const expected = personLink?.options?.linkedTableId;
  if (!expected || expected === peopleTableId) return null;
  const table = list.find((candidate) => candidate.id === expected);
  return table ? { id: table.id, name: table.name, via: workHistory.name } : null;
}

// The People links setups made before `linkedSeen` existed were offered.
const FIRST_PEOPLE_LINKS = ["workedAt", "schools"];

/**
 * Match People link kinds this setup has never been offered (added in a later
 * version) by name, once. One someone later sets to Skip stays skipped.
 */
export function offerNewPeopleLinks(tables, peopleTableId, linked, seen) {
  const offered = new Set(seen || FIRST_PEOPLE_LINKS);
  const fresh = PEOPLE_LINKS.filter((link) => !offered.has(link.key));
  const next = { ...linked, peopleLinks: { ...(linked?.peopleLinks || {}) } };
  if (fresh.length) {
    const suggested = suggestLinked(tables, peopleTableId, next);
    for (const link of fresh) {
      if (!next.peopleLinks[link.key] && suggested.peopleLinks?.[link.key]) next.peopleLinks[link.key] = suggested.peopleLinks[link.key];
    }
  }
  return { linked: next, linkedSeen: PEOPLE_LINKS.map((link) => link.key) };
}
