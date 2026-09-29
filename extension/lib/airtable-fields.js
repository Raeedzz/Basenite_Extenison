/**
 * What a captured LinkedIn person turns into in Airtable. Pure, so the mapping
 * rules are unit testable without chrome or the network.
 *
 *   SOURCE_FIELDS    the values the extension can fill, each with the Airtable
 *                    type it creates and the column names it auto-maps onto
 *   extractPerson    captured row (sync / company / mutuals / profile) → values
 *   suggestMapping   table schema → { sourceKey: fieldId } by column name
 *   cellValue        value → what that Airtable field type accepts
 */

// Airtable types the API can write. Everything else (formula, rollup, lookup,
// links, collaborators, …) is computed or needs ids we don't have.
export const WRITABLE_TYPES = new Set([
  "singleLineText", "multilineText", "richText", "email", "url", "phoneNumber",
  "number", "currency", "percent", "rating", "duration",
  "checkbox", "date", "dateTime", "singleSelect", "multipleSelects", "multipleAttachments",
  "multipleCollaborators",
]);

// Types a LinkedIn URL can be matched on.
export const KEY_TYPES = new Set(["singleLineText", "url", "multilineText"]);

const DATE_OPTIONS = { dateFormat: { name: "iso" } };
const DATETIME_OPTIONS = { dateFormat: { name: "iso" }, timeFormat: { name: "24hour" }, timeZone: "client" };

/**
 * `hash: false` fields are written with a row's other changes but never cause
 * a write on their own. `createOnly` fields are set when the row is created and
 * left alone after, so a person found again by a later capture keeps where they
 * first came from.
 */
