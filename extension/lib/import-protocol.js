export const PEOPLE_IMPORT_CHECKSUM_ALGORITHM = "sha256-canonical-json-v1";
export const LINKEDIN_PAGE_SIZE = 100;
export const LINKEDIN_PAGES_PER_CHUNK = 1;
export const LINKEDIN_CHUNK_SIZE = LINKEDIN_PAGE_SIZE * LINKEDIN_PAGES_PER_CHUNK;

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalizeJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : canonicalizeJson(item));
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalizeJson(value[key]);
    }
    return result;
  }
  throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalizeJson(value));
}

export async function sha256CanonicalRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError("rows must be an array");
  const bytes = new TextEncoder().encode(canonicalJson(rows));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.ceil(Number(trimmed) * 1000));
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

export function classifyRetry(status, operation = "request") {
  if (status === 0 || status === 429 || status >= 500) return "retryable";
  if (status === 401 || status === 403) return "auth";
  if (status === 409) return operation === "complete" ? "status_required" : "conflict";
  if (status === 400 || status === 404) return "hard";
  return status >= 400 ? "hard" : "none";
}

export function computeBackoffMs(attempt, options = {}) {
  const {
    retryAfterMs = null,
    baseMs = 1_000,
    maxMs = 30_000,
    maxRetryAfterMs = 120_000,
    jitterRatio = 0.25,
    random = Math.random,
  } = options;
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(maxRetryAfterMs, Math.ceil(retryAfterMs));
  }
  const exponential = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt)));
  const jitter = 1 - jitterRatio + (2 * jitterRatio * random());
  return Math.max(0, Math.min(maxMs, Math.round(exponential * jitter)));
}

export function blockStartOffset(sequence) {
  if (!Number.isInteger(sequence) || sequence < 0) throw new RangeError("sequence must be non-negative");
  return sequence * LINKEDIN_CHUNK_SIZE;
}

export function blockSequenceForOffset(offset) {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError("offset must be non-negative");
  return Math.floor(offset / LINKEDIN_CHUNK_SIZE);
}

export function pageOffsetsForBlock(sequence, totalRows) {
  const start = blockStartOffset(sequence);
  const offsets = [];
  for (let page = 0; page < LINKEDIN_PAGES_PER_CHUNK; page++) {
    const offset = start + page * LINKEDIN_PAGE_SIZE;
    if (Number.isFinite(totalRows) && totalRows >= 0 && offset >= totalRows) break;
    offsets.push(offset);
  }
  return offsets;
}

export function orderBlockPages(pages) {
  return [...pages]
    .sort((left, right) => left.offset - right.offset)
    .flatMap((page) => page.rows);
}

export function planResumeSequences(status, totalChunks) {
  const nextExpected = Math.max(0, Number(status?.nextExpectedSequence) || 0);
  const received = new Set(
    Array.isArray(status?.receivedSequences)
      ? status.receivedSequences.filter((value) => Number.isInteger(value) && value >= nextExpected)
      : [],
  );
  const pending = [];
  for (let sequence = nextExpected; sequence < totalChunks; sequence++) {
    if (!received.has(sequence)) pending.push(sequence);
  }
  return { nextExpected, received, pending };
}

export const PEOPLE_IMPORT_KEY_MAX_LENGTH = 128;

/**
 * The clientImportKey one capture attempt opens its import under.
 *
 * The server treats clientImportKey as an idempotency key: replaying it is
 * only legal while every material parameter (expectedRows, sourceCursor) still
 * matches the stored import, and it answers 409 otherwise. Those parameters are
 * all per-attempt — the cursor carries the run id, and LinkedIn's own
 * connection count drifts between attempts — so a key shared across attempts is
 * guaranteed to be rejected eventually, which is the failure this scoping
 * exists to make impossible. Folding the run id in leaves exactly one kind of
 * replay: the byte-identical transport retry inside a single send, which is
 * what the key is actually for.
 *
 * `baseKey` stays the durable, run-independent identity the checkpoint carries
 * for its enrichment batches; only what is sent on create is scoped.
 *
 * Returns null when neither half survives sanitizing, which callers must send
 * as an omitted field rather than an explicit null: the server's schema takes
 * the key as optional, and an explicit null fails validation outright.
 */
export function peopleImportKeyForRun(baseKey, runId) {
  // The server's key alphabet is narrower than a run id's, which may be
  // supplied by the caller that requested the sync, and it additionally
  // requires an alphanumeric first character. Anything outside that would be
  // rejected as a 400 — a worse failure than the one being fixed.
  const clean = (value) => String(value || "")
    .replace(/[^A-Za-z0-9._:-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  const base = clean(baseKey);
  const run = clean(runId);
  if (!base) return run.slice(0, PEOPLE_IMPORT_KEY_MAX_LENGTH) || null;
  if (!run) return base.slice(0, PEOPLE_IMPORT_KEY_MAX_LENGTH);
  // Truncate the run half rather than the whole string, so the base key — the
  // half that identifies the checkpoint — always survives intact.
  const room = PEOPLE_IMPORT_KEY_MAX_LENGTH - base.length - 1;
  return room <= 0 ? base.slice(0, PEOPLE_IMPORT_KEY_MAX_LENGTH) : `${base}:${run.slice(0, room)}`;
}
