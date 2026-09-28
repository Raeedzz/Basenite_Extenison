import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../lib/linkedin-messaging-protocol.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({ URLSearchParams });
vm.runInContext(source, context);
const protocol = context.EarthOSLinkedInMessagingProtocol;

test("builds the verified inbox conversations query", () => {
  const url = protocol.buildConversationsUrl("urn:li:fsd_profile:self-123", 1_721_341_234_567, 20);
  const parsed = new URL(url, "https://www.linkedin.com");
  assert.equal(parsed.pathname, "/voyager/api/voyagerMessagingGraphQL/graphql");
  assert.equal(
    parsed.searchParams.get("queryId"),
    "messengerConversations.9501074288a12f3ae9e3c7ea243bccbf",
  );
  assert.match(parsed.searchParams.get("variables"), /category:INBOX/);
  assert.match(parsed.searchParams.get("variables"), /mailboxUrn:urn:li:fsd_profile:self-123/);
  // Regression guard: the GraphQL gateway 400s if the structural parens/commas
  // are percent-encoded. They must stay literal; only the URN colons are encoded.
  assert.match(url, /variables=\(query:\(predicateUnions:List\(\(conversationCategoryPredicate:\(category:INBOX\)\)\)\),/);
  assert.match(url, /mailboxUrn:urn%3Ali%3Afsd_profile%3Aself-123/);
  assert.doesNotMatch(url, /%28|%29|%2C/i);
});

test("builds the current recipient-scoped conversation query with draft metadata", () => {
  const url = protocol.buildConversationByRecipientsUrl(
    "urn:li:fsd_profile:self-123",
    ["urn:li:fs_profile:target-456"],
  );
  const parsed = new URL(url, "https://www.linkedin.com");
  assert.equal(
    parsed.searchParams.get("queryId"),
    "messengerConversations.395d9022591a61de801254af1334a059",
  );
  assert.equal(
    parsed.searchParams.get("variables"),
    "(mailboxUrn:urn:li:fsd_profile:self-123,recipients:List(urn:li:fsd_profile:target-456))",
  );
});

test("builds the current recipient-scoped fallback without draft metadata", () => {
  const url = protocol.buildConversationByRecipientsUrl(
    "urn:li:fsd_profile:self-123",
    ["urn:li:fs_profile:target-456"],
    false,
  );
  const parsed = new URL(url, "https://www.linkedin.com");
  assert.equal(
    parsed.searchParams.get("queryId"),
    "messengerConversations.9c3ab648b616451570c715e4a184465e",
  );
  assert.equal(
    parsed.searchParams.get("variables"),
    "(mailboxUrn:urn:li:fsd_profile:self-123,recipients:List(urn:li:fsd_profile:target-456))",
  );
});

test("extracts recipient conversations only from the verified response path", () => {
  const expected = [{ entityUrn: "conversation:1" }];
  assert.deepEqual(
    Array.from(protocol.recipientConversationElements({
      data: { messengerConversationsByRecipients: { elements: expected } },
      included: [{ body: { text: "never inspect" } }],
    })),
    expected,
  );
});

test("matches participants across LinkedIn profile URN variants", () => {
  const conversation = {
    conversationParticipants: [
      { hostIdentityUrn: "urn:li:fs_profile:target-456" },
      { hostIdentityUrn: "urn:li:fsd_profile:self-123" },
    ],
  };
  assert.equal(
    protocol.conversationHasParticipant(conversation, "urn:li:fsd_profile:target-456"),
    true,
  );
});

test("accepts only a direct thread between the signed-in member and target", () => {
  const direct = {
    entityUrn: "urn:li:msg_conversation:(urn:li:fsd_profile:self-123,thread-1)",
    conversationParticipants: [
      { hostIdentityUrn: "urn:li:fsd_profile:self-123" },
      { hostIdentityUrn: "urn:li:fs_profile:target-456" },
    ],
  };
  const group = {
    ...direct,
    groupChat: true,
    conversationParticipants: [
      ...direct.conversationParticipants,
      { hostIdentityUrn: "urn:li:fsd_profile:third-789" },
    ],
  };
  assert.equal(protocol.directConversationBetween(
    direct,
    "urn:li:fsd_profile:self-123",
    "urn:li:fsd_profile:target-456",
  ), true);
  assert.equal(protocol.directConversationBetween(
    group,
    "urn:li:fsd_profile:self-123",
    "urn:li:fsd_profile:target-456",
  ), false);
});

test("builds the dedicated create-draft request without a send action", () => {
  const request = protocol.buildCreateDraftRequest({
    mailboxUrn: "urn:li:fsd_profile:self-123",
    conversationUrn: "urn:li:msg_conversation:(urn:li:fsd_profile:self-123,thread-1)",
    text: "Unsent hello",
    originToken: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(
    request.url,
    "/voyager/api/voyagerMessagingDashMessengerMessageDrafts?mailboxUrn=urn%3Ali%3Afsd_profile%3Aself-123",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)), {
    body: { text: "Unsent hello", attributes: [] },
    originToken: "11111111-1111-4111-8111-111111111111",
    conversationUrn: "urn:li:msg_conversation:(urn:li:fsd_profile:self-123,thread-1)",
  });
  assert.doesNotMatch(request.url, /createMessage|send/i);
});

test("builds the dedicated update-draft patch and reads no existing draft body", () => {
  const draft = { entityUrn: "urn:li:msg_draft:draft-123" };
  Object.defineProperty(draft, "body", {
    enumerable: true,
    get() { throw new Error("privacy regression: read existing draft body"); },
  });
  const conversation = { draftMessages: { elements: [draft] } };
  const draftEntityUrn = protocol.draftEntityUrn(conversation);
  assert.equal(draftEntityUrn, "urn:li:msg_draft:draft-123");
  const request = protocol.buildUpdateDraftRequest({ draftEntityUrn, text: "Updated, still unsent" });
  assert.equal(
    request.url,
    "/voyager/api/voyagerMessagingDashMessengerMessageDrafts/urn%3Ali%3Amsg_draft%3Adraft-123",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)), {
    patch: { $set: { body: { text: "Updated, still unsent", attributes: [] } } },
  });
});