export const SOURCE_FIELDS = Object.freeze([
  { key: "linkedinUrl", label: "LinkedIn URL", type: "url", required: true,
    names: ["linkedin url", "linkedin", "linkedin profile", "linkedin link", "profile url", "li url", "linkedin profile url"] },
  { key: "name", label: "Full name", type: "singleLineText", fill: true,
    names: ["name", "full name", "contact", "contact name", "person", "person name"] },
  { key: "firstName", label: "First name", type: "singleLineText", fill: true, names: ["first name", "firstname", "given name"] },
  { key: "lastName", label: "Last name", type: "singleLineText", fill: true, names: ["last name", "lastname", "surname", "family name"] },
  { key: "headline", label: "Headline", type: "singleLineText", owned: true, names: ["headline", "linkedin headline", "tagline"] },
  { key: "title", label: "Current title", type: "singleLineText",
    names: ["title", "job title", "role", "position", "current title", "current role", "current position"] },
  { key: "company", label: "Current company", type: "singleLineText",
    names: ["company", "company name", "current company", "organization", "organisation", "employer", "firm"] },
  { key: "previousTitle", label: "Previous title", type: "singleLineText", hint: "most recent role they've left",
    names: ["previous title", "previous role", "previous position", "last title", "last role", "former title", "former role", "prior title", "prior role"] },
  { key: "previousCompany", label: "Previous company", type: "singleLineText", hint: "most recent company they've left",
    names: ["previous company", "previous employer", "last company", "last employer", "former company", "former employer", "prior company", "prior employer"] },
  { key: "pastCompanies", label: "Past companies", type: "multilineText", hint: "every company they've left, newest first",
    names: ["past companies", "previous companies", "former companies", "prior companies", "past employers", "previous employers", "former employers", "companies worked at", "worked at", "past firms", "career history"] },
  { key: "location", label: "Location", type: "singleLineText", fill: true, names: ["location", "city", "based in", "geography", "region"] },
  { key: "industry", label: "Industry", type: "singleLineText", fill: true, names: ["industry", "sector"] },
  { key: "about", label: "About", type: "multilineText", fill: true, names: ["about", "summary", "bio", "description", "linkedin about"] },
  { key: "photo", label: "Photo", type: "multipleAttachments", fill: "blank", hint: "LinkedIn profile picture; only fills a blank cell",
    names: ["photo", "avatar", "picture", "headshot", "profile photo", "profile picture", "image"] },
  { key: "experience", label: "Experience", type: "multilineText", hint: "every role, current and past, one per line",
    names: ["experience", "work experience", "work history", "employment history", "career", "positions", "roles", "job history", "linkedin experience"] },
  { key: "experienceDates", label: "Experience timeframes", type: "multilineText",
    hint: "one line per role, in the same order as Experience",
    names: ["experience timeframes", "experience timeframe", "experience dates", "role dates", "role timeframes", "timeframe", "timeframes", "time frame", "time period", "tenure", "role tenure"] },
  { key: "education", label: "Education", type: "multilineText", hint: "every school with degree and field, one per line",
    names: ["education", "education history", "educational background", "degrees", "academic background", "linkedin education"] },
  { key: "educationDates", label: "Education timeframes", type: "multilineText",
    hint: "one line per school, in the same order as Education",
    names: ["education timeframes", "education timeframe", "education dates", "school dates", "school timeframes", "years attended", "graduation years", "class year"] },
  { key: "schools", label: "All schools", type: "multilineText", hint: "school names only",
    names: ["schools", "all schools", "schools attended", "universities", "colleges", "alma maters"] },
  { key: "school", label: "Latest school", type: "singleLineText",
    names: ["school", "university", "college", "alma mater", "latest school", "most recent school"] },
  { key: "additionalInfo", label: "Additional info", type: "multilineText",
    hint: "optional: each role's location, company page, and description, plus certifications and volunteering",
    names: ["additional info", "additional information", "more info", "extra info", "other info", "details", "linkedin details", "profile details", "background"] },
  { key: "skills", label: "Skills", type: "multilineText", names: ["skills", "expertise"] },
  { key: "languages", label: "Languages", type: "singleLineText", names: ["languages", "language"] },
  { key: "degree", label: "Connection degree", type: "singleSelect",
    names: ["degree", "connection degree", "connection", "network degree", "connection level"] },
  { key: "inNetwork", label: "Network", type: "singleSelect",
    labels: { true: "In network", false: "Outside network" },
    hint: "In network = a 1st-degree connection of yours; Outside network = 2nd, 3rd, or beyond",
    names: ["network", "in network", "network status", "inside network", "in my network", "connection status", "is connection"] },
  { key: "connectedAt", label: "Connected on", type: "date", options: DATE_OPTIONS,
    names: ["connected on", "connected", "connected at", "connection date", "date connected"] },
  { key: "lastInteractionAt", label: "Last interaction", type: "dateTime", options: DATETIME_OPTIONS,
    names: ["last interaction", "last contacted", "last contact", "last message", "last touch", "last touchpoint"] },
  { key: "lastInteractionDirection", label: "Last message direction", type: "singleSelect",
    names: ["last message direction", "last interaction direction", "direction"] },
  { key: "hasInteracted", label: "Has messaged", type: "checkbox", names: ["has messaged", "has interacted", "messaged", "interacted"] },
  { key: "mutualCount", label: "Mutual connections count", type: "number", options: { precision: 0 },
    names: ["mutual connections count", "mutual count", "mutuals count", "# mutuals", "number of mutuals"] },
  { key: "mutualConnections", label: "Mutual connections", type: "multilineText",
    names: ["mutual connections", "mutuals", "shared connections", "bridges", "warm intros"] },
  { key: "source", label: "Source", type: "singleSelect", createOnly: true, hash: false, autoMap: false,
    names: ["source", "lead source", "origin", "found via", "captured from"] },
  { key: "createdStamp", label: "New-row marker", type: "singleSelect", createOnly: true, hash: false, noCreate: true,
    hint: "set once, only on rows the extension creates",
    names: ["enrichment review", "added by", "record origin", "created by extension"] },
  { key: "referredBy", label: "Referred by", type: "singleLineText", fill: "blank",
    hint: "only when a referrer is known, and only into a blank cell",
    names: ["referred by", "referrer", "referral", "introduced by", "intro from"] },
  { key: "knownBy", label: "Known by", type: "multipleCollaborators", union: true, noCreate: true,
    hint: "the Airtable user running the sync; only ever added, never removed",
    names: ["known by", "relationship owner", "relationship owners", "who knows them", "connected to"] },
  { key: "lastSyncedAt", label: "Last updated from LinkedIn", type: "dateTime", options: DATETIME_OPTIONS, hash: false, owned: true,
    names: ["last updated from linkedin", "last synced", "synced at", "last sync", "linkedin updated"] },
]);

