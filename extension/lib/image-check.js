/**
 * Airtable downloads attachment URLs after the write returns, so a dead link
 * would leave an empty or broken cell. Each image is fetched here first; one
 * that doesn't load is left out of that record's write.
 */

const LOG = (...args) => console.log("[Airtable:Images]", ...args);
const TIMEOUT_MS = 8_000;
const CONCURRENCY = 6;

// HEAD first; some CDNs refuse or mishandle it, so a ranged GET gets the last word.
async function defaultCheck(url) {
  for (const init of [{ method: "HEAD" }, { method: "GET", headers: { Range: "bytes=0-0" } }]) {
    try {
      const response = await fetch(url, { ...init, credentials: "omit", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const type = response.headers.get("content-type") || "";
      if (response.ok && (!type || /^image\//i.test(type))) return true;
    } catch { /* try the next method */ }
  }
  return false;
}

let check = defaultCheck;

/** Tests swap in their own; null restores the real one. */
export function setImageChecker(fn) {
  check = typeof fn === "function" ? fn : defaultCheck;
}

/**
 * Drop every attachment cell in `items[].fields` (only `fieldIds`) whose image
 * doesn't load. `onDropped(item, fieldId)` hears about each one.
 */
export async function dropBrokenImages(items, fieldIds, onDropped = () => {}) {
  const ids = new Set(fieldIds.filter(Boolean));
  if (!ids.size) return;
  const cells = [];
  for (const item of items) {
    for (const fieldId of ids) {
      const value = item.fields?.[fieldId];
      if (Array.isArray(value) && value.length) cells.push({ item, fieldId, urls: value.map((entry) => entry?.url) });
    }
  }
  const results = new Map();
  const urls = [...new Set(cells.flatMap((cell) => cell.urls))];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const loaded = await Promise.all(batch.map((url) => (url ? check(url).catch(() => false) : false)));
    batch.forEach((url, index) => results.set(url, loaded[index]));
  }
  for (const cell of cells) {
    if (cell.urls.every((url) => results.get(url))) continue;
    delete cell.item.fields[cell.fieldId];
    onDropped(cell.item, cell.fieldId);
  }
  const dropped = cells.filter((cell) => !(cell.fieldId in cell.item.fields)).length;
  if (dropped) LOG(`Skipped ${dropped} image(s) that didn't load`);
}