test("builds a single-conversation send request keyed to the confirmation token", () => {
  const request = protocol.buildSendMessageRequest({
    mailboxUrn: "urn:li:fsd_profile:self-123",
    conversationUrn: "urn:li:msg_conversation:(urn:li:fsd_profile:self-123,thread-1)",
    text: "Hi there",
    confirmationToken: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(request.url, "/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage");
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)), {
    message: {
      body: { text: "Hi there", attributes: [] },
      renderContentUnions: [],
      conversationUrn: "urn:li:msg_conversation:(urn:li:fsd_profile:self-123,thread-1)",
    },
    mailboxUrn: "urn:li:fsd_profile:self-123",
    dedupeByClientGenerateToken: "11111111-1111-4111-8111-111111111111",
  });
});

test("refuses to build a send request without a confirmation token", () => {
  const base = {
    mailboxUrn: "urn:li:fsd_profile:self-123",
    conversationUrn: "urn:li:msg_conversation:(urn:li:fsd_profile:self-123,thread-1)",
    text: "Hi there",
  };
  assert.throws(() => protocol.buildSendMessageRequest(base), /confirmation token/);
  assert.throws(
    () => protocol.buildSendMessageRequest({ ...base, confirmationToken: "short" }),
    /confirmation token/,
  );
});

test("builds the recipient lookup with literal parens and encoded URN colons", () => {
  const url = protocol.buildConversationByRecipientsUrl(
    "urn:li:fsd_profile:self-123",
    ["urn:li:fsd_profile:target-456"],
    true,
  );
  // Structural parens/commas stay literal; only the URN colons are encoded, the
  // shape LinkedIn's GraphQL gateway accepts (URLSearchParams-encoded parens 400).
  assert.match(url, /variables=\(mailboxUrn:urn%3Ali%3Afsd_profile%3Aself-123,recipients:List\(urn%3Ali%3Afsd_profile%3Atarget-456\)\)/);
  assert.doesNotMatch(url, /%28|%29/);
});

