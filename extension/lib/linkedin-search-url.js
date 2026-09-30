/**
 * A LinkedIn people-search URL (linkedin.com/search/results/people/?…), built
 * by applying filters on LinkedIn, → the Voyager facets it sets. Covers the
 * filters with no name lookup (locations especially: LinkedIn's location
 * typeahead is not a public endpoint any more).
 */

// Id-valued facets, as the URL spells them: geoUrn=["102277331"].
const LIST_FACETS = {
  geoUrn: /^\d+$/,
  currentCompany: /^\d+$/,
  pastCompany: /^\d+$/,
  schoolFilter: /^\d+$/,
  industry: /^\d+$/,
  serviceCategory: /^\d+$/,
  network: /^[FSO]$/,
  connectionOf: /^[A-Za-z0-9_-]+$/,
  profileLanguage: /^[a-z]{2}$/,
};

// Text filters: URL param → Voyager facet. Checked live; titleFreeText's
// own name is silently ignored by Voyager, `title` is what filters.
const TEXT_FACETS = { firstName: "firstName", lastName: "lastName", titleFreeText: "title", company: "company" };

export function parseSearchUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("searchUrl isn't a URL.");
  }
  if (!/(^|\.)linkedin\.com$/.test(url.hostname) || !url.pathname.startsWith("/search/results/people")) {
    throw new Error("searchUrl must be a LinkedIn people search (linkedin.com/search/results/people/?…).");
  }
  const facets = {};
  for (const [key, valid] of Object.entries(LIST_FACETS)) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    let values;
    try {
      values = JSON.parse(raw);
    } catch {
      values = raw.split(",");
    }
    values = (Array.isArray(values) ? values : [values]).map(String).filter((item) => valid.test(item));
    if (values.length) facets[key] = values;
  }
  for (const [param, key] of Object.entries(TEXT_FACETS)) {
    const text = url.searchParams.get(param)?.trim();
    if (text) facets[key] = [text.slice(0, 100)];
  }
  return { keywords: url.searchParams.get("keywords")?.trim().slice(0, 200) || "", facets };
}
