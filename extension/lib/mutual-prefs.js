/**
 * Find mutuals settings: how many of a profile's mutuals to read from
 * LinkedIn, and whether a mutual who isn't in People gets a row there.
 */

export const MUTUAL_PREFS_KEY = "mutual_prefs";
export const DEFAULT_MAX_MUTUALS = 50;
export const MAX_MUTUALS_LIMIT = 500;

export function normalizeMutualPrefs(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const max = Number(source.maxPerProfile);
  return {
    maxPerProfile: Number.isInteger(max) ? Math.max(1, Math.min(MAX_MUTUALS_LIMIT, max)) : DEFAULT_MAX_MUTUALS,
    createPeople: source.createPeople === true,
  };
}

export async function readMutualPrefs() {
  const stored = await chrome.storage.local.get(MUTUAL_PREFS_KEY);
  return normalizeMutualPrefs(stored[MUTUAL_PREFS_KEY]);
}