test("returns only timestamp and latest-direction booleans without reading message content", () => {
  const message = {
    deliveredAt: 1_721_341_234_567,
    sender: { hostIdentityUrn: "urn:li:fsd_profile:self-123" },
  };
  for (const key of ["body", "renderContent", "subject", "text"]) {
    Object.defineProperty(message, key, {
      enumerable: true,
      get() { throw new Error(`privacy regression: read ${key}`); },
    });
  }
  // A draft whose body would throw if read. Presence and an edit timestamp are
  // metadata; the text itself must never be touched.
  const draft = { entityUrn: "urn:li:msg_draft:1", lastEditedAt: 1_721_300_000_000 };
  for (const key of ["body", "renderContent", "subject", "text"]) {
    Object.defineProperty(draft, key, {
      enumerable: true,
      get() { throw new Error(`privacy regression: read draft ${key}`); },
    });
  }
  const conversation = {
    lastActivityAt: 1_721_341_000_000,
    lastReadAt: 1_721_341_100_000,
    unreadCount: 0,
    notificationStatus: "ACTIVE",
    draftMessages: { elements: [draft] },
    messages: {
      elements: [message],
    },
  };
  const summary = protocol.summarizeLastInteraction(
    conversation,
    "urn:li:fsd_profile:self-123",
  );
  assert.deepEqual(
    {
      ...summary,
      recentMessageMetadata: Array.from(summary.recentMessageMetadata, (entry) => ({ ...entry })),
    },
    {
      hasInteracted: true,
      messageSent: true,
      messageReceived: false,
      lastSentAt: 1_721_341_234_567,
      lastReceivedAt: null,
      reciprocal: false,
      lastInteractionAt: 1_721_341_234_567,
      lastInteractionDirection: "sent",
      recentMessageMetadata: [
        { deliveredAt: 1_721_341_234_567, direction: "sent" },
      ],
      conversationUrn: null,
      // Thread posture: all metadata, no content.
      hasDraft: true,
      draftUpdatedAt: 1_721_300_000_000,
      lastReadAt: 1_721_341_100_000,
      unreadCount: 0,
      muted: false,
    },
  );
});

test("keeps the five newest timestamp-and-direction pairs without trusting response order", () => {
  const messages = [
    [100, "other"],
    [700, "self-123"],
    [300, "other"],
    [600, "other"],
    [200, "self-123"],
    [500, "self-123"],
    [400, "other"],
  ].map(([deliveredAt, sender]) => {
    const message = {
      deliveredAt,
      sender: { hostIdentityUrn: `urn:li:fsd_profile:${sender}` },
    };
    for (const key of ["body", "renderContent", "subject", "text"]) {
      Object.defineProperty(message, key, {
        enumerable: true,
        get() { throw new Error(`privacy regression: read ${key}`); },
      });
    }
    return message;
  });
  const summary = protocol.summarizeLastInteraction(
    { messages: { elements: messages } },
    "urn:li:fsd_profile:self-123",
  );
  assert.deepEqual(
    Array.from(summary.recentMessageMetadata, (entry) => ({ ...entry })),
    [
      { deliveredAt: 700, direction: "sent" },
      { deliveredAt: 600, direction: "received" },
      { deliveredAt: 500, direction: "sent" },
      { deliveredAt: 400, direction: "received" },
      { deliveredAt: 300, direction: "received" },
    ],
  );
  assert.equal(summary.lastInteractionAt, 700);
  assert.equal(summary.lastInteractionDirection, "sent");
});

test("thread posture reports absence rather than guessing", () => {
  const summary = protocol.summarizeLastInteraction(
    {
      lastActivityAt: 1_721_341_000_000,
      messages: { elements: [{ deliveredAt: 1_721_341_000_000, sender: { hostIdentityUrn: "urn:li:fsd_profile:other" } }] },
    },
    "urn:li:fsd_profile:self-123",
  );
  assert.equal(summary.hasDraft, false);
  assert.equal(summary.draftUpdatedAt, null);
  assert.equal(summary.lastReadAt, null);
  assert.equal(summary.unreadCount, 0);
  assert.equal(summary.muted, false);
});

