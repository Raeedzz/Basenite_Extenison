/**
 * An in-memory Airtable Web API, strict where the real one is strict: record
 * writes take at most 10 records, every field id must exist, an unknown record
 * id is a 404, and a value the column can't hold is a 422 for the whole
 * request. Enough of the meta API to connect, pick a table, and add columns.
 */

export const BASE_ID = "appTESTBASE000001";
export const TABLE_ID = "tblTESTTABLE00001";

export const TABLE_FIELDS = [
  { id: "fldName", name: "Name", type: "singleLineText" },
  { id: "fldLinkedIn", name: "LinkedIn", type: "url" },
  { id: "fldTitle", name: "Title", type: "singleLineText" },
  { id: "fldCompany", name: "Company", type: "singleLineText" },
  { id: "fldHeadline", name: "Headline", type: "multilineText" },
  { id: "fldConnected", name: "Connected on", type: "date" },
  { id: "fldSource", name: "Source", type: "singleSelect", options: { choices: [] } },
  { id: "fldDegree", name: "Degree", type: "singleSelect", options: { choices: [] } },
  { id: "fldMutuals", name: "Mutual connections", type: "multilineText" },
  { id: "fldMutualCount", name: "Mutual count", type: "number", options: { precision: 0 } },
  { id: "fldNotes", name: "Notes", type: "multilineText" },
  { id: "fldFormula", name: "Score", type: "formula" },
];

export const MAPPING = {
  name: "fldName",
  linkedinUrl: "fldLinkedIn",
  title: "fldTitle",
  company: "fldCompany",
  headline: "fldHeadline",
  connectedAt: "fldConnected",
  source: "fldSource",
  degree: "fldDegree",
  mutualConnections: "fldMutuals",
  mutualCount: "fldMutualCount",
};

