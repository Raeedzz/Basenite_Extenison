/**
 * Add to mandate: link a People row into one Mandates row as a potential
 * candidate (and, when asked, as reached out). Written on the person's side
 * by field id, typecast off: a read of their current links, then one PATCH
 * with the union. Nothing here unlinks or deletes.
 */
import { getRecordsByIds, listRecords, updateRecords } from "./airtable-client.js";

export const MANDATES = {
  table: "tblUl0esQs2LtWViB",
  name: "fldQNLOMAtAeiXiRZ",
  status: "fldsUBofuap1d2tGc",
  created: "fldgv7exDzXjwRVx6",
};

// The People side of the two links, and the person's pipeline stage.
export const PEOPLE_MANDATES = {
  candidate: "fldZ46oT2zY4lcVpd",
  reachedOut: "fldL6Vs5tuPkHmBOF",
  status: "fld0PeH9nOJZygVfv",
};

// Filled and Closed are done; anything else (no status yet included) is open.
const DONE = new Set(["Filled", "Closed"]);
const ORDER = ["Live", "On hold", ""];

/** Whether this base has the Mandates table and both People links pointing at it. */
export function mandatesReady(baseTables, peopleTableId) {
  const table = (id) => (baseTables || []).find((candidate) => candidate.id === id);
  const field = (found, id) => found?.fields.find((each) => each.id === id);
  const mandates = table(MANDATES.table);
  const people = table(peopleTableId);
  return Boolean(field(mandates, MANDATES.name))
    && [PEOPLE_MANDATES.candidate, PEOPLE_MANDATES.reachedOut]
      .every((id) => field(people, id)?.options?.linkedTableId === MANDATES.table);
}

const statusName = (value) => (typeof value === "string" ? value : value?.name) || "";

/** Open mandates, Live first, then newest: [{ id, name, status }]. */
export async function listMandates(config) {
  const records = await listRecords(config.token, config.baseId, MANDATES.table, {
    fieldIds: [MANDATES.name, MANDATES.status, MANDATES.created],
  });
  return records
    .map((record) => ({
      id: record.id,
      name: String(record.fields?.[MANDATES.name] ?? "").trim(),
      status: statusName(record.fields?.[MANDATES.status]),
      created: Date.parse(record.fields?.[MANDATES.created] || record.createdTime) || 0,
    }))
    .filter((mandate) => mandate.name && !DONE.has(mandate.status))
    .sort((a, b) => rank(a.status) - rank(b.status) || b.created - a.created)
    .map(({ id, name, status }) => ({ id, name, status }));
}

function rank(status) {
  const at = ORDER.indexOf(status);
  return at === -1 ? ORDER.length : at;
}

/** The mandates this person is linked to: { candidate: [id], reachedOut: [id], status }. */
export async function personMandates(config, personId) {
  const [record] = await getRecordsByIds(config.token, config.baseId, config.tableId, [personId], {
    fieldIds: Object.values(PEOPLE_MANDATES),
  });
  if (!record) throw new Error("Their People row is gone.");
  const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
  return {
    candidate: ids(record.fields?.[PEOPLE_MANDATES.candidate]),
    reachedOut: ids(record.fields?.[PEOPLE_MANDATES.reachedOut]),
    status: statusName(record.fields?.[PEOPLE_MANDATES.status]),
  };
}

/**
 * The person's stage after this add, or null to leave it: only ever moved
 * forward from empty / Potential candidate, never over a later stage.
 */
export function nextStatus(current, reachedOut) {
  if (reachedOut) return !current || current === "Potential candidate" ? "Reached out" : null;
  return current ? null : "Potential candidate";
}

/**
 * Link the person into the mandate. Already linked answers `added: false`.
 * The stage write is separate and best-effort: a renamed choice mustn't undo
 * the link that already landed.
 */
export async function addToMandate(config, { personId, mandateId, reachedOut = false }) {
  const current = await personMandates(config, personId);
  const fields = {};
  if (!current.candidate.includes(mandateId)) fields[PEOPLE_MANDATES.candidate] = [...current.candidate, mandateId];
  if (reachedOut && !current.reachedOut.includes(mandateId)) fields[PEOPLE_MANDATES.reachedOut] = [...current.reachedOut, mandateId];
  const added = Object.keys(fields).length > 0;
  if (added) await updateRecords(config.token, config.baseId, config.tableId, [{ id: personId, fields }], { typecast: false });
  const status = added ? nextStatus(current.status, reachedOut) : null;
  let statusWarning = null;
  if (status) {
    await updateRecords(config.token, config.baseId, config.tableId, [{ id: personId, fields: { [PEOPLE_MANDATES.status]: status } }], { typecast: false })
      .catch((error) => { statusWarning = `Added, but Mandate status wasn't set: ${error?.message || error}`; });
  }
  return {
    added,
    candidate: [...new Set([...current.candidate, mandateId])],
    reachedOut: reachedOut ? [...new Set([...current.reachedOut, mandateId])] : current.reachedOut,
    status: status && !statusWarning ? status : current.status,
    warning: statusWarning,
  };
}