test("an empty draft collection is not a draft", () => {
  const summary = protocol.summarizeLastInteraction(
    {
      draftMessages: { elements: [] },
      messages: { elements: [{ deliveredAt: 1, sender: { hostIdentityUrn: "urn:li:fsd_profile:other" } }] },
    },
    "urn:li:fsd_profile:self-123",
  );
  assert.equal(summary.hasDraft, false);
});

test("a muted thread is reported so it can be suppressed", () => {
  const summary = protocol.summarizeLastInteraction(
    {
      notificationStatus: "MUTED",
      messages: { elements: [{ deliveredAt: 1, sender: { hostIdentityUrn: "urn:li:fsd_profile:other" } }] },
    },
    "urn:li:fsd_profile:self-123",
  );
  assert.equal(summary.muted, true);
});

test("extracts /me identity while skipping private-message-shaped fields", () => {
  const me = { data: { me: { miniProfile: { entityUrn: "urn:li:fs_miniProfile:self-123" } } } };
  Object.defineProperty(me, "body", {
    enumerable: true,
    get() { throw new Error("privacy regression: read body"); },
  });
  assert.equal(protocol.extractSelfProfileUrn(me), "urn:li:fsd_profile:self-123");
});

test("extracts conversations only from the verified response path", () => {
  const expected = [{ entityUrn: "conversation:1" }];
  assert.deepEqual(
    Array.from(protocol.conversationElements({
      data: { messengerConversationsByCategoryQuery: { elements: expected } },
      included: [{ messages: { elements: [{ body: { text: "never inspect" } }] } }],
    })),
    expected,
  );
});

test("indexes only direct conversations and keeps the newest metadata per member", () => {
  const direct = {
    conversationParticipants: [
      { hostIdentityUrn: "urn:li:fsd_profile:self-123" },
      { hostIdentityUrn: "urn:li:fsd_profile:target-456" },
    ],
    lastActivityAt: 200,
    messages: { elements: [{ deliveredAt: 200, sender: { hostIdentityUrn: "urn:li:fsd_profile:target-456" } }] },
  };
  const group = {
    groupChat: true,
    conversationParticipants: [
      { hostIdentityUrn: "urn:li:fsd_profile:target-456" },
    ],
    lastActivityAt: 300,
    messages: { elements: [{ deliveredAt: 300, sender: { hostIdentityUrn: "urn:li:fsd_profile:target-456" } }] },
  };
  // Asserted field-by-field rather than as a serialized blob: the summary now
  // also carries thread posture, and pinning the exact JSON made an additive,
  // still-content-free field look like a regression.
  const entries = protocol.directInteractionEntries([direct, group], "urn:li:fsd_profile:self-123");
  assert.equal(entries.length, 1, "the group chat is excluded");
  const [memberId, summary] = entries[0];
  assert.equal(memberId, "target-456");
  assert.equal(summary.hasInteracted, true);
  assert.equal(summary.messageSent, false);
  assert.equal(summary.messageReceived, true);
  assert.equal(summary.lastInteractionAt, 200);
  assert.equal(summary.lastInteractionDirection, "received");
  assert.deepEqual(
    Array.from(summary.recentMessageMetadata, (entry) => ({ ...entry })),
    [{ deliveredAt: 200, direction: "received" }],
  );
  // No message content ever crosses the bridge, whatever else is added.
  for (const key of ["body", "renderContent", "subject", "text"]) {
    assert.equal(key in summary, false, `summary must never carry ${key}`);
  }
});

