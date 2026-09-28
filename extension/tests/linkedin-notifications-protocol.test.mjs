import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, "..", "lib", "linkedin-notifications-protocol.js"), "utf8");

function loadProtocol() {
  // vm.createContext supplies the ECMAScript intrinsics but no host objects, so
  // URL and URLSearchParams have to be handed in — the service worker the module
  // actually runs in has both.
  const sandbox = { console, URL, URLSearchParams };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return sandbox.EarthOSLinkedInNotificationsProtocol;
}

const protocol = loadProtocol();

/** A card in the shape a live notifications response actually returns. */
function card({
  type = "SHARED_BY_YOUR_NETWORK",
  slug = "sarahchen",
  headline = "Sarah Chen posted: we shipped the new editor today",
  publishedAt = 1785366046216,
  member = "60636317",
} = {}) {
  return {
    $type: "com.linkedin.voyager.dash.identity.notifications.Card",
    objectUrn: `urn:li:notificationV2:(urn:li:member:${member},${type},urn:li:uniqueSuffix:(urn:li:none,PMyrGj3BTVqvCKJ5scJMKA))`,
    publishedAt,
    headline: { text: headline },
    headerImage: {
      actionTarget: slug === null ? null : `/in/${slug}`,
      attributes: [{ detailDataUnion: { profilePicture: "urn:li:fsd_profile:ACoAABpISd8" } }],
    },
    // Fields that must never be forwarded.
    trackingId: "should-not-appear",
    $anti_abuse_metadata: { $anti_abuse_uuid: "should-not-appear" },
    contentImages: [{ url: "https://media.licdn.com/should-not-appear" }],
  };
}

const response = (cards) => ({
  data: { paging: { count: 20, start: 0 } },
  included: [
    ...cards,
    // Non-card entities share the `included` array and must be ignored.
    { $type: "com.linkedin.voyager.dash.identity.profile.Profile", entityUrn: "urn:li:fsd_profile:x" },
    { $type: "com.linkedin.voyager.dash.organization.Company", entityUrn: "urn:li:fsd_company:y" },
  ],
});

test("the endpoint and decoration match the live response", () => {
  const url = protocol.buildNotificationsUrl(0, 20);
  assert.ok(url.startsWith("/voyager/api/voyagerIdentityDashNotificationCards?"));
  assert.match(url, /decorationId=com\.linkedin\.voyager\.dash\.deco\.identity\.notifications\.CardsCollectionWithInjectionsNoPills-24/);
  assert.match(url, /q=filterVanityName/);
  assert.match(url, /count=20/);
  assert.match(url, /start=0/);
});

test("pagination offsets are clamped to a sane range", () => {
  // A negative offset cannot become a negative start, and an absent or zero
  // count falls back to the default page size rather than requesting one card.
  assert.match(protocol.buildNotificationsUrl(-5, 0), /start=0/);
  assert.match(protocol.buildNotificationsUrl(-5, 0), new RegExp(`count=${protocol.PAGE_SIZE}`));
  assert.match(protocol.buildNotificationsUrl(40, 5000), /count=100/);
  assert.match(protocol.buildNotificationsUrl(40, 5000), /start=40/);
});

test("cards are read from included, not elements", () => {
  const cards = protocol.notificationCards(response([card(), card({ slug: "james" })]));
  assert.equal(cards.length, 2);
});

test("the notification type is read out of the URN", () => {
  assert.equal(protocol.notificationType(card({ type: "PROFILE_STAR_UPDATE" })), "PROFILE_STAR_UPDATE");
  assert.equal(protocol.notificationType({ objectUrn: null }), null);
});

test("the subject is the lowercase /in/ slug the workspace keys people on", () => {
  assert.equal(protocol.subjectSlug(card({ slug: "SarahChen" })), "sarahchen");
  assert.equal(protocol.subjectSlug(card({ slug: "sarah-chen-123" })), "sarah-chen-123");
  // A company or feed target is not a person.
  assert.equal(protocol.subjectSlug({ headerImage: { actionTarget: "/company/figma" } }), null);
  assert.equal(protocol.subjectSlug({ headerImage: { actionTarget: null } }), null);
});

test("an absolute profile URL with tracking params still resolves", () => {
  const slug = protocol.subjectSlug({
    headerImage: { actionTarget: "https://www.linkedin.com/in/sarahchen?trk=notification" },
  });
  assert.equal(slug, "sarahchen");
});

test("only four fields ever leave the browser", () => {
  const record = protocol.minimizeCard(card());
  assert.deepEqual(Object.keys(record).sort(), ["headline", "publishedAt", "slug", "type"]);
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes("should-not-appear"), false);
  assert.equal(serialized.includes("licdn"), false);
});

test("a post headline is truncated rather than forwarded whole", () => {
  const long = `Sarah Chen posted: ${"a very long post ".repeat(80)}`;
  const record = protocol.minimizeCard(card({ headline: long }));
  assert.equal(record.headline.length, protocol.MAX_HEADLINE_LENGTH);
  assert.ok(record.headline.endsWith("…"));
});

test("cards that are not about an identifiable person are dropped", () => {
  assert.equal(protocol.minimizeCard(card({ slug: null })), null);
  assert.equal(protocol.minimizeCard(card({ headline: "   " })), null);
  assert.equal(protocol.minimizeCard(card({ publishedAt: 0 })), null);
  // The profile-views upsell has no type token in its URN.
  assert.equal(protocol.minimizeCard({ ...card(), objectUrn: "urn:li:notificationV2:nope" }), null);
});

test("a sweep walks pages and stops on a short one", async () => {
  const pages = [
    response(Array.from({ length: 20 }, (_, i) => card({ slug: `person${i}`, member: String(i) }))),
    response(Array.from({ length: 5 }, (_, i) => card({ slug: `later${i}`, member: String(100 + i) }))),
  ];
  const requested = [];
  const fetchJson = async (url) => {
    requested.push(url);
    return pages[requested.length - 1] ?? response([]);
  };
  const { records, pages: walked } = await protocol.collectNotifications(fetchJson, { pageSize: 20 });
  assert.equal(walked, 2, "stopped once a page came back short");
  assert.equal(records.length, 25);
  assert.match(requested[1], /start=20/);
});

test("a sweep is bounded even if the feed never runs out", async () => {
  const fetchJson = async () =>
    response(Array.from({ length: 20 }, (_, i) => card({ slug: `p${Math.random()}`.replace(/[^a-z0-9]/g, "") || "x", member: String(i) })));
  const { pages } = await protocol.collectNotifications(fetchJson, { pageSize: 20, maxPages: 3 });
  assert.equal(pages, 3);
});

test("one prolific poster cannot dominate a sweep", async () => {
  const fetchJson = async () =>
    response([
      card({ slug: "poster", headline: "post one", publishedAt: 1785366046216 }),
      card({ slug: "poster", headline: "post two", publishedAt: 1785366046999 }),
      card({ slug: "poster", headline: "post three", publishedAt: 1785366047999 }),
    ]);
  const { records } = await protocol.collectNotifications(fetchJson, { pageSize: 20, maxPages: 1 });
  assert.equal(records.length, 1, "same person, same type, same day collapses to one reason");
});

test("an empty feed yields nothing without throwing", async () => {
  const { records, pages } = await protocol.collectNotifications(async () => response([]), { pageSize: 20 });
  // Length rather than deepEqual: the array is built inside the vm realm, so its
  // prototype is not this realm's Array.prototype and deepStrictEqual rejects it.
  assert.equal(records.length, 0);
  assert.equal(pages, 1);
});
