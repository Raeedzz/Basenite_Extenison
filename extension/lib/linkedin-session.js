/**
 * LinkedIn session primitives for the background service worker.
 *
 * Every LinkedIn flow used to run inside a content script injected into a
 * linkedin.com tab, which gave it two things for free: session cookies on
 * `fetch(..., { credentials: "include" })`, and the CSRF token via
 * `document.cookie`. The service worker has neither a page nor a document, so
 * both are re-established here:
 *
 *   • Cookies — every LinkedIn cookie is issued `SameSite=None; Secure`
 *     (JSESSIONID, li_at, bcookie, bscookie, lidc, __cf_bm), so a worker-side
 *     request carrying `credentials: "include"` under the manifest's
 *     linkedin.com host permission is sent with the live session.
 *   • CSRF token — read straight out of the cookie jar with chrome.cookies
 *     instead of document.cookie.
 *
 * The worker's requests are indistinguishable from the page's at the TLS layer
 * but not at the header layer (no Referer, `Sec-Fetch-Site: cross-site`). The
 * Referer is restored by the declarativeNetRequest rule in rules/linkedin.json
 * so Voyager sees the same origin story it saw from the tab.
 */

export const LINKEDIN_ORIGIN = "https://www.linkedin.com";
export const LINKEDIN_SESSION_KEY = "earthos_linkedin_session";

// A CSRF token only rotates when LinkedIn reissues JSESSIONID, which is rare.
// Re-reading the jar per request would be a needless async hop in the hot path.
const CSRF_CACHE_MS = 60_000;

let csrfCache = { token: null, readAt: 0 };

/**
 * Why a LinkedIn call could not be made. `signed_out` and `blocked` are
 * actionable by the user and must always reach the UI; `unknown` covers
 * transient network failure and deliberately never flips the stored session
 * state to disconnected.
 */
export class LinkedInSessionError extends Error {
  constructor(message, code = "unknown", status = 0) {
    super(message);
    this.name = "LinkedInSessionError";
    this.code = code;
    this.status = status;
  }
}

/** Resolve a Voyager path against linkedin.com; absolute URLs pass through. */
export function linkedinUrl(path) {
  if (typeof path !== "string" || !path) throw new TypeError("A LinkedIn path is required");
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(path, LINKEDIN_ORIGIN).href;
}

export function linkedinApiHeaders(csrfToken, extra = {}) {
  return {
    "csrf-token": csrfToken,
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    "x-li-page-instance": "urn:li:page:d_flagship3_people_connections;",
    ...extra,
  };
}

async function readLinkedInCookie(name) {
  if (!chrome.cookies?.get) {
    throw new LinkedInSessionError(
      "The extension is missing the cookies permission. Reload it from chrome://extensions.",
      "missing_permission",
    );
  }
  const cookie = await chrome.cookies.get({ url: `${LINKEDIN_ORIGIN}/`, name }).catch(() => null);
  if (!cookie?.value) return null;
  // LinkedIn quotes several of its cookie values ("ajax:123…").
  return cookie.value.replace(/^"/, "").replace(/"$/, "");
}

/** True when a LinkedIn login cookie exists at all. */
export async function hasLinkedInLoginCookie() {
  return Boolean(await readLinkedInCookie("li_at"));
}

export function forgetCsrfToken() {
  csrfCache = { token: null, readAt: 0 };
}

export async function getCsrfToken({ force = false } = {}) {
  if (!force && csrfCache.token && Date.now() - csrfCache.readAt < CSRF_CACHE_MS) {
    return csrfCache.token;
  }
  const token = await readLinkedInCookie("JSESSIONID");
  if (!token) {
    forgetCsrfToken();
    throw new LinkedInSessionError(
      "You're signed out of LinkedIn. Open linkedin.com, sign in, then start the sync again.",
      "signed_out",
    );
  }
  csrfCache = { token, readAt: Date.now() };
  return token;
}

export async function readLinkedInSessionState() {
  const stored = await chrome.storage.local.get(LINKEDIN_SESSION_KEY);
  return stored[LINKEDIN_SESSION_KEY] || { connected: null, checkedAt: 0, reason: null };
}

async function recordLinkedInSessionState(state) {
  const previous = await readLinkedInSessionState();
  const next = {
    connected: state.connected,
    reason: state.reason || null,
    memberId: state.memberId || previous.memberId || null,
    checkedAt: Date.now(),
    // Preserve when the session was last known good so the UI can say how long
    // ago it broke rather than only that it is broken now.
    lastConnectedAt: state.connected ? Date.now() : (previous.lastConnectedAt || null),
  };
  await chrome.storage.local.set({ [LINKEDIN_SESSION_KEY]: next });
  return next;
}