test("a thread with both sides is reciprocal from a single capture", () => {
  // This is the cold-start fix. Only elements[0] was ever read, so a thread that
  // visibly went both ways still could not prove reciprocity until two syncs
  // caught the direction flipping — weeks of a warmth number reading near zero
  // while the evidence sat in the response the capture had already fetched.
  const conversation = {
    lastActivityAt: 1_721_341_000_000,
    messages: {
      elements: [
        { deliveredAt: 1_721_341_234_567, sender: { hostIdentityUrn: "urn:li:fsd_profile:self-123" } },
        { deliveredAt: 1_721_200_000_000, sender: { hostIdentityUrn: "urn:li:fs_profile:target-456" } },
        { deliveredAt: 1_721_100_000_000, sender: { hostIdentityUrn: "urn:li:fsd_profile:self-123" } },
      ],
    },
  };
  const summary = protocol.summarizeLastInteraction(conversation, "urn:li:fsd_profile:self-123");
  assert.equal(summary.reciprocal, true);
  // Newest per side, not merely the first one seen.
  assert.equal(summary.lastSentAt, 1_721_341_234_567);
  assert.equal(summary.lastReceivedAt, 1_721_200_000_000);
  // The last-message direction keeps its old meaning; the ledger depends on it.
  assert.equal(summary.lastInteractionDirection, "sent");
});

test("one-sided threads are not mistaken for reciprocal ones", () => {
  // Overstating warmth is the costly error: it nudges on top of silence.
  const outboundOnly = {
    messages: {
      elements: [
        { deliveredAt: 1_721_341_234_567, sender: { hostIdentityUrn: "urn:li:fsd_profile:self-123" } },
        { deliveredAt: 1_721_100_000_000, sender: { hostIdentityUrn: "urn:li:fsd_profile:self-123" } },
      ],
    },
  };
  const summary = protocol.summarizeLastInteraction(outboundOnly, "urn:li:fsd_profile:self-123");
  assert.equal(summary.reciprocal, false);
  assert.equal(summary.lastReceivedAt, null);
});

test("an unresolvable self URN never invents a reply", () => {
  // Attribution degrades to "received" rather than guessing, matching how
  // messageSent/messageReceived have always behaved.
  const conversation = {
    messages: {
      elements: [
        { deliveredAt: 1_721_341_234_567, sender: { hostIdentityUrn: "urn:li:fs_profile:target-456" } },
        { deliveredAt: 1_721_100_000_000, sender: { hostIdentityUrn: "urn:li:fsd_profile:self-123" } },
      ],
    },
  };
  const summary = protocol.summarizeLastInteraction(conversation, null);
  assert.equal(summary.lastSentAt, null);
  assert.equal(summary.reciprocal, false);
});

// ---------------------------------------------------------------------------
// Per-thread reciprocity — the query that settles what the listing cannot
// ---------------------------------------------------------------------------

const SELF = "urn:li:fsd_profile:self-123";
const CONVERSATION_URN =
  "urn:li:msg_conversation:(urn:li:fsd_profile:self-123,2-YmM0MTc1ODAtMWZmYy00YmY3XzEwMA==)";

function threadResponse(elements) {
  return { data: { messengerMessagesBySyncToken: { elements } } };
}

/** A message whose content cannot be read without failing the test. */
function metadataOnlyMessage(deliveredAt, senderUrn) {
  const message = { deliveredAt, sender: { hostIdentityUrn: senderUrn } };
  for (const key of ["body", "renderContent", "subject", "text", "footer"]) {
    Object.defineProperty(message, key, {
      enumerable: true,
      get() { throw new Error(`privacy regression: read message ${key}`); },
    });
  }
  return message;
}

