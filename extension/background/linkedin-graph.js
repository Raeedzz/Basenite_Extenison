/**
 * LinkedIn graph engine — runs inside the background service worker.
 *
 * Mutual-connection discovery, people search, profile enrichment, company
 * 2nd-degree capture, and the reviewed one-to-one message path. Sending
 * connection invitations was removed — see capture-results.js for why.
 * Previously a content script injected into a linkedin.com tab;
 * like the capture engine it only ever spoke to Voyager over fetch, so the tab
 * was pure overhead. Cookies and the CSRF token now come from the cookie jar.
 *
 * The stealth pacing (gaussian delays, rotating headers, long pauses) is
 * unchanged — it is about how often LinkedIn is called, not about where the
 * call is made from.
 */

import {
  getCsrfToken,
  linkedinUrl as voyagerUrl,
  LinkedInSessionError,
} from "../lib/linkedin-session.js";
// Degree parsing is its own module because it is the one field a shape change
// can silently zero out without anything else looking broken.
import { readProfileDegree } from "../lib/linkedin-degree.js";
import { isPlaceholderImage } from "../lib/airtable-fields.js";
import { formatCount, positionPhrase, remainingCount, waitMessage } from "../lib/progress-copy.js";
import {
  setCompanyProgress,
  setMutualProgress,
} from "./capture-state.js";
import {
  saveBridgeResults,
  saveCompanyResults,
} from "./capture-results.js";