/**
 * Ask LinkedIn who we are. This is the single check that proves the worker's
 * cookie-bearing requests actually work end to end — it is what turns "the
 * sync silently did nothing" into a specific, actionable message.
 *
 * A network failure returns `connected: null` (unknown) and never overwrites a
 * previously healthy session, so being offline for a minute does not read as a
 * LinkedIn logout.
 */
export async function probeLinkedInSession() {
  let csrfToken;
  try {
    csrfToken = await getCsrfToken({ force: true });
  } catch (error) {
    return recordLinkedInSessionState({
      connected: false,
      reason: error.code === "missing_permission" ? "missing_permission" : "signed_out",
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(linkedinUrl("/voyager/api/me"), {
      credentials: "include",
      headers: linkedinApiHeaders(csrfToken, { accept: "application/json" }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return recordLinkedInSessionState({ connected: false, reason: "signed_out" });
    }
    if (response.status === 429) {
      return recordLinkedInSessionState({ connected: false, reason: "rate_limited" });
    }
    if (!response.ok) {
      return recordLinkedInSessionState({ connected: false, reason: `http_${response.status}` });
    }
    const body = await response.json().catch(() => null);
    const memberId = typeof body?.miniProfile?.entityUrn === "string"
      ? body.miniProfile.entityUrn.split(":").pop()
      : null;
    return recordLinkedInSessionState({ connected: true, reason: null, memberId });
  } catch (error) {
    // Offline / aborted: report unknown, keep whatever we last knew.
    const previous = await readLinkedInSessionState();
    return { ...previous, connected: null, reason: "unreachable", checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gate every LinkedIn flow. Throws a LinkedInSessionError whose message is
 * already written for a human, so callers can surface `error.message` directly.
 */
export async function assertLinkedInSession() {
  const csrfToken = await getCsrfToken({ force: true });
  if (!(await hasLinkedInLoginCookie())) {
    throw new LinkedInSessionError(
      "You're signed out of LinkedIn. Open linkedin.com, sign in, then start the sync again.",
      "signed_out",
    );
  }
  return csrfToken;
}

export const LINKEDIN_ACCOUNT_KEY = "linkedin_account";
const ACCOUNT_MAX_AGE_MS = 10 * 60_000;

/**
 * Who is signed in to LinkedIn in this browser: { memberId, name, email }.
 * Known by follows this person, not whoever owns the Airtable token, so a
 * teammate syncing through a shared token is credited as themselves. Re-read
 * when stale or when the session probe has seen a different member; the last
 * answer stands while LinkedIn can't be reached. Email is best effort.
 */
export async function linkedInAccount() {
  const { [LINKEDIN_ACCOUNT_KEY]: stored } = await chrome.storage.local.get(LINKEDIN_ACCOUNT_KEY);
  const session = await readLinkedInSessionState().catch(() => ({}));
  const sameMember = !session?.memberId || session.memberId === stored?.memberId;
  if (stored && sameMember && Date.now() - Number(stored.checkedAt || 0) < ACCOUNT_MAX_AGE_MS) return stored;
  try {
    const csrfToken = await getCsrfToken();
    const get = async (path, accept) => {
      const response = await fetch(linkedinUrl(path), {
        credentials: "include",
        headers: linkedinApiHeaders(csrfToken, { accept }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new LinkedInSessionError(`LinkedIn answered ${response.status}`, "unknown", response.status);
      return response.json();
    };
    const mini = (await get("/voyager/api/me", "application/json"))?.miniProfile;
    const memberId = typeof mini?.entityUrn === "string" ? mini.entityUrn.split(":").pop() : null;
    if (!memberId) return stored && sameMember ? stored : null;
    const name = [mini.firstName, mini.lastName].filter(Boolean).join(" ").trim() || null;
    let email = null;
    if (mini.publicIdentifier) {
      const contact = await get(
        `/voyager/api/voyagerIdentityDashProfiles?q=memberIdentity&memberIdentity=${encodeURIComponent(mini.publicIdentifier)}`
          + "&decorationId=com.linkedin.voyager.dash.deco.identity.profile.ProfileContactInfo-15",
        "application/vnd.linkedin.normalized+json+2.1",
      ).catch(() => null);
      const self = (contact?.included || []).find((entity) => entity?.publicIdentifier === mini.publicIdentifier);
      const address = self?.emailAddress?.emailAddress;
      email = typeof address === "string" && address.includes("@") ? address.trim().toLowerCase() : null;
    }
    const account = { memberId, name, email, checkedAt: Date.now() };
    await chrome.storage.local.set({ [LINKEDIN_ACCOUNT_KEY]: account });
    return account;
  } catch {
    return stored && sameMember ? stored : null;
  }
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * The response with its body already read, so a caller's abort timer covers
 * the body as well as the headers. Reading it later, after the timer is
 * cleared, waits forever when LinkedIn sends headers and then stalls.
 */
export async function bufferedResponse(response) {
  const body = await response.arrayBuffer();
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
