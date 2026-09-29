/**
 * Airtable Web API client: personal access token auth, the 5 requests/second
 * per base limit, and the retry policy a multi-hour sync needs.
 *
 * Token scopes the extension uses:
 *   data.records:read, data.records:write, schema.bases:read
 *   schema.bases:write (only to create missing columns; also needs creator access)
 *   user.email:read (only to show "Syncing as" with an email)
 */

import { computeBackoffMs, parseRetryAfter } from "./import-protocol.js";
import { fetchImage } from "./image-check.js";

export const AIRTABLE_API = "https://api.airtable.com/v0";
export const AIRTABLE_CONTENT_API = "https://content.airtable.com/v0";
export const RECORDS_PER_REQUEST = 10;

const LOG = (...args) => console.log("[Airtable]", ...args);

// Airtable allows 5 requests/second per base and answers a burst with a 429
// that costs 30 seconds. Spacing requests is far cheaper than earning one.
const MIN_SPACING_MS = 220;
const RATE_LIMIT_WAIT_MS = 30_000;
const TIMEOUT_MS = 30_000;
const MAX_SERVER_ATTEMPTS = 5;
const MAX_NETWORK_ATTEMPTS = 10;
const UPLOAD_CONCURRENCY = 5;

export class AirtableError extends Error {
  constructor(message, { status = 0, type = null, retryAfterMs = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AirtableError";
    this.status = status;
    this.type = type;
    this.retryAfterMs = retryAfterMs;
    // A 403 naming one column ("not permitted to write cell values in field …")
    // is that column being locked, not the token being bad.
    this.code = status === 401 || (status === 403 && !lockedFieldOf(message)) ? "auth" : status === 0 ? "network" : "http";
  }
}

/** The field a 403 says can't be written, as "Name (fldXXXXXXXXXXXXXX)" or a bare id; else null. */
export function lockedFieldOf(message) {
  const text = String(message || "");
  if (!/permitted to write cell values in field/i.test(text)) return null;
  return text.match(/\((fld[A-Za-z0-9]{14})\)/)?.[1] || text.match(/in field "?([^"(]+?)"?\s*(?:\(|$)/i)?.[1]?.trim() || null;
}

let nextSlotAt = 0;

async function takeSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlotAt - now);
  nextSlotAt = Math.max(now, nextSlotAt) + MIN_SPACING_MS;
  if (wait > 0) await sleep(wait);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(status, body) {
  const error = body?.error;
  const type = typeof error === "string" ? error : error?.type || null;
  const detail = typeof error === "object" ? error?.message : null;
  if (status === 401) return { type, message: "Airtable rejected the token. Paste a valid personal access token." };
  if (status === 403) {
    return {
      type,
      message: detail
        || "The token can't do this. Give it the data.records:read/write and schema.bases:read scopes and access to this base.",
    };
  }
  if (status === 404) return { type, message: detail || "Airtable couldn't find that base, table, or record." };
  if (status === 413) return { type, message: "The request was too large for Airtable." };
  if (status === 422) return { type, message: detail ? `Airtable rejected the data: ${detail}` : "Airtable rejected the data." };
  if (status === 429) return { type, message: "Airtable is rate limiting requests." };
  return { type, message: detail || `Airtable returned ${status}.` };
}