const engine = (function () {
  const LOG_LEVEL = "info"; // "debug" for development
  const LOG = (...args) => console.log("[EarthOS:LI:MUT]", ...args);
  const DEBUG = (...args) => LOG_LEVEL === "debug" && console.log("[EarthOS:LI:MUT]", ...args);
  const ERR = (...args) => console.error("[EarthOS:LI:MUT]", ...args);


  // ─── Constants ──────────────────────────────────────────────────────────────

  // LinkedIn bumps the decoration version every few weeks; when it drifts
  // stale the endpoint 400s. Try each in order — first one that returns 200
  // wins and is memoized for the rest of the session.
  const SEARCH_DECORATIONS = [
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-202",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-200",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-198",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-196",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-194",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-192",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-190",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-188",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-186",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-184",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-182",
    "com.linkedin.voyager.dash.deco.search.SearchClusterCollection-180",
  ];
  let SEARCH_DECORATION = SEARCH_DECORATIONS[0];
  const PER_PAGE = 49;
  const PAGE_DELAY_MS = [800, 1500];
  const TARGET_DELAY_MS = [1500, 3000];
  const LONG_PAUSE_MS = [5000, 8000];
  const LONG_PAUSE_EVERY = 15; // + up to 10 random
  const PROFILE_RETRY_WAIT = 1500;

  // ─── Stealth Helpers (gaussian delay, rotating headers) ─────────────────────

  function humanDelay(minMs, maxMs) {
    const mean = (minMs + maxMs) / 2;
    const stddev = (maxMs - minMs) / 6;
    const u1 = Math.random();
    const u2 = Math.random();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const delay = Math.max(minMs, Math.min(maxMs, mean + normal * stddev));
    return new Promise((r) => setTimeout(r, delay));
  }

  let _requestCount = 0;
  function shouldTakeLongPause() {
    _requestCount++;
    if (_requestCount >= LONG_PAUSE_EVERY + Math.floor(Math.random() * 10)) {
      _requestCount = 0;
      return true;
    }
    return false;
  }

  function _randomHex(len) {
    return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }

  // No x-li-track.
  //
  // This header used to carry a randomized clientVersion ("1.13." + a random
  // four digits). Voyager now validates it: a request whose declared client
  // version is not a real one is answered 200 with `paging.total: 0` and an
  // empty element list — not an error, not a 403, just nothing. Every people
  // search, bridge lookup, and company capture therefore reported "Found 0
  // people" while the account, the cookie, the decoration, and the parser were
  // all fine, which is exactly why it went unnoticed.
  //
  // Verified against the live endpoint, same query and cookie, one header
  // apart: without x-li-track, paging.total is 250 and seven entities come
  // back; with the invented version, paging.total is 0. The other headers are
  // unaffected — x-li-page-instance is a per-request tracking id, not a claim
  // about the client, and it changes nothing either way.
  //
  // Sending a truthful version instead would work too, but it has to be kept
  // in step with whatever LinkedIn is shipping this week; omitting the header
  // asserts nothing and cannot go stale.
  function stealthHeaders(csrfToken) {
    return {
      "csrf-token": csrfToken,
      "x-restli-protocol-version": "2.0.0",
      "x-li-lang": "en_US",
      "x-li-page-instance": `urn:li:page:d_flagship3_search_srp_people;${_randomHex(12)}`,
    };
  }

  // ─── Token + URL Helpers ────────────────────────────────────────────────────

  // The page read this from document.cookie on every call. The worker resolves
  // it once per task through primeCsrfToken() and the synchronous accessor
  // below keeps every existing call site unchanged.
  let cachedCsrfToken = null;

  async function primeCsrfToken() {
    cachedCsrfToken = await getCsrfToken({ force: true });
    return cachedCsrfToken;
  }

  function extractCsrfToken() {
    if (!cachedCsrfToken) {
      throw new LinkedInSessionError(
        "You're signed out of LinkedIn. Open linkedin.com, sign in, then try again.",
        "signed_out",
      );
    }
    return cachedCsrfToken;
  }

  function extractPublicId(linkedinUrl) {
    if (!linkedinUrl) return null;
    const m = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // In a content script this guarded against an orphaned page whose
  // chrome.runtime had been torn down by an extension reload. The engine now
  // runs inside that runtime, so the guard is always satisfied.
  function isContextValid() {
    return true;
  }

  // ─── API Fetch ──────────────────────────────────────────────────────────────

  // Every Voyager call gets a hard deadline. Without it, one hung LinkedIn
  // response stalls the whole search/enrich/capture task forever — the
  // service worker never gets a reply and the app spins until its own
  // timeout with no explanation. TIMEOUT propagates like any other
  // per-request error (skip the profile / fail the task with a message).
  const FETCH_TIMEOUT_MS = 20000;

  async function timedFetch(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(voyagerUrl(url), { ...options, signal: controller.signal });
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("TIMEOUT");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function apiFetch(url, headers) {
    const resp = await timedFetch(url, { headers, credentials: "include" });
    if (resp.status === 429) throw new Error("RATE_LIMITED");

    if (resp.status === 403) {
      const body = await resp.json().catch(() => ({ message: "" }));
      if (body.message?.includes("can't be accessed") || body.message?.includes("cannot be accessed")) {
        throw new Error("PROFILE_INACCESSIBLE");
      }
      // Session 403 — retry once with a genuinely fresh CSRF token. The cached
      // token is primed once per task, so re-read the cookie here: LinkedIn
      // rotating JSESSIONID mid-task is exactly the case this retry exists for.
      await new Promise((r) => setTimeout(r, PROFILE_RETRY_WAIT));
      const freshCsrf = await primeCsrfToken();
      const freshHeaders = { ...headers, "csrf-token": freshCsrf };
      const retryResp = await timedFetch(url, { headers: freshHeaders, credentials: "include" });
      if (retryResp.status === 401 || retryResp.status === 403) throw new Error("SESSION_EXPIRED");
      if (!retryResp.ok) throw new Error(`API_ERROR_${retryResp.status}`);
      return retryResp.json();
    }

    if (resp.status === 401) throw new Error("SESSION_EXPIRED");
    if (!resp.ok) throw new Error(`API_ERROR_${resp.status}`);
    return resp.json();
  }

  /**
   * Wraps apiFetch with auto-fallback through SEARCH_DECORATIONS on 4xx.
   * On first success, memoizes the working decoration for the rest of the
   * session. Only used for the Voyager /search/dash/clusters endpoint, which
   * is the version-sensitive one — /identity/dash/profiles is stable.
   */
  async function searchApiFetch(urlBuilder) {
    // Fast path: we've already found a working decoration this session.
    let lastErr;
    for (let i = 0; i < SEARCH_DECORATIONS.length; i++) {
      const deco = SEARCH_DECORATIONS[i];
      const url = urlBuilder(deco);
      try {
        const csrfToken = extractCsrfToken();
        const data = await apiFetch(url, stealthHeaders(csrfToken));
        // Record the winner so subsequent calls go straight to it — promoting
        // it to index 0 means the next target skips 4xx retries entirely.
        if (SEARCH_DECORATION !== deco) {
          LOG(`Voyager decoration ${deco} accepted (was ${SEARCH_DECORATION})`);
          SEARCH_DECORATION = deco;
          SEARCH_DECORATIONS.splice(i, 1);
          SEARCH_DECORATIONS.unshift(deco);
        }
        return data;
      } catch (err) {
        const msg = err?.message || String(err);
        lastErr = err;
        // Session / rate limit / access errors aren't decoration-version
        // issues — propagate them immediately so the caller can react.
        if (msg === "SESSION_EXPIRED" || msg === "RATE_LIMITED" || msg === "PROFILE_INACCESSIBLE") {
          throw err;
        }
        // Only 400/404 indicate a stale decoration. Other statuses (5xx,
        // network) are probably transient — also propagate.
        if (!/^API_ERROR_(400|404)$/.test(msg)) {
          throw err;
        }
        DEBUG(`decoration ${deco} rejected (${msg}), trying next`);
      }
    }
    throw lastErr || new Error("ALL_DECORATIONS_REJECTED");
  }

  // ─── Parsers ────────────────────────────────────────────────────────────────

  /**
   * Deep-search an object tree for the first `vectorImage`-like node.
   * Voyager keeps moving the image payload between
   * `image.attributes[0].detailDataUnion.*.vectorImage`,
   * `entityLockup.image.attributes[0]...`, `image.attributes[0].imageUrl`,
   * raw `image.vectorImage`, etc. Rather than enumerate every known path —
   * which is a losing game — do a bounded DFS and take the first match.
   *
   * Current (2026-04) shape: `rootUrl` is an empty string and
   * `fileIdentifyingUrlPathSegment` holds the full CDN URL. We accept any
   * node with a non-empty `artifacts` array and defer URL assembly to the
   * caller, which handles both the legacy `rootUrl + segment` split and the
   * new "segment is already absolute" case.
   */
  // Artifacts that can make a URL; the widest of these is the one used.
  function withPath(artifacts) {
    const usable = artifacts.filter((a) => a?.fileIdentifyingUrlPathSegment);
    return usable.length ? usable : artifacts;
  }

  function findVectorImage(node, depth) {
    if (!node || typeof node !== "object" || depth > 12) return null;
    // Accept anything with an artifacts array — let extractPhotoUrl figure
    // out whether the segments are absolute URLs or need rootUrl prepended.
    if (Array.isArray(node.artifacts) && node.artifacts.length > 0 &&
        (typeof node.rootUrl === "string"
          || node.artifacts.some((a) => /^https?:\/\//.test(a?.fileIdentifyingUrlPathSegment || "")))) {
      return node;
    }
    if (node.vectorImage) {
      const vi = findVectorImage(node.vectorImage, depth + 1);
      if (vi) return vi;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") {
        const found = findVectorImage(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Recursively scan an object tree for any string value that looks like a
   * LinkedIn CDN photo URL. Used as a last resort when findVectorImage
   * doesn't locate a canonical vectorImage node — newer Voyager shapes are
   * increasingly shipping direct `imageUrl` / `ghostImage` / `rootUrl`
   * strings instead of the old rootUrl+artifacts pair.
   */
  function findCdnUrlString(node, depth) {
    if (!node || depth > 12) return null;
    if (typeof node === "string") {
      return /^https:\/\/([a-z0-9-]+\.)*licdn\.com\/[^\s"'<>]+$/i.test(node) && !isPlaceholderImage(node) ? node : null;
      return null;
    }
    if (typeof node !== "object") return null;
    for (const k of Object.keys(node)) {
      const v = node[k];
      const found = findCdnUrlString(v, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // One-shot dump of the first unrecognized image shape so we can adapt if
  // LinkedIn changes the wire format again. Stays silent in production once
  // extraction succeeds at least once.
  let _loggedMissingImage = false;

  function extractPhotoUrl(image) {
    if (!image) return null;
    // Direct-string case: some newer Voyager shapes just return an absolute
    // CDN URL. Pass it through so the downstream img proxy can resize it.
    if (typeof image === "string" && image.startsWith("http")) return isPlaceholderImage(image) ? null : image;

    const vi = findVectorImage(image, 0);
    if (vi) {
      const best = withPath(vi.artifacts).reduce(
        (b, a) => ((a.width || 0) > (b.width || 0) ? a : b),
        withPath(vi.artifacts)[0]
      );
      const seg = best?.fileIdentifyingUrlPathSegment;
      if (seg) {
        // Current Voyager shape: seg is already an absolute URL and rootUrl
        // is "". Legacy shape: seg is a path and rootUrl is the CDN prefix.
        if (/^https?:\/\//.test(seg)) return seg;
        if (vi.rootUrl) return vi.rootUrl + seg;
      }
    }

    // Fallback: raw CDN URL string nested anywhere in the image subtree.
    const cdn = findCdnUrlString(image, 0);
    if (cdn) return cdn;

    if (!_loggedMissingImage) {
      _loggedMissingImage = true;
      try {
        LOG("Unrecognized image shape (first occurrence):", JSON.stringify(image).slice(0, 2000));
      } catch {}
    }
    return null;
  }

  function firstImageUrl(...candidates) {
    for (const candidate of candidates) {
      const url = extractPhotoUrl(candidate);
      if (url) return url;
    }
    return null;
  }

  // Airtable keeps its own copy of the logo, so take the largest artifact.
  function extractLogoUrl(candidate) {
    if (!candidate) return null;
    if (typeof candidate === "string" && candidate.startsWith("http")) return isPlaceholderImage(candidate) ? null : candidate;

    const vi = findVectorImage(candidate, 0);
    if (vi) {
      const chosen = withPath(vi.artifacts).reduce((best, a) => ((a.width || 0) > (best.width || 0) ? a : best), withPath(vi.artifacts)[0]);
      const seg = chosen?.fileIdentifyingUrlPathSegment;
      if (seg) {
        if (/^https?:\/\//.test(seg)) return seg;
        if (vi.rootUrl) return vi.rootUrl + seg;
      }
    }

    return findCdnUrlString(candidate, 0);
  }

  function firstLogoUrl(...candidates) {
    for (const candidate of candidates) {
      const url = extractLogoUrl(candidate);
      if (url) return url;
    }
    return null;
  }

  function extractCompanyLogoUrl(entity) {
    if (!entity || typeof entity !== "object") return null;
    return firstLogoUrl(
      entity.companyLogo,
      entity.companyLogoImage,
      entity.logo,
      entity.logoV2,
      entity.image,
      entity.company?.companyLogo,
      entity.company?.logo,
      entity.company?.logoV2,
      entity.company?.image,
    );
  }

  function extractSchoolLogoUrl(entity) {
    if (!entity || typeof entity !== "object") return "";
    return firstLogoUrl(
      entity.schoolLogo,
      entity.schoolLogoImage,
      entity.logo,
      entity.logoV2,
      entity.image,
      entity.school?.schoolLogo,
      entity.school?.logo,
      entity.school?.logoV2,
      entity.school?.image,
    ) || "";
  }

  /**
   * Company and school logos indexed by URN and by lower-cased name.
   *
   * A profile response carries the logo on a separate company or school
   * entity, not on the position or education entry referencing it, so an entry
   * parsed alone frequently has no logo. Both response formats need this: the
   * flat `included` array is one long list of those entities, and the Dash
   * decoration still ships an `included` alongside the nested profile often
   * enough to be worth reading.
   */
  function buildLogoLookups(entities) {
    const companyLogosByUrn = new Map();
    const companyLogosByName = new Map();
    const schoolLogosByUrn = new Map();
    const schoolLogosByName = new Map();
    for (const entity of Array.isArray(entities) ? entities : []) {
      if (!entity || typeof entity !== "object") continue;
      const type = entity["$type"] || "";
      if (/(?:Company|Organization)/.test(type) && !type.includes("Position")) {
        const logoUrl = extractCompanyLogoUrl(entity);
        const urn = companyUrnFor(entity, true);
        const name = entity.name || entity.companyName || "";
        if (logoUrl && urn) companyLogosByUrn.set(urn, logoUrl);
        if (logoUrl && name) companyLogosByName.set(name.toLowerCase(), logoUrl);
      }
      if (/(?:School|EducationInstitution|University)/.test(type)) {
        const logoUrl = extractSchoolLogoUrl(entity);
        const urn = schoolUrnFor(entity, true);
        const name = entity.name || entity.schoolName || "";
        if (logoUrl && urn) schoolLogosByUrn.set(urn, logoUrl);
        if (logoUrl && name) schoolLogosByName.set(name.toLowerCase(), logoUrl);
      }
    }
    return { companyLogosByUrn, companyLogosByName, schoolLogosByUrn, schoolLogosByName };
  }

  function companyUrnFor(entity, includeEntityUrn = false) {
    const candidates = [
      entity?.companyUrn,
      entity?.companyEntityUrn,
      entity?.company?.entityUrn,
      typeof entity?.company === "string" ? entity.company : "",
      includeEntityUrn ? entity?.entityUrn : "",
    ];
    return candidates.find((value) => typeof value === "string" && value) || "";
  }

  function schoolUrnFor(entity, includeEntityUrn = false) {
    const candidates = [
      entity?.schoolUrn,
      entity?.schoolEntityUrn,
      entity?.school?.entityUrn,
      typeof entity?.school === "string" ? entity.school : "",
      includeEntityUrn ? entity?.entityUrn : "",
    ];
    return candidates.find((value) => typeof value === "string" && value) || "";
  }

  /**
   * Extract the LinkedIn public id (slug after /in/) from any shape of
   * navigationUrl / navigationContext / trackingUrn the entity might carry.
   */
  function extractPublicIdFromEntity(entity) {
    const candidates = [
      entity?.navigationUrl,
      entity?.navigationContext?.actionTarget,
      entity?.navigationContext?.url,
      entity?.entityCustomTrackingInfo?.memberDistance,
      entity?.trackingUrn,
      entity?.entityUrn,
    ];
    for (const raw of candidates) {
      if (!raw || typeof raw !== "string") continue;
      const m = raw.match(/\/in\/([^/?#]+)/);
      if (m) return m[1];
    }
    return null;
  }

  function pickEntityResult(item) {
    // Voyager has shipped at least three wrappers over the years; try each.
    return (
      item?.itemUnion?.entityResult ||
      item?.item?.entityResult ||
      item?.entityResult ||
      item?.entityResultViewModel ||
      null
    );
  }

  function entityName(er) {
    return (
      er?.title?.text ||
      er?.title?.accessibilityText ||
      er?.entityLockup?.title?.text ||
      null
    );
  }

  function entityHeadline(er) {
    return (
      er?.primarySubtitle?.text ||
      er?.secondarySubtitle?.text ||
      er?.entityLockup?.subtitle?.text ||
      null
    );
  }

  function entityImage(er) {
    return er?.image || er?.entityLockup?.image || null;
  }

  /**
   * The viewer's connection degree to a search result — "1st" | "2nd" | "3rd"
   * or null when LinkedIn doesn't say (out-of-network results and the viewer's
   * own profile carry no usable distance).
   */
  function entityDegree(er) {
    const tracked = er?.entityCustomTrackingInfo?.memberDistance;
    const distance = typeof tracked === "string" ? tracked : tracked?.value || "";
    if (/DISTANCE_1\b/.test(distance)) return "1st";
    if (/DISTANCE_2\b/.test(distance)) return "2nd";
    if (/DISTANCE_3\b/.test(distance) || /OUT_OF_NETWORK/.test(distance)) return "3rd";
    const badge =
      er?.badgeText?.text ||
      er?.badgeText?.accessibilityText ||
      er?.entityLockup?.badgeText?.text ||
      "";
    const m = String(badge).match(/\b(1st|2nd|3rd)\b/);
    return m ? m[1] : null;
  }

  function parseSearchPeople(data) {
    const people = [];
    const elements = data?.elements || data?.data?.elements || [];
    for (const el of elements) {
      const items = el?.items || el?.itemsResolutionResults || [];
      for (const item of items) {
        const er = pickEntityResult(item);
        if (!er) continue;
        const name = entityName(er);
        if (!name) continue;
        const publicId = extractPublicIdFromEntity(er);
        if (!publicId) continue;
        people.push({
          name,
          headline: entityHeadline(er),
          linkedinUrl: `https://www.linkedin.com/in/${publicId}`,
          photoUrl: extractPhotoUrl(entityImage(er)),
          degree: entityDegree(er),
        });
      }
    }
    return people;
  }

  // Every result slot on a page, named or not. LinkedIn fills pages with
  // out-of-network "LinkedIn Member" rows parseSearchPeople rightly drops, so
  // paging has to advance and stop on these, never on the named count.
  function searchResultKeys(data, start) {
    const keys = [];
    const elements = data?.elements || data?.data?.elements || [];
    for (const el of elements) {
      const items = el?.items || el?.itemsResolutionResults || [];
      for (const item of items) {
        const er = pickEntityResult(item);
        // A member with no urn is keyed by position, so two of them on a page
        // are two slots, not one.
        if (er) keys.push(er.entityUrn || er.trackingUrn || `slot:${start + keys.length}`);
      }
    }
    return keys;
  }

  // ─── Core: Find Bridges for One Target ──────────────────────────────────────

  // Profile pictures on the /identity/dash/profiles response wrap the
  // vectorImage one level deeper than the search-result image shape — but
  // the deep finder in extractPhotoUrl already handles both; reuse it.
  function extractProfilePhotoUrl(profilePicture) {
    return extractPhotoUrl(profilePicture);
  }

  // ─── Full-profile Enrichment (ported from linkedin.js) ──────────────────────
  //
  // Both the mutuals-target and the Add-from-LinkedIn flow need the full
  // profile (experience, education, skills, …) — the linkedin.js enrichment
  // pass already does this for connections, so we copy its parser + fetcher
  // here. Keeping this co-located means the mutuals/add paths don't have to
  // cross-load the connections sync script.

  // Voyager's FullProfileWithEntities decoration returns every section we
  // need in one roundtrip. Version drift is handled the same way the search
  // endpoint handles it — we walk a small candidate list, memoize the one
  // that returns 200, and promote it to the front.
  const FULL_PROFILE_ENDPOINTS = [
    (id) => `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`,
    (id) => `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-92`,
    (id) => `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-94`,
    (id) => `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-95`,
    (id) => `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(id)}`,
    (id) => `/voyager/api/identity/profiles/${encodeURIComponent(id)}/profileView`,
  ];
  let _workingFullProfileIndex = 0;

  async function fetchFullProfile(publicId, csrfToken) {
    const headers = stealthHeaders(csrfToken);
    for (let i = _workingFullProfileIndex; i < FULL_PROFILE_ENDPOINTS.length; i++) {
      const url = FULL_PROFILE_ENDPOINTS[i](publicId);
      try {
        const data = await apiFetch(url, headers);
        if (i !== _workingFullProfileIndex) {
          LOG(`Full-profile endpoint #${i} works, caching for future calls`);
          _workingFullProfileIndex = i;
        }
        return data;
      } catch (err) {
        const msg = err?.message || String(err);
        // Only 404 / 410 indicate a dead endpoint — everything else (429,
        // 401, PROFILE_INACCESSIBLE, network) is orthogonal and propagates.
        if (/API_ERROR_(404|410)$/.test(msg)) continue;
        throw err;
      }
    }
    throw new Error("ALL_PROFILE_ENDPOINTS_REJECTED");
  }

  function _formatDate(dateObj) {
    if (!dateObj) return "";
    const y = dateObj.year;
    const m = dateObj.month;
    if (!y) return "";
    return m ? `${y}-${String(m).padStart(2, "0")}` : `${y}`;
  }

  function _parseExperience(entity, group = {}) {
    const company = entity.companyName || entity.company?.name || group.company || "";
    return {
      title: entity.title || "",
      company,
      companyUrn: companyUrnFor(entity) || group.companyUrn || "",
      companyLogoUrl: extractCompanyLogoUrl(entity) || group.companyLogoUrl || "",
      location: entity.locationName || entity.geoLocationName || "",
      startDate: _formatDate(entity.timePeriod?.startDate || entity.dateRange?.start),
      endDate: _formatDate(entity.timePeriod?.endDate || entity.dateRange?.end),
      description: entity.description || "",
      isCurrent: !!(entity.timePeriod && !entity.timePeriod.endDate) || !!(entity.dateRange && !entity.dateRange.end),
    };
  }

  function _parseEducation(entity, schoolDetails = {}) {
    const school = entity.schoolName || entity.school?.name || schoolDetails.school || "";
    return {
      school,
      schoolUrn: schoolUrnFor(entity) || schoolDetails.schoolUrn || "",
      schoolLogoUrl: extractSchoolLogoUrl(entity) || schoolDetails.schoolLogoUrl || "",
      degree: entity.degreeName || entity.degree || "",
      field: entity.fieldOfStudy || "",
      startDate: _formatDate(entity.timePeriod?.startDate || entity.dateRange?.start),
      endDate: _formatDate(entity.timePeriod?.endDate || entity.dateRange?.end),
    };
  }

  function _parseCertification(entity) {
    return {
      name: entity.name || "",
      issuingOrg: entity.authority || entity.company?.name || "",
      issueDate: _formatDate(entity.timePeriod?.startDate),
      expirationDate: _formatDate(entity.timePeriod?.endDate),
      credentialId: entity.licenseNumber || "",
    };
  }

  function _parseVolunteering(entity) {
    return {
      role: entity.role || entity.title || "",
      organization: entity.companyName || entity.company?.name || "",
      cause: entity.cause || "",
      startDate: _formatDate(entity.timePeriod?.startDate || entity.dateRange?.start),
      endDate: _formatDate(entity.timePeriod?.endDate || entity.dateRange?.end),
    };
  }

  /**
   * Parse a Voyager profile response into the graph-ready shape.
   * Returns { bio, location, industry, photoUrl, experience, education,
   * skills, languages, volunteering, certifications }.
   *
   * Mirrors linkedin.js's parseProfileView — kept inline here so linkedin-
   * mutuals.js doesn't depend on linkedin.js being injected too.
   */
  function parseFullProfile(data) {
    const result = {
      bio: "",
      location: "",
      industry: "",
      photoUrl: "",
      companyPhotoUrl: "",
      experience: [],
      education: [],
      skills: [],
      languages: [],
      volunteering: [],
      certifications: [],
    };
    if (!data) return result;

    // Dash endpoint — the FullProfileWithEntities decoration nests every
    // section directly under the profile root.
    if (data.elements && Array.isArray(data.elements) && data.elements.length > 0) {
      const profile = data.elements[0];
      result.bio = profile.summary || "";
      result.location =
        profile.geoLocation?.geo?.defaultLocalizedNameWithoutCountryName ||
        profile.address ||
        profile.locationName ||
        profile.geoLocationName ||
        "";
      result.industry = profile.industryName || profile.industry?.name || "";
      result.photoUrl = firstImageUrl(
        profile.profilePicture,
        profile.profilePictureDisplayImage,
        profile.displayPhoto,
      );

      // The Dash decoration nests the sections, but the logos still live on
      // company/school entities in the companion `included` array when there
      // is one. Reading it here is what stops this path from parsing an
      // experience list with every logo missing — which a later capture would
      // then merge over the top of a stored list that had them.
      const {
        companyLogosByUrn, companyLogosByName, schoolLogosByUrn, schoolLogosByName,
      } = buildLogoLookups(data.included);

      const posGroups = profile.profilePositionGroups?.elements || [];
      for (const group of posGroups) {
        const company = group.companyName || group.name || group.company?.name || "";
        const companyUrn = companyUrnFor(group);
        // _parseExperience prefers a logo on the position itself; this is the
        // fallback for the whole group.
        const companyLogoUrl = extractCompanyLogoUrl(group)
          || extractCompanyLogoUrl(group.company)
          || companyLogosByUrn.get(companyUrn)
          || companyLogosByName.get(company.toLowerCase())
          || "";
        const positions = group.profilePositionInPositionGroup?.elements || [];
        for (const pos of positions) {
          result.experience.push(_parseExperience(pos, { company, companyUrn, companyLogoUrl }));
        }
      }

      // The school details are resolved here rather than left to
      // _parseEducation's entity-only lookup, which on this path found neither
      // the logo nor the school URN.
      const eduEntries = profile.profileEducations?.elements || [];
      for (const edu of eduEntries) {
        const school = edu.schoolName || edu.school?.name || "";
        const schoolUrn = schoolUrnFor(edu);
        const schoolLogoUrl = extractSchoolLogoUrl(edu)
          || extractSchoolLogoUrl(edu.school)
          || schoolLogosByUrn.get(schoolUrn)
          || schoolLogosByName.get(school.toLowerCase())
          || "";
        result.education.push(_parseEducation(edu, { school, schoolUrn, schoolLogoUrl }));
      }

      const skillEntries = profile.profileSkills?.elements || [];
      for (const s of skillEntries) if (s.name) result.skills.push(s.name);

      const langEntries = profile.profileLanguages?.elements || [];
      for (const l of langEntries) if (l.name) result.languages.push(l.name);

      const certEntries = profile.profileCertifications?.elements || [];
      for (const c of certEntries) result.certifications.push(_parseCertification(c));

      const volEntries = profile.profileVolunteerExperiences?.elements || [];
      for (const v of volEntries) result.volunteering.push(_parseVolunteering(v));

      result.companyPhotoUrl = result.experience.find((entry) => entry.isCurrent && entry.companyLogoUrl)?.companyLogoUrl
        || result.experience.find((entry) => entry.companyLogoUrl)?.companyLogoUrl
        || "";
      return result;
    }

    // Legacy format with `included` flat array — fall through when the Dash
    // decoration isn't available.
    if (!data.included || !Array.isArray(data.included)) return result;
    const {
      companyLogosByUrn, companyLogosByName, schoolLogosByUrn, schoolLogosByName,
    } = buildLogoLookups(data.included);

    for (const entity of data.included) {
      const type = entity["$type"] || "";
      if (type.includes("Profile") && !type.includes("Position") && !type.includes("Education") &&
          !type.includes("Skill") && !type.includes("Language") && !type.includes("Certification") &&
          !type.includes("Volunteer")) {
        if (entity.summary && !result.bio) result.bio = entity.summary;
        if (entity.geoLocationName && !result.location) result.location = entity.geoLocationName;
        if (entity.locationName && !result.location) result.location = entity.locationName;
        if (entity.industryName && !result.industry) result.industry = entity.industryName;
        if (!result.photoUrl) {
          result.photoUrl = firstImageUrl(
            entity.profilePicture,
            entity.profilePictureDisplayImage,
            entity.displayPhoto,
          );
        }
      }
      if (type.includes("Position")) {
        const company = entity.companyName || entity.company?.name || "";
        const companyUrn = companyUrnFor(entity);
        const companyLogoUrl = extractCompanyLogoUrl(entity)
          || companyLogosByUrn.get(companyUrn)
          || companyLogosByName.get(company.toLowerCase())
          || "";
        result.experience.push(_parseExperience(entity, { company, companyUrn, companyLogoUrl }));
      }
      else if (type.includes("Education")) {
        const school = entity.schoolName || entity.school?.name || "";
        const schoolUrn = schoolUrnFor(entity);
        const schoolLogoUrl = extractSchoolLogoUrl(entity)
          || schoolLogosByUrn.get(schoolUrn)
          || schoolLogosByName.get(school.toLowerCase())
          || "";
        result.education.push(_parseEducation(entity, { school, schoolUrn, schoolLogoUrl }));
      }
      else if (type.includes("Skill")) { if (entity.name) result.skills.push(entity.name); }
      else if (type.includes("Language")) { if (entity.name) result.languages.push(entity.name); }
      else if (type.includes("Certification")) result.certifications.push(_parseCertification(entity));
      else if (type.includes("Volunteer")) result.volunteering.push(_parseVolunteering(entity));
    }
    result.companyPhotoUrl = result.experience.find((entry) => entry.isCurrent && entry.companyLogoUrl)?.companyLogoUrl
      || result.experience.find((entry) => entry.companyLogoUrl)?.companyLogoUrl
      || "";
    return result;
  }

  /**
   * Also pull the target's name/headline/memberId/connectionDegree out of
   * the same full-profile response. Returns { rawId, connectionDegree,
   * firstName, lastName, headline }.
   */
  function parseProfileIdentity(data, publicId) {
    const combined = [...(data?.elements || []), ...(data?.included || [])];
    // The degree can sit on a different element than the identity, so it is
    // read across the whole response rather than off whichever item happens
    // to carry the name.
    const connectionDegree = readProfileDegree(data);
    for (const item of combined) {
      const urnMatch = (item.entityUrn || "").match(/fsd_profile:([^,)]+)/);
      if (!urnMatch) continue;
      if (item.publicIdentifier !== publicId && !item.firstName) continue;
      return {
        rawId: urnMatch[1],
        connectionDegree,
        firstName: item.firstName || "",
        lastName: item.lastName || "",
        headline: item.headline || null,
      };
    }
    return null;
  }

  /**
   * The degree on its own, for when the full profile did not carry one.
   *
   * FullProfileWithEntities returns every section of somebody's profile and,
   * as of this writing, no relationship at all — so the top card is asked
   * instead. One small extra request, and only when the first response came
   * back without a degree: if Voyager starts including it again this stops
   * firing on its own.
   *
   * Never throws. A degree we cannot establish is null, which the writers
   * already treat as "no evidence" and leave alone; failing the whole capture
   * over it would trade a missing field for a missing person.
   */
  const TOP_CARD_DECORATIONS = [
    "com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-13",
    "com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-14",
    "com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-12",
  ];
  let _topCardIndex = 0;

  async function fetchProfileDegree(publicId, csrfToken) {
    const headers = stealthHeaders(csrfToken);
    for (let i = _topCardIndex; i < TOP_CARD_DECORATIONS.length; i++) {
      const url = `/voyager/api/identity/dash/profiles?q=memberIdentity`
        + `&memberIdentity=${encodeURIComponent(publicId)}`
        + `&decorationId=${encodeURIComponent(TOP_CARD_DECORATIONS[i])}`;
      try {
        const data = await apiFetch(url, headers);
        if (i !== _topCardIndex) _topCardIndex = i;
        return readProfileDegree(data);
      } catch (err) {
        const msg = err?.message || String(err);
        if (msg === "SESSION_EXPIRED" || msg === "RATE_LIMITED") return null;
        // Only a stale decoration is worth trying the next one for.
        if (!/^API_ERROR_(400|404)$/.test(msg)) return null;
      }
    }
    return null;
  }

  async function findBridgesForTarget(csrfToken, publicId, stopped = () => false) {
    // Step 1: Get target's rawMemberId, connection degree, and FULL profile
    // (experience/education/skills/…) — same endpoint the connections-sync
    // enrichment uses, so the out-of-network target lands in the graph
    // fully-populated instead of "Unknown title at Unknown company".
    const profileData = await fetchFullProfile(publicId, csrfToken);

    const identity = parseProfileIdentity(profileData, publicId);
    let rawId = identity?.rawId || null;
    // Same fallback as enrichOne: the mutuals target's own degree is half the
    // answer ("you are two hops from them, through these people"), so it is
    // worth one small extra request when the profile did not carry it.
    let connectionDegree = identity?.connectionDegree
      ?? (identity ? await fetchProfileDegree(publicId, csrfToken) : null);
    let profile = null;

    if (identity) {
      const name = [identity.firstName, identity.lastName].filter(Boolean).join(" ").trim();
      if (name) {
        const enrichment = parseFullProfile(profileData);
        profile = {
          name,
          headline: identity.headline,
          photoUrl: enrichment.photoUrl || null,
          companyPhotoUrl: enrichment.companyPhotoUrl || null,
          bio: enrichment.bio || null,
          industry: enrichment.industry || null,
          location: enrichment.location || null,
          experience: enrichment.experience,
          education: enrichment.education,
          skills: enrichment.skills,
          languages: enrichment.languages,
          volunteering: enrichment.volunteering,
          certifications: enrichment.certifications,
        };
      }
    }

    if (!rawId) {
      return {
        linkedinUrl: `https://www.linkedin.com/in/${publicId}`,
        connectionDegree: null,
        profile,
        bridges: [],
        totalBridges: 0,
      };
    }

    // Step 2: Find bridges (your 1st-degree connections who also know this target)
    //
    // Pagination is unbounded on our side — we follow LinkedIn's pagination
    // until it stops giving us full pages. LinkedIn's own search cap
    // (~1000 results) is what terminates us in practice, not anything here.
    // Two defensive guards are still worth having:
    //   - MAX_PAGES hard stop: prevents infinite loops if LinkedIn ever
    //     returns the same full page indefinitely (pagination cursor bug).
    //     100 pages × 49 = 4,900 bridges, well above LinkedIn's real cap.
    //   - All-duplicates guard: if every person on a page is already in
    //     `seen`, the cursor is stuck — bail out instead of spinning.
    const MAX_PAGES = 100;
    const allBridges = [];
    const seen = new Set();
    let start = 0;
    let totalBridges = 0;
    let pageCount = 0;

    while (true) {
      // Stopped from the panel: no more pages for this target.
      if (stopped()) break;
      const data = await searchApiFetch((deco) =>
        `/voyager/api/search/dash/clusters` +
        `?decorationId=${encodeURIComponent(deco)}` +
        `&origin=MEMBER_PROFILE_CANNED_SEARCH&q=all` +
        `&query=(flagshipSearchIntent:SEARCH_SRP,queryParameters:` +
        `(connectionOf:List(${encodeURIComponent(rawId)}),network:List(F),resultType:List(PEOPLE)))` +
        `&start=${start}&count=${PER_PAGE}`
      );

      if (start === 0) {
        totalBridges = data.metadata?.totalResultCount || 0;
        if (totalBridges > 0) LOG(`LinkedIn reports ${totalBridges} total mutual${totalBridges === 1 ? "" : "s"} for ${publicId}`);
      }

      const people = parseSearchPeople(data);
      if (people.length === 0) break;

      const before = allBridges.length;
      for (const p of people) {
        if (!seen.has(p.linkedinUrl)) {
          seen.add(p.linkedinUrl);
          allBridges.push(p);
        }
      }
      const added = allBridges.length - before;

      // All-duplicates page → pagination cursor is stuck. Bail.
      if (added === 0) {
        LOG(`Page at start=${start} returned only duplicates; stopping pagination`);
        break;
      }

      start += PER_PAGE;
      if (people.length < PER_PAGE) break;

      pageCount++;
      if (pageCount >= MAX_PAGES) {
        LOG(`Hit MAX_PAGES=${MAX_PAGES} for ${publicId}; stopping pagination at ${allBridges.length} bridges`);
        break;
      }

      await humanDelay(PAGE_DELAY_MS[0], PAGE_DELAY_MS[1]);
    }

    LOG(`Captured ${allBridges.length} bridge(s) for ${publicId}${totalBridges ? ` (LinkedIn said ${totalBridges})` : ""}`);

    return {
      linkedinUrl: `https://www.linkedin.com/in/${publicId}`,
      connectionDegree,
      profile,
      bridges: allBridges,
      totalBridges,
    };
  }

  // ─── Main: Process All Targets ──────────────────────────────────────────────

  async function processTargets(targets, run = _mutualRun) {
    const stopped = () => _mutualCancel || run !== _mutualRun;
    const progress = (...args) => { if (!stopped()) sendProgress(...args); };
    const fail = (message) => { if (!stopped()) sendError(message); };
    const csrfToken = extractCsrfToken();
    const results = [];
    // Track the first non-ignorable error so an all-zero run can be
    // reported as a real failure instead of a silent "0 mutuals".
    let firstApiError = null;

    for (let i = 0; i < targets.length; i++) {
      // Stopped from the panel: its progress already says so; send nothing more.
      if (stopped()) return;
      const t = targets[i];
      const publicId = extractPublicId(t.linkedinUrl);

      if (!publicId) {
        DEBUG(`Skipping ${t.linkedinUrl} — no publicId`);
        continue;
      }

      progress(`Checking ${publicId} for mutual connections…`, i, targets.length);

      try {
        const result = await findBridgesForTarget(csrfToken, publicId, stopped);
        results.push(result);
        progress(
          `${publicId}: ${result.bridges.length} mutual${result.bridges.length === 1 ? "" : "s"}`,
          i + 1,
          targets.length
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "SESSION_EXPIRED") {
          fail("LinkedIn session expired. Please refresh LinkedIn and try again.");
          return;
        }
        if (msg === "RATE_LIMITED") {
          // Back off and retry once
          LOG("Rate limited — waiting 30s before retry");
          progress(
            waitMessage("rate_limited", { seconds: 30, current: i, total: targets.length }),
            i,
            targets.length,
          );
          // A wait Stop can cut short, and no retry after it.
          for (let waited = 0; waited < 30000 && !stopped(); waited += 250) await new Promise((r) => setTimeout(r, 250));
          if (stopped()) return;
          try {
            const retryResult = await findBridgesForTarget(csrfToken, publicId, stopped);
            results.push(retryResult);
          } catch (retryErr) {
            ERR(`Retry failed for ${publicId}: ${retryErr.message}`);
            if (!firstApiError && retryErr?.message !== "PROFILE_INACCESSIBLE") {
              firstApiError = retryErr?.message || "RATE_LIMITED";
            }
            results.push({
              linkedinUrl: t.linkedinUrl,
              connectionDegree: null,
              bridges: [],
              totalBridges: 0,
            });
          }
        } else {
          // PROFILE_INACCESSIBLE and other errors — skip, continue. Record
          // the first non-"this profile isn't public" error so we can fail
          // loudly if *every* target fails the same way.
          LOG(`Skipping ${publicId}: ${msg}`);
          if (!firstApiError && msg !== "PROFILE_INACCESSIBLE") {
            firstApiError = msg;
          }
          results.push({
            linkedinUrl: t.linkedinUrl,
            connectionDegree: null,
            bridges: [],
            totalBridges: 0,
          });
        }
      }

      // Stealth delay between targets
      if (i < targets.length - 1) {
        if (shouldTakeLongPause()) {
          await humanDelay(LONG_PAUSE_MS[0], LONG_PAUSE_MS[1]);
        } else {
          await humanDelay(TARGET_DELAY_MS[0], TARGET_DELAY_MS[1]);
        }
      }
    }

    // All targets hit a real API error AND nothing returned bridges →
    // the run is useless. Surface the error so the app shows a proper
    // message instead of the current silent "done, 0 mutuals".
    const totalBridges = results.reduce((n, r) => n + (r?.bridges?.length || 0), 0);
    LOG(`Done scraping: ${results.length} target(s), ${totalBridges} total bridge(s) across all targets`);
    if (totalBridges === 0 && firstApiError) {
      const human = firstApiError.startsWith("API_ERROR_")
        ? `LinkedIn search rejected our request (${firstApiError}). The API may have changed — please update the extension.`
        : firstApiError === "ALL_DECORATIONS_REJECTED"
          ? "LinkedIn search API changed. Please update the extension."
          : firstApiError === "TIMEOUT"
            ? "LinkedIn stopped responding while finding mutuals. Try again in a minute."
            : `LinkedIn search failed: ${firstApiError}`;
      fail(human);
      return;
    }

    if (stopped()) return;
    sendResults(results);
  }

  // ─── Batch Profile Enrichment (used by Add-from-LinkedIn flow) ─────────────

  /**
   * Fetch + parse the full profile for each URL in parallel, matching the
   * connections-sync enrichment pass (5 concurrent fetches, short stealth
   * delay between chunks). 5× faster than serial for typical Add-picker
   * selections while staying well under LinkedIn's rate-limit budget.
   *
   * Returns `[{ linkedinUrl, name, headline, photoUrl, bio, industry,
   * location, experience, education, skills, languages, volunteering,
   * certifications }]` for every URL that resolved. Inaccessible /
   * rate-limited URLs are silently skipped so the caller still gets the
   * rest. A batch-wide 429 pauses the whole pool and retries once.
   */
  const ENRICH_PARALLEL = 5;

  async function enrichOne(publicId, csrfToken) {
    const data = await fetchFullProfile(publicId, csrfToken);
    const identity = parseProfileIdentity(data, publicId);
    if (!identity) return null;
    const name = [identity.firstName, identity.lastName].filter(Boolean).join(" ").trim();
    if (!name) return null;
    const enrichment = parseFullProfile(data);
    const connectionDegree = identity.connectionDegree
      ?? await fetchProfileDegree(publicId, csrfToken);
    return {
      linkedinUrl: `https://www.linkedin.com/in/${publicId}`,
      name,
      connectionDegree,
      headline: identity.headline,
      photoUrl: enrichment.photoUrl || null,
      companyPhotoUrl: enrichment.companyPhotoUrl || null,
      bio: enrichment.bio || null,
      industry: enrichment.industry || null,
      location: enrichment.location || null,
      experience: enrichment.experience,
      education: enrichment.education,
      skills: enrichment.skills,
      languages: enrichment.languages,
      volunteering: enrichment.volunteering,
      certifications: enrichment.certifications,
    };
  }

  async function enrichProfiles(urls) {
    const csrfToken = extractCsrfToken();
    const out = [];
    const failedUrls = urls.filter((url) => !extractPublicId(url));

    for (let i = 0; i < urls.length; i += ENRICH_PARALLEL) {
      const chunk = urls
        .slice(i, i + ENRICH_PARALLEL)
        .map((u) => ({ url: u, publicId: extractPublicId(u) }))
        .filter((x) => !!x.publicId);

      // Run the chunk in parallel. Settle individually so one failure
      // doesn't drop the whole batch. SESSION_EXPIRED bubbles up — nothing
      // downstream will work without a fresh session.
      const settled = await Promise.allSettled(
        chunk.map((x) => enrichOne(x.publicId, csrfToken))
      );

      let rateLimitedInChunk = false;
      const toRetry = [];
      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        if (r.status === "fulfilled") {
          if (r.value) out.push(r.value);
          else failedUrls.push(chunk[j].url);
        } else {
          const msg = r.reason?.message || String(r.reason);
          if (msg === "SESSION_EXPIRED") throw r.reason;
          if (msg === "RATE_LIMITED") {
            rateLimitedInChunk = true;
            toRetry.push(chunk[j]);
          } else {
            LOG(`Skipping enrichment for ${chunk[j].publicId}: ${msg}`);
            failedUrls.push(chunk[j].url);
          }
        }
      }

      // Batch-level backoff: any 429 in the chunk → wait 30s and retry just
      // the rate-limited entries. Avoids amplifying the penalty by
      // continuing to hammer LinkedIn with the next chunk.
      if (rateLimitedInChunk && toRetry.length > 0) {
        LOG(`Rate limited on ${toRetry.length} profile(s); backing off 30s`);
        await new Promise((r) => setTimeout(r, 30000));
        const retried = await Promise.allSettled(
          toRetry.map((x) => enrichOne(x.publicId, csrfToken))
        );
        for (let j = 0; j < retried.length; j++) {
          const r = retried[j];
          if (r.status === "fulfilled" && r.value) out.push(r.value);
          else {
            if (r.status === "rejected") {
              LOG(`Enrichment retry failed for ${toRetry[j].publicId}: ${r.reason?.message || r.reason}`);
            }
            failedUrls.push(toRetry[j].url);
          }
        }
      }

      // Stealth delay between chunks — mirrors the connections-sync
      // enrichment pass (800–1500ms normal distribution).
      if (i + ENRICH_PARALLEL < urls.length) {
        await humanDelay(PAGE_DELAY_MS[0], PAGE_DELAY_MS[1]);
      }
    }

    LOG(`Enriched ${out.length}/${urls.length} profile(s)`);
    return { profiles: out, failedUrls: [...new Set(failedUrls)] };
  }

  // ─── People Search (single-page, no filters) ────────────────────────────────

  // Same Voyager clusters endpoint as the bridge finder, just without the
  // connectionOf / network:F filters — runs a free-text name search across
  // all of LinkedIn. One request, no pagination; caller picks from ≤10 hits.
  async function searchPeople(query, limit) {
    const trimmed = (query || "").trim();
    if (trimmed.length < 2) throw new Error("Query too short");

    const count = Math.max(1, Math.min(limit || 10, 49));

    const data = await searchApiFetch((deco) =>
      `/voyager/api/search/dash/clusters` +
      `?decorationId=${encodeURIComponent(deco)}` +
      `&origin=GLOBAL_SEARCH_HEADER&q=all` +
      `&query=(keywords:${encodeURIComponent(trimmed)},` +
      `flagshipSearchIntent:SEARCH_SRP,` +
      `queryParameters:(resultType:List(PEOPLE)))` +
      `&start=0&count=${count}`
    );
    return parseSearchPeople(data);
  }

  // ─── Company Capture ────────────────────────────────────────────────────────
  //
  // Same Voyager machinery as the bridge finder, aimed at a company instead of a
  // person. Resolve the company name → numeric id, page the people-search
  // clusters endpoint filtered to currentCompany (1st/2nd/3rd degree, optionally
  // narrowed by role keywords), then enrich every result through the same
  // FullProfileWithEntities pass the connections sync uses — so each person
  // lands fully populated (experience/education/skills/…) instead of just a
  // headline. Streams
  // COMPANY_PROGRESS and finishes with COMPANY_RESULTS (or COMPANY_ERROR /
  // COMPANY_CANCELED) back to the service worker, which handles the upload.
  //
  // IMPORTANT: the Voyager query DSL must stay literal — parentheses, colons and
  // commas are NOT URL-encoded; only the values inside are. Encoding the whole
  // query string makes LinkedIn 400 every request.

  let _companyCancel = false;
  let _mutualCancel = false;
  // Each Find mutuals run has its own id: a run stopped and then replaced by a
  // new one sees the id change and stays stopped.
  let _mutualRun = 0;
  let _mutualActive = false;
  let _companyRunning = false;
  // Echoed on every company_progress write so the app can tell this capture's
  // messages from another's; a capture it did not start must not settle its task.
  let _companyRequestId = null;
  // The durable task the upload is filed under, so the backend can say which
  // people this capture produced.
  let _companyTaskId = null;
  // The API base the capture started against; its upload goes there.
  let _companyApiBase = null;

  // Resolve a company reference to its numeric id. Accepts a plain name OR a
  // LinkedIn company URL/slug (linkedin.com/company/<slug>[/people/…]) — URLs
  // resolve exactly via the organization universalName lookup, names via the
  // clusters COMPANIES search. Returns { id, name } or null.
  async function resolveCompanyId(companyName) {
    const reference = (companyName || "").trim();
    const slugMatch = reference.match(/linkedin\.com\/company\/([^/?#]+)/i)
      || (/^[a-z0-9][a-z0-9._-]*$/i.test(reference) && reference.includes("-") ? [null, reference] : null);
    if (slugMatch) {
      let slug = slugMatch[1];
      try { slug = decodeURIComponent(slug); } catch { /* malformed %-encoding — use raw slug */ }
      try {
        const data = await apiFetch(
          `/voyager/api/organization/companies?q=universalName&universalName=${encodeURIComponent(slug)}`,
          stealthHeaders(extractCsrfToken()),
        );
        const elements = data?.elements || data?.data?.elements || data?.included || [];
        for (const el of elements) {
          const urn = el?.entityUrn || "";
          const m = urn.match(/(?:fsd_company|fs_normalized_company|company):(\d+)/);
          if (m) return { id: m[1], name: el?.name || el?.universalName || slug };
        }
      } catch (error) {
        LOG(`universalName lookup failed for "${slug}": ${error?.message || error}`);
      }
      // Fall through to keyword search on the de-slugged name.
      companyName = slug.replace(/-/g, " ");
    }
    const kw = encodeURIComponent(companyName.trim());
    const data = await searchApiFetch((deco) =>
      `/voyager/api/search/dash/clusters` +
      `?decorationId=${encodeURIComponent(deco)}` +
      `&origin=GLOBAL_SEARCH_HEADER&q=all` +
      `&query=(keywords:${kw},flagshipSearchIntent:SEARCH_SRP,` +
      `queryParameters:(resultType:List(COMPANIES)))` +
      `&start=0&count=5`
    );
    const elements = data?.elements || data?.data?.elements || [];
    const candidates = [];
    for (const el of elements) {
      const items = el?.items || el?.itemsResolutionResults || [];
      for (const item of items) {
        const er = pickEntityResult(item);
        if (!er) continue;
        const urn = er.entityUrn || er.trackingUrn || "";
        const m = urn.match(/fsd_company:(\d+)/) || urn.match(/\bcompany:(\d+)/);
        if (m) candidates.push({ id: m[1], name: entityName(er) || companyName.trim() });
      }
    }
    // LinkedIn ranks by its own relevance, not by the name asked for: "Axon"
    // can come back as some other Axon first. An exact name beats rank.
    const wanted = normalizeCompanyName(companyName);
    return candidates.find((c) => normalizeCompanyName(c.name) === wanted) || candidates[0] || null;
  }

  function normalizeCompanyName(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  // Page the clusters PEOPLE search filtered to a company's current employees
  // across the viewer's whole reach (1st/2nd/3rd degree). With keywords, one
  // faceted pass runs per keyword ("hardware engineer", "finance") and the
  // passes are unioned — a role-shaped capture instead of the whole company,
  // which LinkedIn truncates long before a large employer runs out.
  // Returns { people, total } where each person is the search-level record
  // ({name, headline, linkedinUrl, photoUrl}) stamped with its real degree
  // when LinkedIn reports one (fallback "2nd"). Enrichment happens later.
  async function searchCompanyPeople(companyId, keywords, onProgress) {
    const all = [];
    const seen = new Set();
    let total = 0;
    const MAX_PAGES = 100; // backstop only; the pass ends at LinkedIn's own cap
    // LinkedIn stops serving a people search past its first 1,000 results.
    const LINKEDIN_SEARCH_CAP = 1000;
    // The most one capture uploads (the company upload endpoint's limit); six
    // keyword passes could otherwise gather 6,000.
    const MAX_CAPTURE_PEOPLE = 5000;
    const passes = keywords.length > 0 ? keywords : [null];
    let partial = null;

    for (const keyword of passes) {
      if (_companyCancel || partial) break;
      // encodeURIComponent leaves ( ) intact, and a bare paren closes the
      // Voyager query DSL early: "Engineer (Hardware)" would 400 every page.
      const keywordClause = keyword
        ? `keywords:${encodeURIComponent(keyword).replace(/\(/g, "%28").replace(/\)/g, "%29")},`
        : "";
      const passSeen = new Set();
      let start = 0;
      let pageCount = 0;
      let passTotal = 0;
      try {
        while (true) {
          if (_companyCancel) break;
          const data = await searchApiFetch((deco) =>
            `/voyager/api/search/dash/clusters` +
            `?decorationId=${encodeURIComponent(deco)}` +
            `&origin=FACETED_SEARCH&q=all` +
            `&query=(${keywordClause}flagshipSearchIntent:SEARCH_SRP,queryParameters:` +
            `(currentCompany:List(${companyId}),network:List(F,S,O),resultType:List(PEOPLE)))` +
            `&start=${start}&count=${PER_PAGE}`
          );

          if (start === 0) {
            passTotal = data?.metadata?.totalResultCount || 0;
            total += passTotal;
            if (passTotal > 0) {
              LOG(`LinkedIn reports ${passTotal} ${passTotal === 1 ? "person" : "people"} at company ${companyId}`
                + (keyword ? ` for "${keyword}"` : ""));
            }
          }

          const slots = searchResultKeys(data, start);
          if (slots.length === 0) break;
          const freshSlots = slots.filter((key) => !passSeen.has(key));
          // A page of slots this pass already saw → the cursor is stuck. Bail.
          if (freshSlots.length === 0) break;
          for (const key of freshSlots) passSeen.add(key);

          for (const p of parseSearchPeople(data)) {
            // Someone matching two keywords is one person, captured once.
            if (seen.has(p.linkedinUrl)) continue;
            seen.add(p.linkedinUrl);
            all.push({ ...p, degree: p.degree || "2nd" });
            if (all.length >= MAX_CAPTURE_PEOPLE) break;
          }
          if (onProgress) onProgress(all.length, total);
          if (all.length >= MAX_CAPTURE_PEOPLE) {
            partial = `stopped at the ${MAX_CAPTURE_PEOPLE.toLocaleString("en-US")}-person capture limit`;
            break;
          }

          // Advance by what LinkedIn actually returned: it may serve fewer
          // slots than asked for, and stepping by PER_PAGE would skip the rest.
          start += slots.length;
          if (passTotal > 0 && start >= Math.min(passTotal, LINKEDIN_SEARCH_CAP)) break;
          pageCount++;
          if (pageCount >= MAX_PAGES) {
            LOG(`Hit MAX_PAGES=${MAX_PAGES} for company ${companyId}; stopping at ${all.length}`);
            break;
          }
          await humanDelay(PAGE_DELAY_MS[0], PAGE_DELAY_MS[1]);
        }
      } catch (err) {
        // A later pass failing (rate limit, timeout) must not throw away the
        // people earlier passes already found: stop searching and keep them.
        const msg = err?.message || String(err);
        if (msg === "SESSION_EXPIRED" || all.length === 0) throw err;
        LOG(`Company search stopped early at ${all.length} people: ${msg}`);
        partial = msg;
      }
    }
    return { people: all, total, partial };
  }

  // Enrich each search-level person with the full profile pass, in parallel
  // chunks, merging the enrichment onto the record. Mirrors enrichProfiles'
  // 429 backoff. Inaccessible profiles fall back to the search-level record so
  // the person is still captured. Reports (done, total) progress; a rate-limit
  // pause reports (done, total, true). SESSION_EXPIRED propagates.
  async function enrichCompanyPeople(people, csrfToken, onProgress) {
    const out = [];
    let done = 0;

    const enrichMerge = async (person) => {
      const publicId = extractPublicId(person.linkedinUrl);
      if (!publicId) return person;
      const full = await enrichOne(publicId, csrfToken); // may throw / return null
      // What the search result already had stays when the profile read comes back without it.
      return full
        ? { ...person, ...full, photoUrl: full.photoUrl || person.photoUrl, headline: full.headline || person.headline, degree: person.degree }
        : person;
    };

    for (let i = 0; i < people.length; i += ENRICH_PARALLEL) {
      if (_companyCancel) break;
      const chunk = people.slice(i, i + ENRICH_PARALLEL);
      const settled = await Promise.allSettled(chunk.map(enrichMerge));

      const toRetry = [];
      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        if (r.status === "fulfilled") {
          out.push(r.value); done++;
        } else {
          const msg = r.reason?.message || String(r.reason);
          if (msg === "SESSION_EXPIRED") throw r.reason;
          if (msg === "RATE_LIMITED") {
            toRetry.push(chunk[j]);
          } else {
            LOG(`Company enrich skipped ${chunk[j].linkedinUrl}: ${msg}`);
            out.push(chunk[j]); done++; // keep the search-level record
          }
        }
      }

      // Batch-level backoff: any 429 in the chunk → wait 30s and retry those.
      if (toRetry.length > 0) {
        LOG(`Rate limited on ${toRetry.length} profile(s); backing off 30s`);
        if (onProgress) onProgress(done, people.length, true);
        await new Promise((r) => setTimeout(r, 30000));
        const retried = await Promise.allSettled(toRetry.map(enrichMerge));
        for (let j = 0; j < retried.length; j++) {
          const r = retried[j];
          if (r.status === "fulfilled") { out.push(r.value); done++; }
          else {
            if ((r.reason?.message) === "SESSION_EXPIRED") throw r.reason;
            LOG(`Company enrich retry failed ${toRetry[j].linkedinUrl}: ${r.reason?.message || r.reason}`);
            out.push(toRetry[j]); done++; // keep the search-level record
          }
        }
      }

      if (onProgress) onProgress(done, people.length);
      if (i + ENRICH_PARALLEL < people.length && !_companyCancel) {
        await humanDelay(PAGE_DELAY_MS[0], PAGE_DELAY_MS[1]);
      }
    }
    return out;
  }

  // Orchestrate: resolve → search → enrich, streaming progress the whole way.
  async function captureCompanyConnections(companyName, keywords = []) {
    _companyCancel = false;
    const name = (companyName || "").trim();
    if (name.length < 2) { sendCompanyError("Enter a company name."); return; }

    let csrfToken;
    try { csrfToken = extractCsrfToken(); }
    catch { sendCompanyError("Not logged into LinkedIn. Open LinkedIn and try again."); return; }

    // 1) Resolve company → numeric id
    sendCompanyProgress(0, 0, `Looking up ${name} on LinkedIn…`);
    let resolved;
    try {
      resolved = await resolveCompanyId(name);
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg === "SESSION_EXPIRED") return sendCompanyError("LinkedIn session expired. Refresh LinkedIn and try again.");
      return sendCompanyError(`Couldn't look up "${name}" on LinkedIn.`);
    }
    if (!resolved || !resolved.id) return sendCompanyError(`Couldn't find "${name}" on LinkedIn.`);
    if (_companyCancel) return sendCompanyCanceled(0);

    // 2) Page the people search (one pass per keyword when given)
    const roles = keywords.length > 0 ? ` (${keywords.join(", ")})` : "";
    sendCompanyProgress(0, 0, `Finding people at ${resolved.name}${roles}…`);
    let searchResult;
    try {
      searchResult = await searchCompanyPeople(resolved.id, keywords, (c, t) =>
        sendCompanyProgress(c, t, `Found ${c}${t ? ` of ${t}` : ""} ${c === 1 ? "person" : "people"} at ${resolved.name}…`));
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg === "SESSION_EXPIRED") return sendCompanyError("LinkedIn session expired. Refresh LinkedIn and try again.");
      if (msg === "RATE_LIMITED") return sendCompanyError("LinkedIn rate-limited the search. Wait a few minutes and try again.");
      if (msg === "TIMEOUT") return sendCompanyError("LinkedIn stopped responding. Try again in a moment.");
      return sendCompanyError(`LinkedIn search failed: ${msg}`);
    }
    const basePeople = searchResult.people;
    if (_companyCancel) return sendCompanyCanceled(basePeople.length);
    if (basePeople.length === 0) {
      return sendCompanyResults({ company: resolved.name, companyId: resolved.id, people: [] });
    }

    // 3) Enrich every person with the full profile pass
    let enriched;
    try {
      enriched = await enrichCompanyPeople(basePeople, csrfToken, (d, t, backingOff) =>
        sendCompanyProgress(d, t, backingOff
          ? waitMessage("rate_limited", { seconds: 30, current: d, total: t })
          : `Profile details at ${resolved.name} · ${positionPhrase(d, t)}`
            + (remainingCount(d, t) === null ? "" : ` · ${formatCount(remainingCount(d, t))} to go`)));
    } catch (err) {
      if ((err?.message) === "SESSION_EXPIRED") return sendCompanyError("LinkedIn session expired. Refresh LinkedIn and try again.");
      // Unexpected enrichment failure — still return the search-level list.
      enriched = basePeople;
    }
    if (_companyCancel) return sendCompanyCanceled(enriched.length);

    return sendCompanyResults({
      company: resolved.name, companyId: resolved.id, people: enriched, partial: searchResult.partial,
    });
  }

  function publicLinkedInError(error) {
    const source = error instanceof Error ? error : new Error(String(error));
    return {
      error: source.message,
      code: typeof source.code === "string" ? source.code.slice(0, 96) : "LINKEDIN_OPERATION_FAILED",
      stage: typeof source.stage === "string" ? source.stage.slice(0, 64) : "unknown",
      status: source.status !== null && source.status !== undefined && Number.isFinite(Number(source.status))
        ? Number(source.status)
        : null,
      retryable: source.retryable === true,
    };
  }

  // ─── Reviewed one-to-one send (explicit per-message confirmation only) ──────
  //
  // Unlike the draft path above, this DOES deliver. It is deliberately built so
  // that exactly one reviewed message reaches one recipient per call: there is
  // no array/list/batch form, and a valid confirmation token — the proof a human
  // approved this specific recipient and text — is required before anything is
  // sent. The token is also LinkedIn's dedupe key, so a retry cannot double-send.

  // ─── Messaging Helpers ──────────────────────────────────────────────────────




  function sendProgress(message, current, total) {
    if (!isContextValid() || _mutualCancel) return;
    void setMutualProgress({
      status: "in_progress",
      current: current || 0,
      total: total || 0,
      message: message || "",
    }).catch(() => {});
  }

  function sendResults(results) {
    if (!isContextValid()) return;
    void saveBridgeResults(results).catch(() => {});
  }

  function sendError(error) {
    if (!isContextValid()) return;
    void setMutualProgress({ status: "error", message: error || "Mutual finding failed" }).catch(() => {});
  }

  function sendCompanyProgress(current, total, message) {
    if (!isContextValid()) return;
    void setCompanyProgress({
      status: "in_progress",
      current: current || 0,
      total: total || 0,
      message: message || "",
      requestId: _companyRequestId,
    }).catch(() => {});
  }

  // Awaited, so the capture holds the engine until its upload has landed and a
  // second capture cannot start writing company_progress underneath it.
  async function sendCompanyResults(payload) {
    if (!isContextValid()) return;
    await saveCompanyResults({
      ...payload, requestId: _companyRequestId, taskId: _companyTaskId, apiBase: _companyApiBase,
    }).catch(() => {});
  }

  function sendCompanyError(error) {
    if (!isContextValid()) return;
    void setCompanyProgress({
      status: "error", message: error || "Company capture failed", requestId: _companyRequestId,
    }).catch(() => {});
  }

  function sendCompanyCanceled(count) {
    if (!isContextValid()) return;
    void setCompanyProgress({ status: "canceled", count: count || 0, requestId: _companyRequestId }).catch(() => {});
  }

  // ─── Entry points ───────────────────────────────────────────────────────────
  //
  // Formerly the branches of the content script's onMessage listener. Each one
  // primes the CSRF token first: that single cookie read is what proves the
  // LinkedIn session is alive before any work starts, and it turns a signed-out
  // browser into one clear message instead of a task that stalls.

  // Detached mutual/company runs outlive their message port, so the worker
  // needs to know when they settle to decide whether the keep-alive alarms can
  // come down without stripping them from a run still in flight.
  let _activeGraphTasks = 0;
  let _graphSettledHook = null;

  function isGraphTaskRunning() {
    return _activeGraphTasks > 0;
  }

  function onGraphTaskSettled(hook) {
    if (typeof hook === "function") _graphSettledHook = hook;
  }

  function trackGraphTask(promise) {
    _activeGraphTasks += 1;
    void promise.finally(async () => {
      _activeGraphTasks = Math.max(0, _activeGraphTasks - 1);
      try { await _graphSettledHook?.(); } catch { /* hook failures are cosmetic */ }
    });
  }

  async function findBridges(targets) {
    if (!Array.isArray(targets) || targets.length === 0) return { error: "No targets provided" };
    await primeCsrfToken();
    if (_mutualActive && !_mutualCancel) return { error: "Find mutuals is already running. Let it finish or stop it first." };
    LOG(`Starting bridge finder for ${targets.length} target(s)`);
    _mutualCancel = false;
    _mutualActive = true;
    const run = ++_mutualRun;
    trackGraphTask(processTargets(targets, run).catch((err) => {
      if (!_mutualCancel && run === _mutualRun) sendError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (run === _mutualRun) _mutualActive = false;
    }));
    return { started: true, count: targets.length };
  }

  async function findPeople(query, limit) {
    await primeCsrfToken();
    LOG(`People search for "${query}" (limit ${limit || 10})`);
    const people = await searchPeople(query, limit);
    return { people };
  }

  async function enrichProfileUrls(urls) {
    const list = Array.isArray(urls) ? urls : [];
    await primeCsrfToken();
    LOG(`Enriching ${list.length} profile(s)`);
    // Tracked even though the caller awaits it: a 429 inside enrichProfiles
    // sleeps 30s with nothing in flight, which is exactly the MV3 idle budget —
    // the worker needs the keep-alive alarm up for the duration.
    const task = enrichProfiles(list);
    trackGraphTask(task.catch(() => {}));
    return task;
  }


  function isCompanyCaptureRunning() {
    return _companyRunning;
  }

  // ─── Company details (for the Companies table) ──────────────────────────────
  //
  // One company's page facts: its canonical LinkedIn slug, About text, website,
  // sector, and logo. Called at most once per company (the Airtable side caches
  // the answer), and spaced out so a first sync over a large network doesn't
  // turn into a burst of company lookups.

  const COMPANY_DETAIL_SPACING_MS = [350, 700];
  let lastCompanyDetailAt = 0;

  function companyEntityFrom(data, companyId) {
    const candidates = [
      ...(Array.isArray(data?.elements) ? data.elements : []),
      data?.data,
      data,
      ...(Array.isArray(data?.included) ? data.included : []),
    ].filter((item) => item && typeof item === "object" && (item.universalName || item.description || item.companyPageUrl));
    // `included` can carry similar or affiliated companies too: the one asked for first.
    const own = candidates.find((item) => new RegExp(`[:/]${companyId}$`).test(String(item.entityUrn || item.objectUrn || item["*company"] || "")));
    return own || candidates[0] || null;
  }

  function industryOf(entity) {
    const lists = [entity.companyIndustries, entity.industries, entity.industryV2Taxonomy].filter(Array.isArray);
    for (const list of lists) {
      const first = list[0];
      const name = typeof first === "string" ? first : first?.localizedName || first?.name;
      if (name && !String(name).startsWith("urn:")) return name;
    }
    return entity.industry?.localizedName || entity.industry?.name || "";
  }

  /**
   * Whether LinkedIn still knows who we are. A 401/403 on one company page is
   * usually that page (restricted, or an endpoint LinkedIn retired), not a
   * signed-out session; only this answers which.
   */
  async function sessionAlive(csrfToken) {
    try {
      const response = await timedFetch("/voyager/api/me", { headers: stealthHeaders(csrfToken), credentials: "include" });
      return response.status !== 401 && response.status !== 403;
    } catch {
      return true; // A network blip says nothing about the session.
    }
  }

  async function companyDetails(companyId) {
    if (!/^\d+$/.test(String(companyId || ""))) return null;
    const wait = lastCompanyDetailAt + humanDelayMs() - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCompanyDetailAt = Date.now();
    const csrfToken = cachedCsrfToken || await primeCsrfToken();
    const urls = [
      `/voyager/api/organization/companies/${companyId}?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12`,
      `/voyager/api/organization/companies/${companyId}`,
      `/voyager/api/entities/companies/${companyId}`,
    ];
    for (const url of urls) {
      try {
        const entity = companyEntityFrom(await apiFetch(url, stealthHeaders(csrfToken)), companyId);
        if (!entity) continue;
        return {
          universalName: entity.universalName || "",
          name: entity.name || entity.localizedName || "",
          about: entity.description || entity.localizedDescription || "",
          website: entity.companyPageUrl || entity.websiteUrl || "",
          industry: industryOf(entity),
          logoUrl: extractCompanyLogoUrl(entity) || "",
        };
      } catch (error) {
        const message = error?.message || String(error);
        if (message === "RATE_LIMITED") throw error;
        if (message === "SESSION_EXPIRED") {
          if (!(await sessionAlive(await primeCsrfToken().catch(() => csrfToken)))) throw error;
          // Signed in: LinkedIn refused this endpoint for this company. The
          // next endpoint may still answer; none answering is no details, no failure.
          LOG(`Company ${companyId}: LinkedIn refused ${url.split("?")[0]} (session is fine)`);
          continue;
        }
      }
    }
    return null;
  }

  function humanDelayMs() {
    return COMPANY_DETAIL_SPACING_MS[0] + Math.random() * (COMPANY_DETAIL_SPACING_MS[1] - COMPANY_DETAIL_SPACING_MS[0]);
  }

  async function captureCompany(company, options = {}) {
    // Two captures share one progress channel and one cancel flag; a second
    // one would steal the first's completion. The caller retries later.
    if (_companyRunning) return { error: "A company capture is already running.", busy: true };
    _companyRunning = true;
    _companyRequestId = typeof options.requestId === "string" ? options.requestId : null;
    _companyTaskId = typeof options.taskId === "string" ? options.taskId : null;
    _companyApiBase = typeof options.apiBase === "string" ? options.apiBase : null;
    const keywords = Array.isArray(options.keywords) ? options.keywords : [];
    try {
      await primeCsrfToken();
    } catch (err) {
      _companyRunning = false;
      throw err;
    }
    LOG(`Starting company capture for "${company}"${keywords.length ? ` (${keywords.join(", ")})` : ""}`);
    _companyCancel = false;
    trackGraphTask(captureCompanyConnections(company, keywords).catch((err) => {
      sendCompanyError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      _companyRunning = false;
    }));
    return { started: true };
  }

  // The worker calls this on CANCEL_SYNC; the company and mutual loops stop at
  // their next checkpoint.
  function cancelCompanyCapture() {
    _companyCancel = true;
    _mutualCancel = true;
    return { canceled: true };
  }

  function describeFailure(error) {
    return publicLinkedInError(error);
  }

  return {
    companyDetails,
    findBridges,
    findPeople,
    enrichProfileUrls,
    captureCompany,
    isCompanyCaptureRunning,
    cancelCompanyCapture,
    describeFailure,
    isGraphTaskRunning,
    onGraphTaskSettled,
  };
})();

export const findBridges = (targets) => engine.findBridges(targets);
export const fetchCompanyDetails = (companyId) => engine.companyDetails(companyId);
export const findPeople = (query, limit) => engine.findPeople(query, limit);
export const enrichProfileUrls = (urls) => engine.enrichProfileUrls(urls);
export const captureCompany = (company, options) => engine.captureCompany(company, options);
export const isCompanyCaptureRunning = () => engine.isCompanyCaptureRunning();
export const cancelCompanyCapture = () => engine.cancelCompanyCapture();
export const describeLinkedInFailure = (error) => engine.describeFailure(error);
export const isGraphTaskRunning = () => engine.isGraphTaskRunning();
export const onGraphTaskSettled = (hook) => engine.onGraphTaskSettled(hook);
