/**
 * Privacy-minimizing reader for the user's own LinkedIn notifications feed.
 *
 * LinkedIn already aggregates "started a new position", "posted", "work
 * anniversary" for a user's whole network onto one page. One authenticated
 * request therefore returns dozens of typed events about people the user
 * actually knows, with no per-person crawling and no third-party data. That
 * makes it the breadth layer of EarthOS's signal engine.
 *
 * Like linkedin-messaging-protocol.js this is a classic script so the service
 * worker can inject it into the same isolated world, and it deliberately exposes
 * only what a reason-to-reach-out needs: the notification type, who it is about,
 * a truncated headline, and when it happened. Tracking ids, anti-abuse metadata,
 * images, and the social-action payloads are dropped in the page and never leave
 * the browser.
 *
 * Endpoint and field paths below were read from a live response. The response is
 * Rest.li-normalized: cards arrive in `included`, not in `elements`, which holds
 * only URN references to them.
 */
(function (root) {
  const NOTIFICATION_CARDS_PATH = "/voyager/api/voyagerIdentityDashNotificationCards";
  const CARDS_DECORATION_ID =
    "com.linkedin.voyager.dash.deco.identity.notifications.CardsCollectionWithInjectionsNoPills-24";
  const CARD_TYPE = "com.linkedin.voyager.dash.identity.notifications.Card";
  // urn:li:notificationV2:(urn:li:member:123,SHARED_BY_YOUR_NETWORK,…)
  const NOTIFICATION_TYPE = /,([A-Z][A-Z0-9_]{2,60}),/;
  const PROFILE_PATH = /^\/in\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?)\/?$/;

  /**
   * Headlines for a post notification contain the entire post body, which can run
   * to thousands of characters of somebody else's writing. Only enough to
   * recognise what happened is kept.
   */
  const MAX_HEADLINE_LENGTH = 280;

  const PAGE_SIZE = 20;
  const MAX_PAGES = 10;

  function numericTimestamp(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? Math.trunc(timestamp) : null;
  }

  /** Build one page of the notifications collection. */
  function buildNotificationsUrl(start = 0, count = PAGE_SIZE) {
    const offset = Math.max(0, Math.trunc(Number(start) || 0));
    const size = Math.max(1, Math.min(100, Math.trunc(Number(count) || PAGE_SIZE)));
    const params = new URLSearchParams({
      decorationId: CARDS_DECORATION_ID,
      count: String(size),
      start: String(offset),
      q: "filterVanityName",
      filterVanityName: "all",
    });
    return `${NOTIFICATION_CARDS_PATH}?${params.toString()}`;
  }

  /** Cards out of a normalized response. */
  function notificationCards(response) {
    const included = response?.included;
    if (!Array.isArray(included)) return [];
    return included.filter((entry) => entry && entry.$type === CARD_TYPE);
  }

  function headlineText(card) {
    const headline = card?.headline;
    if (typeof headline === "string") return headline;
    const text = headline?.text ?? headline?.attributedText?.text;
    return typeof text === "string" ? text : "";
  }

  /**
   * Public identifier of the person a card is about.
   *
   * The header image's action target is the profile link, so this is the same
   * lowercase /in/ slug the connection capture keys people on — which is what
   * lets a notification be attached to somebody already in the workspace.
   */
  function subjectSlug(card) {
    const target = card?.headerImage?.actionTarget;
    if (typeof target !== "string") return null;
    const path = target.startsWith("http")
      ? (() => {
          try {
            return new URL(target).pathname;
          } catch {
            return "";
          }
        })()
      : target.split("?")[0];
    const match = path.match(PROFILE_PATH);
    return match ? match[1].toLowerCase() : null;
  }

  function notificationType(card) {
    const urn = card?.objectUrn;
    if (typeof urn !== "string") return null;
    const match = urn.match(NOTIFICATION_TYPE);
    return match ? match[1] : null;
  }

  /**
   * Reduce a card to the four fields that leave the browser, or null when it is
   * not about an identifiable person.
   */
  function minimizeCard(card) {
    const type = notificationType(card);
    const slug = subjectSlug(card);
    const publishedAt = numericTimestamp(card?.publishedAt);
    const headline = headlineText(card).replace(/\s+/g, " ").trim();
    if (!type || !slug || !publishedAt || !headline) return null;
    return {
      type,
      slug,
      headline:
        headline.length > MAX_HEADLINE_LENGTH
          ? `${headline.slice(0, MAX_HEADLINE_LENGTH - 1)}…`
          : headline,
      publishedAt,
    };
  }

  /** Every usable record on one page. */
  function notificationRecords(response) {
    return notificationCards(response).map(minimizeCard).filter(Boolean);
  }

  /**
   * Walk the feed and return minimized records.
   *
   * `fetchJson` is supplied by the caller so this module needs no knowledge of
   * credentials or retry policy. Pagination stops on a short page, an empty page,
   * or MAX_PAGES — the feed is effectively unbounded and a sync must not walk it
   * forever. Because it is ordered newest-first, stopping early loses only the
   * oldest items, which have expired as reasons to reach out anyway.
   */
  async function collectNotifications(fetchJson, options) {
    const maxPages = Math.max(1, Math.min(50, Number(options?.maxPages) || MAX_PAGES));
    const pageSize = Math.max(1, Math.min(100, Number(options?.pageSize) || PAGE_SIZE));
    const records = [];
    const seen = new Set();
    let pages = 0;

    for (let page = 0; page < maxPages; page += 1) {
      const response = await fetchJson(buildNotificationsUrl(page * pageSize, pageSize));
      pages += 1;
      const cards = notificationCards(response);
      if (cards.length === 0) break;
      for (const card of cards) {
        const record = minimizeCard(card);
        if (!record) continue;
        // One card per person per type per day; a prolific poster otherwise
        // dominates the whole sweep.
        const day = new Date(record.publishedAt).toISOString().slice(0, 10);
        const key = `${record.slug}:${record.type}:${day}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(record);
      }
      if (cards.length < pageSize) break;
    }

    return { records, pages };
  }

  root.EarthOSLinkedInNotificationsProtocol = Object.freeze({
    CARDS_DECORATION_ID,
    MAX_HEADLINE_LENGTH,
    NOTIFICATION_CARDS_PATH,
    PAGE_SIZE,
    buildNotificationsUrl,
    collectNotifications,
    minimizeCard,
    notificationCards,
    notificationRecords,
    notificationType,
    subjectSlug,
  });
})(globalThis);
