/**
 * Log interaction: one Interactions row per click, plus one Notes row when a
 * note was typed. Create-only, by field id, typecast off. Nothing here edits
 * or deletes a row.
 */
import { createRecords, listRecords } from "./airtable-client.js";

export const INTERACTIONS = {
  table: "tblSi5wF9IbWk2n9V",
  summary: "fldJLoGwBMaRGz6tS",
  types: "fldFQxQNzkie9HtKb",
  at: "fldqtHc2kMFmSrZrw",
  person: "fldkWiOVO5Wn9i6iR",
  note: "fldxCMCW76gLG7EfY",
};

export const NOTES = {
  table: "tblxIl1sNemDmkl1g",
  text: "fldqUcXvJMCcoCagi",
  person: "fld14DfOrMdGbHQoI",
  at: "fldORmJeacH1XVFVV",
};

export const INTERACTION_TYPES = ["Calls", "DM", "Email", "Lunch", "Dinner", "Coffee", "Event Attendee"];

const NOTE_MAX = 100_000;

/** Which of the two tables this base has, with every column written and links pointing where expected. */
export function interactionTables(baseTables, peopleTableId) {
  const table = (id) => (baseTables || []).find((candidate) => candidate.id === id);
  const has = (found, ids) => Boolean(found) && ids.every((id) => found.fields.some((field) => field.id === id));
  const linksTo = (found, fieldId, target) => {
    const linked = found?.fields.find((field) => field.id === fieldId)?.options?.linkedTableId;
    return !linked || linked === target;
  };
  const interactions = table(INTERACTIONS.table);
  const notes = table(NOTES.table);
  const interactionsOk = has(interactions, [INTERACTIONS.summary, INTERACTIONS.types, INTERACTIONS.at, INTERACTIONS.person])
    && linksTo(interactions, INTERACTIONS.person, peopleTableId);
  return {
    interactions: interactionsOk,
    notes: interactionsOk && has(interactions, [INTERACTIONS.note]) && linksTo(interactions, INTERACTIONS.note, NOTES.table)
      && has(notes, [NOTES.text, NOTES.person, NOTES.at]) && linksTo(notes, NOTES.person, peopleTableId),
  };
}

/** The panel's form, checked: known types in pick order, a UTC instant, a trimmed note or null. */
export function interactionEntry({ types, at, note }) {
  const picked = [...new Set(Array.isArray(types) ? types : [])];
  if (picked.length === 0) throw new Error("Pick at least one type.");
  const unknown = picked.find((type) => !INTERACTION_TYPES.includes(type));
  if (unknown) throw new Error(`"${unknown}" isn't an interaction type.`);
  const when = new Date(at);
  if (!at || Number.isNaN(when.getTime())) throw new Error("Pick when it happened.");
  const text = typeof note === "string" ? note.trim() : "";
  if (text.length > NOTE_MAX) throw new Error("The note is too long for Airtable.");
  return { types: picked, at: when.toISOString(), note: text || null };
}

export function interactionSummary(types, name) {
  return `${types.join(" + ")} with ${name}`;
}

const quote = (text) => `"${text.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\n")}"`;
const sameMinute = (value, iso) => Math.abs(Date.parse(value) - Date.parse(iso)) < 60_000;
const linksTo = (value, recordId) => Array.isArray(value) && value.includes(recordId);

/**
 * A row this very log may already have made: one whose create timed out or
 * hit a 5xx could have landed. Matched on its text, person, and time.
 */
async function findLanded(config, table, { textField, text, personField, personId, atField, at }) {
  const needle = text.split("\n")[0].trim().toLowerCase().slice(0, 60);
  const records = await listRecords(config.token, config.baseId, table, {
    fieldIds: [textField, personField, atField],
    formula: `FIND(${quote(needle)}, LOWER({${textField}}))`,
  });
  return records.find((record) => String(record.fields?.[textField] ?? "").trim() === text
    && linksTo(record.fields?.[personField], personId)
    && sameMinute(record.fields?.[atField], at))?.id || null;
}

/** Create one row. An unclear outcome is checked in the table before anyone sends it again. */
async function createOnce(config, table, fields, match, { retry }) {
  if (retry) {
    const landed = await findLanded(config, table, match);
    if (landed) return landed;
  }
  try {
    const [record] = await createRecords(config.token, config.baseId, table, [{ fields }], { typecast: false });
    return record.id;
  } catch (error) {
    if (!error?.ambiguous) throw error;
    const landed = await findLanded(config, table, match).catch(() => null);
    if (landed) return landed;
    throw error;
  }
}

/**
 * Notes row (when there's a note and no `noteId` from an earlier try), then
 * the Interactions row. A failure after the note landed carries `noteId`, so
 * Retry reuses that note instead of writing a second one. `retry` looks for
 * rows an earlier, unclear attempt may have made before creating.
 */
export async function logInteraction(config, { personId, name, types, at, note, noteId = null, retry = false }) {
  if (note && !noteId) {
    noteId = await createOnce(config, NOTES.table, {
      [NOTES.text]: note,
      [NOTES.person]: [personId],
      [NOTES.at]: at,
    }, { textField: NOTES.text, text: note, personField: NOTES.person, personId, atField: NOTES.at, at }, { retry });
  }
  const summary = interactionSummary(types, name);
  try {
    const interactionId = await createOnce(config, INTERACTIONS.table, {
      [INTERACTIONS.summary]: summary,
      [INTERACTIONS.types]: types,
      [INTERACTIONS.at]: at,
      [INTERACTIONS.person]: [personId],
      ...(noteId ? { [INTERACTIONS.note]: [noteId] } : {}),
    }, { textField: INTERACTIONS.summary, text: summary, personField: INTERACTIONS.person, personId, atField: INTERACTIONS.at, at },
    { retry });
    return { interactionId, noteId, summary };
  } catch (error) {
    if (noteId) error.noteId = noteId;
    throw error;
  }
}