async function once(token, path, { method = "GET", body, query, origin = AIRTABLE_API } = {}) {
  const url = new URL(`${origin}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  await takeSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (response.ok) return data ?? {};
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const { type, message } = describe(response.status, data);
    throw new AirtableError(message, {
      status: response.status,
      type,
      retryAfterMs: response.status === 429 ? retryAfterMs ?? RATE_LIMIT_WAIT_MS : retryAfterMs,
    });
  } catch (error) {
    if (error instanceof AirtableError) throw error;
    const timedOut = error?.name === "AbortError";
    throw new AirtableError(
      timedOut ? "Airtable didn't answer in time." : "Couldn't reach Airtable. Check the connection.",
      { status: 0, cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One Airtable call, retried through rate limits, 5xx, and dropped connections.
 *
 * `blindRetry: false` is for creates. A 429 is safe to retry (Airtable did
 * nothing), but a timeout, a dropped connection, or a 5xx may have landed the
 * records anyway, and sending them again would make duplicates. Those throw
 * with `ambiguous: true` so the caller can check the table first.
 */
export async function airtableRequest(token, path, options = {}) {
  const { blindRetry = true, ...requestOptions } = options;
  if (!token) throw new AirtableError("Connect Airtable first.", { status: 401 });
  let serverAttempts = 0;
  let networkAttempts = 0;
  while (true) {
    try {
      return await once(token, path, requestOptions);
    } catch (error) {
      const { status } = error;
      if (!blindRetry && (status === 0 || status >= 500)) {
        error.ambiguous = true;
        throw error;
      }
      if (status === 429) {
        serverAttempts++;
        if (serverAttempts >= MAX_SERVER_ATTEMPTS) throw error;
        LOG(`Rate limited; waiting ${Math.round(error.retryAfterMs / 1000)}s`);
        nextSlotAt = Date.now() + error.retryAfterMs;
        continue;
      }
      if (status >= 500) {
        serverAttempts++;
        if (serverAttempts >= MAX_SERVER_ATTEMPTS) throw error;
        await sleep(computeBackoffMs(serverAttempts - 1, { retryAfterMs: error.retryAfterMs }));
        continue;
      }
      if (status === 0) {
        networkAttempts++;
        if (networkAttempts >= MAX_NETWORK_ATTEMPTS) throw error;
        await sleep(computeBackoffMs(networkAttempts - 1, { maxMs: 15_000 }));
        continue;
      }
      throw error;
    }
  }
}

// ─── Meta ────────────────────────────────────────────────────────────────────

export function whoami(token) {
  return airtableRequest(token, "/meta/whoami");
}

export async function listBases(token) {
  const bases = [];
  let offset;
  do {
    const page = await airtableRequest(token, "/meta/bases", { query: { offset } });
    bases.push(...(page.bases || []));
    offset = page.offset;
  } while (offset);
  return bases;
}

export async function listTables(token, baseId) {
  const data = await airtableRequest(token, `/meta/bases/${encodeURIComponent(baseId)}/tables`);
  return data.tables || [];
}

export function createField(token, baseId, tableId, spec) {
  return airtableRequest(
    token,
    `/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/fields`,
    { method: "POST", body: spec },
  );
}

// ─── Records ─────────────────────────────────────────────────────────────────

function tablePath(baseId, tableId) {
  return `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`;
}

/**
 * Every record's id and the given fields, keyed by field id. A filtered read
 * goes as POST …/listRecords: a long formula in the URL can pass Airtable's
 * 16,000-character limit.
 */
export async function listRecords(token, baseId, tableId, { fieldIds = [], formula = null } = {}) {
  const page = (offset) => (formula
    ? airtableRequest(token, `${tablePath(baseId, tableId)}/listRecords`, {
      method: "POST",
      body: { pageSize: 100, returnFieldsByFieldId: true, fields: fieldIds, filterByFormula: formula, ...(offset ? { offset } : {}) },
    })
    : airtableRequest(token, tablePath(baseId, tableId), {
      query: { pageSize: 100, returnFieldsByFieldId: "true", "fields[]": fieldIds, offset },
    }));
  for (let attempt = 0; ; attempt++) {
    const records = [];
    let offset;
    try {
      do {
        const data = await page(offset);
        records.push(...(data.records || []));
        offset = data.offset;
      } while (offset);
      return records;
    } catch (error) {
      // A long read outlived Airtable's page cursor: start over, once.
      if (attempt > 0 || error?.type !== "LIST_RECORDS_ITERATOR_NOT_AVAILABLE") throw error;
    }
  }
}

/**
 * Up to RECORDS_PER_REQUEST records: [{ fields }] → created records. With
 * `typecast` off, select values must be existing choices exactly.
 */
export async function createRecords(token, baseId, tableId, records, { typecast = true } = {}) {
  const { sent, uploads } = takeUploads(records);
  const data = await airtableRequest(token, tablePath(baseId, tableId), {
    method: "POST",
    body: { records: sent, typecast, returnFieldsByFieldId: true },
    blindRetry: false,
  });
  return withUploads(token, baseId, data, uploads);
}

/** Up to RECORDS_PER_REQUEST records: [{ id, fields }] → updated records. */
export async function updateRecords(token, baseId, tableId, records, { typecast = true } = {}) {
  const { sent, uploads } = takeUploads(records);
  const changed = sent.filter((record) => Object.keys(record.fields || {}).length);
  const data = changed.length
    ? await airtableRequest(token, tablePath(baseId, tableId), {
      method: "PATCH",
      body: { records: changed, typecast, returnFieldsByFieldId: true },
    })
    : {};
  // A record that only had images to add isn't sent; it answers as itself.
  const byId = new Map((data.records || []).map((record) => [record.id, record]));
  return withUploads(token, baseId, { ...data, records: sent.map((record) => byId.get(record.id) || { id: record.id, fields: {} }) }, uploads);
}

// ─── Images ──────────────────────────────────────────────────────────────────

const LINKEDIN_IMAGE = /^https:\/\/([a-z0-9-]+\.)*licdn\.com\//i;

/** An attachment cell of LinkedIn images: [{ url, filename? }]. */
function linkedinImages(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => item && typeof item === "object" && LINKEDIN_IMAGE.test(String(item.url || "")));
}

/**
 * LinkedIn images come out of the write and are uploaded by their bytes after
 * it: given the URL, Airtable fetches it later and silently drops the
 * attachment when LinkedIn's CDN refuses it. Callers only ever fill blank
 * attachment cells, which is what an upload (it appends) does.
 */
function takeUploads(records) {
  const uploads = [];
  const sent = records.map((record, index) => {
    const fields = { ...(record.fields || {}) };
    for (const [fieldId, value] of Object.entries(fields)) {
      if (!linkedinImages(value)) continue;
      delete fields[fieldId];
      uploads.push({ index, fieldId, images: value });
    }
    return { ...record, fields };
  });
  return { sent, uploads };
}

function base64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** One image into one record's attachment cell. */
export function uploadAttachment(token, baseId, recordId, fieldId, { contentType, bytes, filename }) {
  return airtableRequest(token, `/${encodeURIComponent(baseId)}/${encodeURIComponent(recordId)}/${encodeURIComponent(fieldId)}/uploadAttachment`, {
    method: "POST",
    origin: AIRTABLE_CONTENT_API,
    body: { contentType, file: base64(bytes), filename },
    // A retry after an unknown outcome could attach it twice; the next sync sees the cell instead.
    blindRetry: false,
  });
}

/**
 * Upload each record's images once the write has landed. One that doesn't
 * download or upload is reported as Airtable reports an attachment it couldn't
 * fetch (a partial success), so the caller tries it again next sync.
 */
async function withUploads(token, baseId, data, uploads) {
  const records = withDetails(data);
  if (!uploads.length) return records;
  const urls = [...new Set(uploads.flatMap((upload) => upload.images.map((image) => image.url)))];
  const downloaded = new Map(await Promise.all(urls.map(async (url) => [url, await fetchImage(url)])));
  let failed = 0;
  // Cells upload side by side (takeSlot still paces them); a cell's own images go in order.
  const queue = [...uploads];
  const worker = async () => {
    for (let upload = queue.shift(); upload; upload = queue.shift()) {
      const { index, fieldId, images } = upload;
      const record = records[index];
      if (!record?.id) continue;
      for (const image of images) {
        const file = downloaded.get(image.url);
        try {
          if (!file) throw new Error("the image didn't download");
          const result = await uploadAttachment(token, baseId, record.id, fieldId, { ...file, filename: image.filename || "image.jpg" });
          record.fields = { ...record.fields, [fieldId]: result?.fields?.[fieldId] || [] };
        } catch (error) {
          failed++;
          LOG(`Couldn't add an image to ${record.id}; trying again next sync:`, error?.message || error);
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, uploads.length) }, worker));
  if (failed && !attachmentsFailed(records)) {
    Object.defineProperty(records, "details", {
      value: { message: "partialSuccess", reasons: ["attachmentsFailedUploading"] },
      configurable: true,
    });
  }
  return records;
}

/**
 * The records, carrying Airtable's `details` when it answered 200 with a
 * partial success (an attachment it couldn't upload, say).
 */
function withDetails(data) {
  const records = data.records || [];
  if (data.details) Object.defineProperty(records, "details", { value: data.details });
  return records;
}

/** A write that landed without some of its attachments. */
export function attachmentsFailed(records) {
  const details = records?.details;
  return details?.message === "partialSuccess"
    && (details.reasons || []).some((reason) => /attachment/i.test(String(reason)));
}

/** The given fields of specific records, by id (at most 10 per call keeps the URL short). */
export async function getRecordsByIds(token, baseId, tableId, ids, { fieldIds = [] } = {}) {
  if (ids.length === 0) return [];
  const formula = `OR(${ids.map((id) => `RECORD_ID()='${String(id).replace(/[^A-Za-z0-9]/g, "")}'`).join(",")})`;
  return listRecords(token, baseId, tableId, { fieldIds, formula });
}
