/**
 * LinkedIn images, downloaded here so their bytes can be uploaded to Airtable.
 * Handing Airtable the CDN URL instead doesn't work: it fetches the URL later,
 * from its own servers, and quietly drops the attachment when LinkedIn's CDN
 * refuses it — which is most of the time.
 */

const TIMEOUT_MS = 8_000;
const CONCURRENCY = 6;
// Airtable's uploadAttachment limit.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function defaultFetch(url) {
  try {
    const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim();
    if (!response.ok || !/^image\//i.test(contentType)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length && bytes.length <= MAX_IMAGE_BYTES ? { contentType, bytes } : null;
  } catch {
    return null;
  }
}

let fetcher = defaultFetch;

/** Tests swap in their own; null restores the real one. */
export function setImageFetcher(fn) {
  fetcher = typeof fn === "function" ? fn : defaultFetch;
  held.clear();
}

// Downloads a check kept for the upload that follows it, so an image is fetched once.
const held = new Map();
const HELD_MAX = 50;

/** `{ contentType, bytes }` for an image that loads, else null. */
export async function fetchImage(url) {
  if (held.has(url)) {
    const file = held.get(url);
    held.delete(url);
    return file;
  }
  return fetcher(url).catch(() => null);
}

/**
 * Drop every attachment cell in `items[].fields` (only `fieldIds`) whose image
 * doesn't download. `onDropped(item, fieldId)` hears about each one.
 */
export async function dropBrokenImages(items, fieldIds, onDropped = () => {}) {
  const ids = new Set(fieldIds.filter(Boolean));
  const cells = items.flatMap((item) => [...ids]
    .filter((fieldId) => Array.isArray(item.fields?.[fieldId]) && item.fields[fieldId].length)
    .map((fieldId) => ({ item, fieldId, urls: item.fields[fieldId].map((entry) => entry?.url) })));
  const urls = [...new Set(cells.flatMap((cell) => cell.urls))];
  const loaded = new Map();
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const files = await Promise.all(batch.map((url) => (url ? fetcher(url).catch(() => null) : null)));
    batch.forEach((url, index) => loaded.set(url, files[index]));
  }
  for (const [url, file] of loaded) {
    if (!file) continue;
    held.set(url, file);
    if (held.size > HELD_MAX) held.delete(held.keys().next().value);
  }
  for (const cell of cells) {
    if (cell.urls.every((url) => loaded.get(url))) continue;
    delete cell.item.fields[cell.fieldId];
    onDropped(cell.item, cell.fieldId);
  }
}