test("the thread URL encodes the conversation URN's own parentheses", () => {
  // They are part of a value here, not the variables' structure. Left literal,
  // the gateway parses them as syntax and rejects the request with HTTP 400 —
  // which is exactly how this endpoint failed the first time it was tried.
  const url = protocol.buildThreadMessagesUrl(CONVERSATION_URN);
  assert.ok(url.includes(protocol.MESSAGES_QUERY_ID));
  assert.ok(url.includes("%28") && url.includes("%29"), "parens must be encoded");
  assert.ok(!/variables=\(conversationUrn:[^&]*[^%]\(/.test(url), "no literal paren inside the value");
  // The variables' own wrapper parens stay literal, like every other query here.
  assert.ok(url.includes("&variables=(conversationUrn:"));
});

test("a malformed conversation URN is refused rather than sent", () => {
  // Matched on the message, not the constructor: the protocol runs in a vm
  // context, so its TypeError is a different realm's class.
  assert.throws(() => protocol.buildThreadMessagesUrl(""), /conversation URN/);
  assert.throws(() => protocol.buildThreadMessagesUrl(null), /conversation URN/);
  assert.throws(() => protocol.buildThreadMessagesUrl("not-a-urn"), /conversation URN/);
  assert.throws(() => protocol.buildThreadMessagesUrl(SELF), /conversation URN/);
});

test("thread elements are read from the sync-token collection", () => {
  assert.equal(protocol.threadMessageElements(threadResponse([{}, {}])).length, 2);
  // An unexpected shape is empty, not a crash: this pass rides along with a
  // sync it must never fail.
  assert.equal(protocol.threadMessageElements(null).length, 0);
  assert.equal(protocol.threadMessageElements({ data: {} }).length, 0);
  assert.equal(protocol.threadMessageElements(threadResponse([null, undefined])).length, 0);
});

test("proves reciprocity from content-free metadata in one capture", () => {
  const direction = protocol.summarizeThreadDirection([
    metadataOnlyMessage(1_721_341_234_567, SELF),
    metadataOnlyMessage(1_721_100_000_000, "urn:li:fsd_profile:target-456"),
  ], SELF);
  assert.equal(direction.reciprocal, true);
  assert.equal(direction.lastSentAt, 1_721_341_234_567);
  assert.equal(direction.lastReceivedAt, 1_721_100_000_000);
  assert.equal(direction.sentCount, 1);
  assert.equal(direction.receivedCount, 1);
  assert.deepEqual(
    Array.from(direction.recentMessageMetadata, (entry) => ({ ...entry })),
    [
      { deliveredAt: 1_721_341_234_567, direction: "sent" },
      { deliveredAt: 1_721_100_000_000, direction: "received" },
    ],
  );
});

test("the five-message privacy bound cannot be bypassed by a larger caller limit", () => {
  const messages = [];
  for (let index = 0; index < 12; index++) {
    messages.push(metadataOnlyMessage(1_700_000_000_000 + index * 1_000, SELF));
  }
  const direction = protocol.summarizeThreadDirection(messages, SELF, 100);
  assert.equal(direction.sampled, protocol.RECENT_MESSAGE_METADATA_LIMIT);
  assert.equal(direction.sentCount, 5);
  assert.equal(direction.lastSentAt, 1_700_000_000_000 + 11 * 1_000);
});

test("a reply older than the newest five is not claimed as observed", () => {
  const messages = [metadataOnlyMessage(1_700_000_000_000, "urn:li:fsd_profile:target-456")];
  for (let index = 1; index <= 6; index++) {
    messages.push(metadataOnlyMessage(1_700_000_000_000 + index * 1_000, SELF));
  }
  const direction = protocol.summarizeThreadDirection(messages, SELF);
  assert.equal(direction.reciprocal, false);
  assert.equal(direction.receivedCount, 0);
});

test("missing identity or unusable events never invent reciprocity", () => {
  const messages = [
    { deliveredAt: 0, sender: { hostIdentityUrn: SELF } },
    { deliveredAt: 1_721_341_234_567, sender: {} },
    metadataOnlyMessage(1_721_100_000_000, SELF),
  ];
  assert.equal(protocol.summarizeThreadDirection(messages, null).sampled, 0);
  const valid = protocol.summarizeThreadDirection(messages, SELF);
  assert.equal(valid.sampled, 1);
  assert.equal(valid.reciprocal, false);
});

test("the listing summary carries a thread URN only for the internal follow-up", () => {
  const summary = protocol.summarizeLastInteraction(
    { entityUrn: CONVERSATION_URN, messages: { elements: [] } },
    SELF,
  );
  assert.equal(summary.conversationUrn, CONVERSATION_URN);
});