/** What chrome.storage holds once the panel's setup is finished. */
export function airtableConfig(overrides = {}) {
  return {
    token: "patTESTTOKEN.0123456789abcdef",
    userEmail: "ops@example.com",
    bases: [{ id: BASE_ID, name: "Deal flow", permissionLevel: "create" }],
    baseId: BASE_ID,
    baseName: "Deal flow",
    tableId: TABLE_ID,
    tableName: "People",
    fields: TABLE_FIELDS,
    mapping: MAPPING,
    schemaAt: Date.now(),
    ...overrides,
  };
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

/**
 * The formulas the extension sends: OR(RECORD_ID()='rec…', …) and
 * OR(FIND("needle", LOWER({Field name})), …).
 */
class FormulaError extends Error {}

function matchesFormula(formula, record, fields) {
  const ids = [...formula.matchAll(/RECORD_ID\(\)='(rec[A-Za-z0-9]+)'/g)].map((hit) => hit[1]);
  if (ids.length) return ids.includes(record.id);
  const finds = [...formula.matchAll(/FIND\("((?:[^"\\]|\\.)*)", LOWER\(\{([^}]*)\}\)\)/g)];
  if (finds.length) {
    return finds.some(([, needle, ref]) => {
      // Like Airtable: a field by name or by id; anything else fails the whole formula.
      const field = fields.find((candidate) => candidate.name === ref || candidate.id === ref);
      if (!field) throw new FormulaError(`Unknown field names: ${ref.toLowerCase()}`);
      return String(record.fields[field.id] ?? "").toLowerCase().includes(needle.replace(/\\(.)/g, "$1"));
    });
  }
  throw new Error(`fake Airtable can't evaluate ${formula}`);
}

/** A read, as GET …/table?… or POST …/table/listRecords. */
function listPage(all, fields, { formula, offset, wanted }) {
  let rows = all;
  if (formula) {
    try {
      rows = rows.filter((record) => matchesFormula(formula, record, fields));
    } catch (error) {
      if (error instanceof FormulaError) return json({ error: { type: "INVALID_FILTER_BY_FORMULA", message: error.message } }, 422);
      throw error;
    }
  }
  const start = Number(offset) || 0;
  const page = rows.slice(start, start + 100).map((record) => ({
    id: record.id,
    fields: Object.fromEntries(Object.entries(record.fields).filter(([key]) => !wanted.length || wanted.includes(key))),
  }));
  return json({ records: page, ...(start + 100 < rows.length ? { offset: String(start + 100) } : {}) });
}

function readParams(method, url, body) {
  return method === "POST"
    ? { formula: body?.filterByFormula || null, offset: body?.offset, wanted: body?.fields || [] }
    : { formula: url.searchParams.get("filterByFormula"), offset: url.searchParams.get("offset"), wanted: url.searchParams.getAll("fields[]") };
}

export function fakeAirtable({ fields = TABLE_FIELDS, records = [] } = {}) {
  const table = { fields: fields.map((field) => ({ ...field })), records: new Map() };
  let nextId = 0;
  const newId = () => `rec${String(++nextId).padStart(14, "0")}`;
  for (const record of records) {
    const id = record.id || newId();
    table.records.set(id, { id, fields: { ...record.fields } });
  }
  const log = [];
  // Test hooks: fail the next N record writes with this status.
  const failures = [];

  function validate(fieldsById) {
    for (const [fieldId, value] of Object.entries(fieldsById || {})) {
      const field = table.fields.find((candidate) => candidate.id === fieldId);
      if (!field) return `Unknown field ${fieldId}`;
      if (field.type === "number" && typeof value !== "number") return `${field.name} must be a number`;
      if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return `${field.name} must be a date`;
      if (String(value).includes("REJECT-ME")) return `${field.name} value rejected`;
    }
    return null;
  }

  async function handle(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    const path = url.pathname;
    log.push({ method, path, body });

    if (path === "/v0/meta/whoami") return json({ id: "usrTEST", email: "ops@example.com", scopes: [] });
    if (path === "/v0/meta/bases") return json({ bases: [{ id: BASE_ID, name: "Deal flow", permissionLevel: "create" }] });
    if (path === `/v0/meta/bases/${BASE_ID}/tables`) {
      return json({ tables: [{ id: TABLE_ID, name: "People", primaryFieldId: "fldName", fields: table.fields }] });
    }
    if (path === `/v0/meta/bases/${BASE_ID}/tables/${TABLE_ID}/fields` && method === "POST") {
      const field = { id: `fld${body.name.replace(/\W/g, "")}`, ...body };
      table.fields.push(field);
      return json(field);
    }
    const listing = path === `/v0/${BASE_ID}/${TABLE_ID}/listRecords` && method === "POST";
    if (path !== `/v0/${BASE_ID}/${TABLE_ID}` && !listing) return json({ error: "NOT_FOUND" }, 404);

    if (method === "GET" || listing) return listPage([...table.records.values()], table.fields, readParams(method, url, body));

    if (failures.length) {
      const status = failures.shift();
      return json({ error: { type: "TEST_FAILURE", message: "injected" } }, status, status === 429 ? { "retry-after": "0" } : {});
    }
    if (!Array.isArray(body?.records) || body.records.length > 10) {
      return json({ error: { type: "INVALID_REQUEST", message: "1–10 records per request" } }, 422);
    }
    for (const record of body.records) {
      const problem = validate(record.fields);
      if (problem) return json({ error: { type: "INVALID_VALUE_FOR_COLUMN", message: problem } }, 422);
    }
    if (method === "POST") {
      const created = body.records.map((record) => {
        const id = newId();
        table.records.set(id, { id, fields: { ...record.fields } });
        return { id, fields: record.fields };
      });
      return json({ records: created });
    }
    if (method === "PATCH") {
      if (body.records.some((record) => !table.records.has(record.id))) {
        return json({ error: { type: "ROW_DOES_NOT_EXIST", message: "Record not found" } }, 404);
      }
      return json({
        records: body.records.map((record) => {
          const row = table.records.get(record.id);
          Object.assign(row.fields, record.fields);
          return row;
        }),
      });
    }
    return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  }

  const writes = () => log.filter((entry) => entry.path === `/v0/${BASE_ID}/${TABLE_ID}` && entry.method !== "GET");
  const byLinkedIn = () => new Map([...table.records.values()].map((record) => [record.fields.fldLinkedIn, record]));
  return { handle, table, log, writes, byLinkedIn, failures };
}

const READ_ONLY = new Set(["formula", "rollup", "multipleLookupValues", "createdTime", "createdBy", "lastModifiedTime", "count", "autoNumber"]);

/**
 * A whole base: several tables, each strict like the real API. Writing a
 * computed field, linking to a record that doesn't exist in the linked table,
 * or sending more than 10 records is a 422; DELETE is refused outright, since
 * nothing in this extension may ever delete.
 */
export function fakeBase({ baseId = BASE_ID, tables }) {
  const state = new Map();
  let nextId = 0;
  const newId = () => `rec${String(++nextId).padStart(14, "0")}`;
  for (const table of tables) {
    const records = new Map();
    for (const record of table.records || []) {
      const id = record.id || newId();
      records.set(id, { id, fields: { ...record.fields } });
    }
    state.set(table.id, { ...table, records });
  }
  const log = [];
  // Test hook: the next N creates save their records, then answer 500 — the
  // "did it land?" case that must not turn into duplicates.
  // partialAttachments: the next N writes land but report their attachments
  // failed. lockedFields: columns this user can't write (403, like Airtable).
  const faults = { saveThenFail: 0, nonCollaborators: new Set(), partialAttachments: 0, lockedFields: new Set() };

  // Attachments read back the way Airtable returns its own copies.
  let nextAttachment = 0;
  function stored(table, fields) {
    const out = { ...fields };
    for (const [fieldId, value] of Object.entries(out)) {
      if (table.fields.find((field) => field.id === fieldId)?.type !== "multipleAttachments") continue;
      out[fieldId] = value.map((item) => ({ id: `att${++nextAttachment}`, url: `https://v5.airtableusercontent.com/${nextAttachment}`,
        filename: item.filename || "file", source: item.url }));
    }
    return out;
  }

  function validate(table, fields, typecast) {
    for (const [fieldId, value] of Object.entries(fields || {})) {
      const field = table.fields.find((candidate) => candidate.id === fieldId);
      if (!field) return `Unknown field ${fieldId} in ${table.name}`;
      if (READ_ONLY.has(field.type)) return `${table.name}.${field.name} is computed and can't be written`;
      if (field.type === "multipleRecordLinks") {
        const target = state.get(field.options.linkedTableId);
        if (!Array.isArray(value) || value.some((id) => !target.records.has(id))) {
          return `${table.name}.${field.name} links to a record that isn't in ${target.name}`;
        }
      }
      if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return `${field.name} must be a date`;
      if (field.type === "checkbox" && typeof value !== "boolean") return `${field.name} must be a boolean`;
      if (field.type === "singleSelect" || field.type === "multipleSelects") {
        const choices = field.options?.choices || [];
        for (const name of [].concat(value)) {
          if (choices.some((choice) => choice.name === name)) continue;
          if (!typecast) return { type: "INVALID_MULTIPLE_CHOICE_OPTIONS", message: `Insufficient permissions to create new select option ""${name}""` };
          field.options = { ...field.options, choices: [...choices, { id: `sel${name}`, name }] };
        }
      }
      if (field.type === "multipleAttachments") {
        const bad = !Array.isArray(value) || value.some((item) => !/^https:\/\//.test(item?.url || "")
          || Object.keys(item).some((key) => key !== "url" && key !== "filename"));
        if (bad) return `${field.name} takes [{url, filename?}]`;
      }
      if (field.type === "multipleCollaborators") {
        if (!Array.isArray(value) || value.some((user) => !user?.id && !user?.email)) return `${field.name} takes [{id}] or [{email}]`;
        const outsider = value.find((user) => faults.nonCollaborators.has(user.id || user.email));
        // Airtable's real answer names neither the user nor "collaborator".
        if (outsider) return { type: "INVALID_VALUE_FOR_COLUMN", message: `Cannot parse value "[object Object]" for field ${field.name}` };
      }
    }
    return null;
  }

  async function handle(input, init = {}) {
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    const path = url.pathname;
    log.push({ method, path, body, query: url.search });
    if (method === "DELETE") throw new Error(`DELETE ${path}: the extension must never delete`);

    if (path === "/v0/meta/whoami") return json({ id: "usrTEST", email: "ops@example.com", scopes: [] });
    if (path === "/v0/meta/bases") return json({ bases: [{ id: baseId, name: "Test base", permissionLevel: "create" }] });
    if (path === `/v0/meta/bases/${baseId}/tables`) {
      return json({ tables: [...state.values()].map(({ id, name, fields }) => ({ id, name, primaryFieldId: fields[0].id, fields })) });
    }
    const match = path.match(new RegExp(`^/v0/${baseId}/([^/]+)(/listRecords)?$`));
    const table = match && state.get(match[1]);
    if (!table) return json({ error: "NOT_FOUND" }, 404);
    const listing = Boolean(match[2]);
    if (listing && method !== "POST") return json({ error: "NOT_FOUND" }, 404);

    if (method === "GET" || listing) return listPage([...table.records.values()], table.fields, readParams(method, url, body));
    const locked = body?.records?.flatMap((record) => Object.keys(record.fields || {})).find((fieldId) => faults.lockedFields.has(fieldId));
    if (locked) {
      const field = table.fields.find((candidate) => candidate.id === locked);
      return json({ error: { type: "INVALID_PERMISSIONS", message: `You are not permitted to write cell values in field ${field.name} (${field.id})` } }, 403);
    }
    if (!Array.isArray(body?.records) || body.records.length > 10) {
      return json({ error: { type: "INVALID_REQUEST", message: "1–10 records per request" } }, 422);
    }
    for (const record of body.records) {
      const problem = validate(table, record.fields, body.typecast === true);
      if (problem) {
        const error = typeof problem === "string" ? { type: "INVALID_VALUE_FOR_COLUMN", message: problem } : problem;
        return json({ error }, 422);
      }
    }
    if (method === "POST") {
      const created = body.records.map((record) => {
        const id = newId();
        table.records.set(id, { id, fields: stored(table, record.fields) });
        return { id, fields: record.fields };
      });
      if (faults.saveThenFail > 0) {
        faults.saveThenFail--;
        return json({ error: { type: "SERVER_ERROR", message: "saved, then failed" } }, 500);
      }
      return json({ records: created, ...partial(table, created) });
    }
    if (method === "PATCH") {
      if (body.records.some((record) => !table.records.has(record.id))) {
        return json({ error: { type: "ROW_DOES_NOT_EXIST", message: "Record not found" } }, 404);
      }
      return json({
        records: body.records.map((record) => {
          const row = table.records.get(record.id);
          Object.assign(row.fields, stored(table, record.fields));
          return row;
        }),
        ...partial(table, body.records),
      });
    }
    return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  }

  /** Airtable's 200-with-details when attachments didn't make it: the cells stay empty. */
  function partial(table, records) {
    const attachmentIds = table.fields.filter((field) => field.type === "multipleAttachments").map((field) => field.id);
    if (!faults.partialAttachments || !records.some((record) => attachmentIds.some((id) => id in (record.fields || {})))) return {};
    faults.partialAttachments--;
    for (const record of records) {
      const row = table.records.get(record.id);
      for (const id of attachmentIds) if (row) delete row.fields[id];
    }
    return { details: { message: "partialSuccess", reasons: ["attachmentsFailedUploading"] } };
  }

  // Collaborator cells read back the way Airtable returns them: with names.
  const readable = (value) => (Array.isArray(value) && value[0] && typeof value[0] === "object" && ("id" in value[0] || "email" in value[0])
    ? value.map((user) => ({ id: user.id || `usr${String(user.email).replace(/\W/g, "").slice(0, 14)}`, email: user.email || `${user.id}@example.com`, name: "Someone" }))
    : value);
  const rows = (tableId) => [...state.get(tableId).records.values()];
  const writes = (tableId) => log.filter((entry) => entry.path.endsWith(`/${tableId}`) && entry.method !== "GET");
  return { handle, state, log, rows, writes, faults, readable };
}