export const SOURCE_FIELD_BY_KEY = new Map(SOURCE_FIELDS.map((field) => [field.key, field]));

// ─── LinkedIn identity ───────────────────────────────────────────────────────

/** The `/in/<slug>` of a LinkedIn URL, lowercased; null for anything else. */
export function linkedinKey(value) {
  if (typeof value !== "string" || !value) return null;
  // Brackets and quotes end the slug: a link pasted into notes as <…>, (…) or "…".
  const match = value.match(/linkedin\.com\/in\/([^/?#\s<>()[\]"'`]+)/i);
  if (!match) return null;
  let slug = match[1];
  try { slug = decodeURIComponent(slug); } catch {}
  return slug.trim().toLowerCase() || null;
}

export function canonicalLinkedinUrl(value) {
  const key = linkedinKey(value);
  return key ? `https://www.linkedin.com/in/${encodeURIComponent(key)}` : null;
}

// ─── Images ──────────────────────────────────────────────────────────────────

// A signed LinkedIn CDN URL this close to expiring may be dead before Airtable fetches it.
const IMAGE_EXPIRY_MARGIN_S = 10 * 60;

/**
 * `value` if it's an image Airtable can fetch now; "" for LinkedIn's
 * placeholder avatars and logos, expired CDN links, and anything not https.
 */
export function imageUrl(value, now = Date.now()) {
  const url = typeof value === "string" ? value.trim() : "";
  let parsed;
  try { parsed = new URL(url); } catch { return ""; }
  // LinkedIn's CDN only: nothing else is fetched to check it, or handed to Airtable to fetch.
  if (parsed.protocol !== "https:" || !/(^|\.)licdn\.com$/i.test(parsed.hostname) || isPlaceholderImage(url)) return "";
  return imageExpired(url, now) ? "" : url;
}

/**
 * LinkedIn's stand-in for a missing photo or logo. Placeholders are static
 * assets (static.licdn.com/aero-v1/sc/h/…); real ones live under
 * media.licdn.com/dms/image.
 */
export function isPlaceholderImage(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return false; }
  return /^static[\w-]*\.licdn\.com$/i.test(parsed.hostname) || /\/sc\/h\/|ghost/i.test(parsed.pathname);
}

/** A signed LinkedIn CDN link past (or about to pass) its `e=` expiry. */
export function imageExpired(value, now = Date.now()) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return false; }
  const expires = Number(parsed.searchParams.get("e"));
  return /licdn\.com$/i.test(parsed.hostname) && expires > 0 && expires - IMAGE_EXPIRY_MARGIN_S < now / 1000;
}

/** The same image whatever its signature: a LinkedIn URL minus its query. */
export function imageKey(url) {
  return String(url || "").split("?")[0];
}

/** An attachment for `url` named `<slug>.jpg`, or null when it isn't a real image. */
export function attachmentFor(url, slug) {
  const usable = imageUrl(url);
  if (!usable) return null;
  const name = String(slug || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "image";
  return { url: usable, filename: `${name}.jpg` };
}

// ─── Extraction ──────────────────────────────────────────────────────────────

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function isoDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function dateRange(entry) {
  const start = text(entry?.startDate);
  const end = text(entry?.endDate) || (entry?.isCurrent ? "present" : "");
  if (!start && !end) return "";
  return `${start || "?"} – ${end || "?"}`;
}

function positions(experience) {
  return list(experience).filter((entry) => text(entry?.title) || text(entry?.company));
}

/**
 * Where they are now and where they've been. LinkedIn lists positions newest
 * first; an entry with no end date is ongoing even when the flag is missing.
 * Someone between jobs has no current role, and their latest one is past.
 */
function splitPositions(experience) {
  const entries = positions(experience);
  const ongoing = (entry) => entry.isCurrent === true || (entry.isCurrent === undefined && !text(entry.endDate));
  const current = entries.filter(ongoing);
  return { current: current[0] || null, past: entries.filter((entry) => !ongoing(entry)) };
}

function uniqueNames(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const name = text(value);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

const MAX_DESCRIPTION = 1500;

/** A role's own words, tidied: no blank-line runs, capped so one essay can't crowd out the rest. */
function descriptionText(value) {
  const cleaned = text(value).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n");
  return cleaned.length > MAX_DESCRIPTION ? `${cleaned.slice(0, MAX_DESCRIPTION).trimEnd()}…` : cleaned;
}

const MAX_ROLES = 40;

/** Every role, newest first, one line each: "Title at Company". */
function experienceText(experience) {
  return positions(experience)
    .slice(0, MAX_ROLES)
    .map((entry) => [text(entry?.title), text(entry?.company)].filter(Boolean).join(" at "))
    .join("\n");
}

/**
 * The same roles' timeframes, line for line with experienceText, so line n of
 * each column is the same job. A role with no dates keeps its line as "—".
 */
function experienceDatesText(experience) {
  const lines = positions(experience).slice(0, MAX_ROLES).map((entry) => dateRange(entry) || "—");
  return lines.some((line) => line !== "—") ? lines.join("\n") : "";
}

/**
 * The detail Experience leaves out, for roles that have any: where the role
 * was, the company's LinkedIn page, and what they wrote about it.
 */
function roleDetailsText(experience) {
  return positions(experience)
    .slice(0, MAX_ROLES)
    .map((entry) => {
      const extras = [text(entry?.location), companyPage(entry?.companyUrn)].filter(Boolean);
      const body = descriptionText(entry?.description);
      if (!extras.length && !body) return "";
      const role = [text(entry?.title), text(entry?.company)].filter(Boolean).join(" at ");
      const head = [role, ...extras].join(" · ");
      return body ? `${head}\n${body.split("\n").map((line) => (line ? `  ${line}` : "")).join("\n")}` : head;
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Everything captured that has no column of its own, in titled sections. */
function additionalInfoText(row) {
  const sections = [
    ["Roles", roleDetailsText(row.experience)],
    ["Certifications", certificationsText(list(row.certifications).length ? row.certifications : row.licenses)],
    ["Volunteering", volunteeringText(row.volunteering)],
  ].filter(([, body]) => body);
  return sections.map(([title, body]) => `${title}\n${body}`).join("\n\n");
}

function certificationsText(certifications) {
  return list(certifications)
    .slice(0, 30)
    .map((entry) => {
      const issued = text(entry?.issueDate || entry?.startDate);
      const expires = text(entry?.expirationDate || entry?.endDate);
      const when = issued && expires ? `${issued} – ${expires}` : issued || (expires ? `expires ${expires}` : "");
      const line = [text(entry?.name), text(entry?.issuingOrg)].filter(Boolean).join(" — ");
      return line ? (when ? `${line} (${when})` : line) : "";
    })
    .filter(Boolean)
    .join("\n");
}

function volunteeringText(volunteering) {
  return list(volunteering)
    .slice(0, 20)
    .map((entry) => {
      const line = [text(entry?.role), text(entry?.organization)].filter(Boolean).join(" at ");
      // Volunteering carries no "current" flag; a start with no end is ongoing.
      const details = [text(entry?.cause), dateRange({ ...entry, isCurrent: !text(entry?.endDate) })].filter(Boolean).join(", ");
      return line ? (details ? `${line} (${details})` : line) : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** urn:li:fsd_company:1234 (or …:company:1234) → the company's LinkedIn page. */
function companyPage(urn) {
  const id = String(urn || "").match(/company:(\d+)$/)?.[1];
  return id ? `https://www.linkedin.com/company/${id}` : "";
}

const MAX_SCHOOLS = 20;

/** Education entries worth a line: ones that name a school or what was studied. */
function schoolEntries(education) {
  return list(education)
    .filter((entry) => text(entry?.school) || text(entry?.degree) || text(entry?.field))
    .slice(0, MAX_SCHOOLS);
}

/** Every school, one line each: "School — Degree, Field". */
function educationText(education) {
  return schoolEntries(education)
    .map((entry) => {
      const study = [text(entry?.degree), text(entry?.field)].filter(Boolean).join(", ");
      return [text(entry?.school), study].filter(Boolean).join(" — ");
    })
    .join("\n");
}

/**
 * The same schools' timeframes, line for line with educationText. A lone
 * year is usually graduation, so it stands alone rather than as "? – 2015".
 */
function educationDatesText(education) {
  const lines = schoolEntries(education).map((entry) => {
    const start = text(entry?.startDate);
    const end = text(entry?.endDate);
    return start && end ? `${start} – ${end}` : end || (start ? `${start} –` : "—");
  });
  return lines.some((line) => line !== "—") ? lines.join("\n") : "";
}

function names(values, pick) {
  return list(values).map(pick).map(text).filter(Boolean);
}

function normalizeDegree(value) {
  if (typeof value === "number") return value >= 1 && value <= 3 ? ["1st", "2nd", "3rd"][value - 1] : null;
  const match = String(value || "").match(/\b(1st|2nd|3rd)\b|DISTANCE_([123])/i);
  if (!match) return null;
  return match[1] ? match[1].toLowerCase() : ["1st", "2nd", "3rd"][Number(match[2]) - 1];
}

/** In your network means connected to you (1st degree); null when the degree isn't known. */
function networkOf(degree) {
  if (!degree) return null;
  return degree === "1st";
}

function mutualLines(bridges) {
  return list(bridges)
    .map((bridge) => {
      const name = text(bridge?.name);
      const url = canonicalLinkedinUrl(bridge?.linkedinUrl);
      return name && url ? `${name} — ${url}` : name || url || "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Everything the extension knows about one person, keyed by SOURCE_FIELDS.
 * Returns null when there is no LinkedIn URL to match the row on.
 *
 * The connection sync's base rows carry LinkedIn's headline in `bio`; a full
 * profile pass replaces `bio` with the About section and keeps the headline
 * in `headline`. `_earthosEnrichment` is what says which of the two a row is.
 */
export function extractPerson(row, { source = null, degree = null, now = new Date() } = {}) {
  if (!row || typeof row !== "object") return null;
  const linkedinUrl = canonicalLinkedinUrl(row.linkedinUrl || row.profileUrl || row.url);
  if (!linkedinUrl) return null;

  const name = text(row.name) || [text(row.firstName), text(row.lastName)].filter(Boolean).join(" ");
  const parts = name.split(/\s+/).filter(Boolean);
  const enriched = Boolean(row._earthosEnrichment) || Array.isArray(row.experience) && row.experience.length > 0;
  const headline = text(row.headline) || (!enriched ? text(row.bio) : "");
  const about = enriched && text(row.bio) !== headline ? text(row.bio) : "";
  const { current: position, past } = splitPositions(row.experience);
  const school = list(row.education).find((entry) => text(entry?.school));
  const bridges = list(row.bridges);

  return {
    linkedinUrl,
    name,
    firstName: text(row.firstName) || parts[0] || "",
    lastName: text(row.lastName) || parts.slice(1).join(" "),
    headline,
    title: text(position?.title),
    company: text(position?.company),
    previousTitle: text(past[0]?.title),
    previousCompany: text(past[0]?.company),
    pastCompanies: uniqueNames(past.map((entry) => entry.company)),
    location: text(row.location),
    industry: text(row.industry),
    about,
    photo: attachmentFor(text(row.photoUrl), linkedinKey(linkedinUrl)),
    experience: experienceText(row.experience),
    experienceDates: experienceDatesText(row.experience),
    education: educationText(row.education),
    educationDates: educationDatesText(row.education),
    school: text(school?.school),
    schools: uniqueNames(list(row.education).map((entry) => entry?.school)),
    additionalInfo: additionalInfoText(row),
    skills: names(row.skills, (skill) => (typeof skill === "string" ? skill : skill?.name)),
    languages: names(row.languages, (language) => (typeof language === "string" ? language : language?.name)),
    degree: normalizeDegree(row.degree ?? row.connectionDegree) || degree,
    inNetwork: networkOf(normalizeDegree(row.degree ?? row.connectionDegree) || degree),
    connectedAt: isoDate(row.connectedAt),
    lastInteractionAt: isoDate(row.lastInteractionAt),
    lastInteractionDirection: row.lastInteractionDirection === "sent" || row.lastInteractionDirection === "received"
      ? row.lastInteractionDirection
      : null,
    hasInteracted: typeof row.hasInteracted === "boolean" ? row.hasInteracted : null,
    mutualCount: Array.isArray(row.bridges) ? Math.max(bridges.length, Number(row.totalBridges) || 0) : null,
    mutualConnections: mutualLines(bridges),
    source,
    referredBy: text(row.referredBy) || text(row.referrer),
    lastSyncedAt: now.toISOString(),
  };
}

// ─── Coercion ────────────────────────────────────────────────────────────────

const MAX_TEXT = 90_000;

function asText(value) {
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object" && typeof value.url === "string") return value.url;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function isEmpty(value) {
  return value === null || value === undefined || value === ""
    || (Array.isArray(value) && value.length === 0);
}

/**
 * The cell value for `field` (an Airtable field from the meta API), or
 * undefined to leave the cell alone. Empty values are never written: a capture
 * that did not see something must not blank what is already there.
 */
export function cellValue(value, field) {
  if (isEmpty(value) || !field) return undefined;
  switch (field.type) {
    case "singleLineText":
      return asText(value).replace(/\s*\n\s*/g, "; ").slice(0, MAX_TEXT);
    case "multilineText":
    case "richText":
      return (Array.isArray(value) ? value.join("\n") : asText(value)).slice(0, MAX_TEXT);
    case "url":
    case "email":
    case "phoneNumber":
      return asText(value).split("\n")[0].trim() || undefined;
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration": {
      const number = typeof value === "boolean" ? Number(value) : Number(value);
      return Number.isFinite(number) ? number : undefined;
    }
    case "checkbox":
      return typeof value === "boolean" ? value : undefined;
    case "date": {
      const iso = isoDate(value);
      return iso ? iso.slice(0, 10) : undefined;
    }
    case "dateTime": {
      // To the minute: Airtable reads a time back at its own precision, and a
      // value that comes back different would look edited by hand.
      const iso = isoDate(value);
      return iso ? iso.replace(/:\d{2}(\.\d+)?Z$/, ":00.000Z") : undefined;
    }
    case "singleSelect":
      return (Array.isArray(value) ? value[0] : asText(value)).replace(/,/g, " ").slice(0, 200) || undefined;
    case "multipleSelects":
      return (Array.isArray(value) ? value : asText(value).split(/\n|,\s*/))
        .map((item) => String(item).replace(/,/g, " ").trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, 100);
    case "multipleCollaborators":
      return (Array.isArray(value) ? value : [value])
        .map((user) => (user?.id ? { id: user.id } : user?.email ? { email: user.email } : null))
        .filter(Boolean);
    case "multipleRecordLinks":
      return (Array.isArray(value) ? value : [value]).filter((id) => typeof id === "string" && /^rec[A-Za-z0-9]{14}$/.test(id));
    case "multipleAttachments": {
      const url = imageUrl(asText(value));
      if (!url) return undefined;
      return [value?.filename ? { url, filename: value.filename } : { url }];
    }
    default:
      return undefined;
  }
}

// ─── Auto-mapping ────────────────────────────────────────────────────────────

export function normalizeName(value) {
  const spaced = String(value || "").toLowerCase().replace(/[_\-./]+/g, " ");
  const latin = spaced.replace(/[^a-z0-9# ]+/g, "").replace(/\s+/g, " ").trim();
  // A name with no Latin letters (حكومي, 京都…) keeps its own, or it would never match itself.
  return latin || spaced.normalize("NFKC").replace(/[^\p{L}\p{N}# ]+/gu, "").replace(/\s+/g, " ").trim();
}

/**
 * A column marked for removal, or a sample/example column, is never
 * auto-matched. It can still be picked by hand.
 */
export function isRetired(field) {
  const name = normalizeName(field?.name);
  return /\bdelete me\b|\bdeprecated\b|\bdo not use\b|^old\b|\bold link\b|\bsetup sample\b|\bsample\b|\bexample\b/.test(name);
}

export function isWritable(field) {
  return Boolean(field) && WRITABLE_TYPES.has(field.type);
}

const TEXTUAL = ["singleLineText", "multilineText", "richText"];
const COMPATIBLE = {
  url: [...KEY_TYPES],
  singleLineText: [...TEXTUAL, "singleSelect", "multipleSelects"],
  multilineText: [...TEXTUAL, "multipleSelects"],
  singleSelect: [...TEXTUAL, "singleSelect", "multipleSelects"],
  multipleAttachments: ["multipleAttachments", "url", ...TEXTUAL],
  date: ["date", "dateTime", "singleLineText"],
  dateTime: ["dateTime", "date", "singleLineText"],
  checkbox: ["checkbox", "singleLineText", "singleSelect"],
  number: ["number", "singleLineText"],
};

/** Airtable column types a source field can be written into. */
export function compatibleTypes(sourceKey) {
  if (sourceKey === "createdStamp") return new Set(["singleSelect"]);
  if (sourceKey === "knownBy") return new Set(["multipleCollaborators"]);
  if (sourceKey === "inNetwork") return new Set(["singleSelect", "singleLineText", "checkbox"]);
  const source = SOURCE_FIELD_BY_KEY.get(sourceKey);
  return new Set(source ? COMPATIBLE[source.type] || TEXTUAL : []);
}

export function canMap(sourceKey, field) {
  return isWritable(field) && compatibleTypes(sourceKey).has(field.type);
}

const PAST_WORDS = new Set(["past", "previous", "prior", "former", "last", "old", "history", "worked"]);
const CURRENT_KEYS = new Set(["title", "company"]);
const PAST_KEYS = new Set(["previousTitle", "previousCompany", "pastCompanies"]);

function singular(word) {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses") || word.endsWith("xes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

export function tokens(value) {
  return normalizeName(value).split(" ").filter(Boolean).map(singular);
}

/**
 * How well a column name fits a label and its synonyms, 0 for not at all. An
 * exact synonym beats a phrase found inside a longer name, which beats a
 * column name that is only part of a synonym; longer matches beat shorter
 * ones. A one-word column ("Date", "Profile") is too vague to claim by being
 * part of a longer synonym; it has to match outright.
 */
export function phraseScore(label, names, fieldName) {
  const field = tokens(fieldName);
  if (field.length === 0) return 0;
  const fieldText = field.join(" ");
  let best = 0;
  for (const name of [label, ...names]) {
    const phrase = tokens(name);
    const phraseText = phrase.join(" ");
    if (phraseText === fieldText) best = Math.max(best, 1000 + phrase.length);
    else if (` ${fieldText} `.includes(` ${phraseText} `)) best = Math.max(best, 500 + phrase.length * 10 - (field.length - phrase.length));
    else if (field.length >= 2 && ` ${phraseText} `.includes(` ${fieldText} `)) best = Math.max(best, 100 + field.length * 10);
  }
  return best;
}

/**
 * phraseScore for a People field, plus one rule: a column that talks about the
 * past never takes a "current" field, and a "past" field only takes a column
 * that says so.
 */
function nameScore(source, fieldName) {
  const field = tokens(fieldName);
  if (field.length === 0) return 0;
  const fieldText = field.join(" ");
  const saysPast = field.some((word) => PAST_WORDS.has(word));
  if (CURRENT_KEYS.has(source.key) && saysPast) return 0;
  if (PAST_KEYS.has(source.key) && !saysPast && !source.names.some((name) => tokens(name).join(" ") === fieldText)) return 0;
  return phraseScore(source.label, source.names, fieldName);
}

/**
 * Map source fields onto table columns by name. Every candidate pair is
 * scored and the strongest pairs are taken first, so "Past companies" goes
 * to past companies before "Company" can claim it, and each column is used
 * once. Only columns whose type can hold the value are considered.
 */
export function suggestMapping(tableFields, existing = {}) {
  const writable = (Array.isArray(tableFields) ? tableFields : []).filter(isWritable);
  const live = new Map(writable.map((field) => [field.id, field]));
  const mapping = {};
  const used = new Set();
  for (const [key, fieldId] of Object.entries(existing || {})) {
    if (canMap(key, live.get(fieldId)) && !used.has(fieldId)) {
      mapping[key] = fieldId;
      used.add(fieldId);
    }
  }
  const pairs = [];
  for (const source of SOURCE_FIELDS) {
    if (mapping[source.key] || source.autoMap === false) continue;
    for (const field of writable) {
      if (used.has(field.id) || isRetired(field) || !canMap(source.key, field)) continue;
      const score = nameScore(source, field.name);
      // Between equally good names, the column already of the field's own type wins.
      if (score > 0) pairs.push({ key: source.key, fieldId: field.id, score: score + (field.type === source.type ? 5 : 0) });
    }
  }
  pairs.sort((left, right) => right.score - left.score);
  for (const { key, fieldId } of pairs) {
    if (mapping[key] || used.has(fieldId)) continue;
    mapping[key] = fieldId;
    used.add(fieldId);
  }
  return mapping;
}

// Fields added after the first setups were saved; those setups never saw them.
const LATE_KEYS = new Set(["knownBy", "photo", "inNetwork"]);

/**
 * A saved mapping picks up fields it has never been offered, once a column
 * for them exists (a new field, or a column added since). A field someone
 * left unmapped while its column was there has been seen, and stays unmapped.
 * `seen` null is a setup saved before this was tracked.
 */
export function offerNewMappings(tableFields, mapping, seen) {
  const offered = new Set(seen ?? SOURCE_FIELDS.map((source) => source.key).filter((key) => !LATE_KEYS.has(key)));
  const suggested = suggestMapping(tableFields, mapping);
  const next = { ...mapping };
  for (const [key, fieldId] of Object.entries(suggested)) {
    if (!offered.has(key) && !next[key]) next[key] = fieldId;
    offered.add(key);
  }
  for (const key of Object.keys(next)) offered.add(key);
  return { mapping: next, mappingSeen: [...offered] };
}

/** Every field a mapping has now been offered: what's mapped, and whatever had a column to map. */
export function seenMappings(tableFields, mapping, seen) {
  const offered = new Set([...(seen || []), ...Object.keys(mapping || {}), ...Object.keys(suggestMapping(tableFields, {})), ...Object.keys(suggestMapping(tableFields, mapping || {}))]);
  return [...offered];
}

/**
 * The marker value for a single-select column: an existing choice only, since
 * it's sent with typecast off. "Added By Branch" if the column has it.
 */
export function suggestStampValue(field) {
  const choices = (field?.options?.choices || []).map((choice) => choice.name);
  return choices.find((name) => name === "Added By Branch")
    || choices.find((name) => /added by|extension|linkedin/i.test(name))
    || null;
}

/** The body Airtable's create-field endpoint takes for a source field. */
export function newFieldSpec(sourceKey, name) {
  const source = SOURCE_FIELD_BY_KEY.get(sourceKey);
  if (!source) throw new Error(`Unknown field ${sourceKey}`);
  const spec = { name: name || source.label, type: source.type };
  if (source.type === "singleSelect") {
    spec.options = { choices: Object.values(source.labels || {}).map((choice) => ({ name: choice })) };
  }
  // Airtable won't make a checkbox without its look.
  if (source.type === "checkbox") spec.options = { icon: "check", color: "greenBright" };
  if (source.options) spec.options = source.options;
  return spec;
}

// ─── Change detection ────────────────────────────────────────────────────────

/** FNV-1a, 32-bit, hex: a short fingerprint of what was last written to a cell. */
export function fingerprint(value) {
  const input = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The fields to send for one person, and the fingerprints to remember once
 * they land. `previous` is what was last written ({ sourceKey: fingerprint }),
 * `{}` for a row that exists but was never written by the extension, or null
 * when the row does not exist yet. The fingerprint covers the target column
 * too, so re-mapping a field re-sends it.
 *
 * Returns { fields, hashes, changed } — `changed` false means nothing but
 * bookkeeping fields moved, so the row needs no request at all.
 */
export function planCells(person, mapping, fieldsById, previous) {
  const creating = !previous;
  const fields = {};
  const hashes = { ...(previous || {}) };
  let changed = false;
  for (const source of SOURCE_FIELDS) {
    const fieldId = mapping[source.key];
    const field = fieldId ? fieldsById.get(fieldId) : null;
    if (!field) continue;
    // The URL is how the row was found; rewriting it would only reformat it.
    if ((source.createOnly || source.required) && !creating) continue;
    const raw = person[source.key];
    const labelled = typeof raw === "boolean" && source.labels && field.type !== "checkbox" ? source.labels[raw] : raw;
    const value = cellValue(labelled, field);
    if (value === undefined) continue;
    if (source.hash === false) {
      fields[fieldId] = value;
      continue;
    }
    // A LinkedIn image URL is re-signed on every fetch; the image itself is what counts.
    const print = fingerprint([fieldId, source.key === "photo" ? imageKey(asText(Array.isArray(value) ? value[0] : value)) : value]);
    if (hashes[source.key] === print) continue;
    fields[fieldId] = value;
    hashes[source.key] = print;
    changed = true;
  }
  return { fields, hashes, changed: changed || creating };
}
