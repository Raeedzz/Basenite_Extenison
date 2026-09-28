/**
 * Privacy-minimizing helpers for LinkedIn Messenger metadata.
 *
 * This is a classic script (rather than an ES module) so the service worker can
 * inject it into the same isolated world as linkedin-mutuals.js. It deliberately
 * exposes only identity, timestamp, and direction helpers. Message bodies,
 * subjects, and rendered content are never read.
 */
(function (root) {
  const CONVERSATIONS_QUERY_ID = "messengerConversations.9501074288a12f3ae9e3c7ea243bccbf";
  const CONVERSATIONS_BY_RECIPIENTS_WITH_DRAFTS_QUERY_ID =
    "messengerConversations.395d9022591a61de801254af1334a059";
  const CONVERSATIONS_BY_RECIPIENTS_QUERY_ID =
    "messengerConversations.9c3ab648b616451570c715e4a184465e";
  const MESSAGES_QUERY_ID = "messengerMessages.5846eeb71c981f11e0134cb6626cc314";
  const MESSAGING_GRAPHQL_PATH = "/voyager/api/voyagerMessagingGraphQL/graphql";
  const MESSAGE_DRAFTS_PATH = "/voyager/api/voyagerMessagingDashMessengerMessageDrafts";
  // Delivery endpoint. Distinct from the draft resource above: reaching this
  // path actually sends a message, so it is only ever driven by an explicit,
  // per-message human confirmation carried through as a confirmation token.
  const SEND_MESSAGES_PATH = "/voyager/api/voyagerMessagingDashMessengerMessages";
  const PROFILE_URN = /^urn:li:(?:fsd_profile|fs_profile|fs_miniProfile):([^,)]+)$/;
  const LINKEDIN_URN = /^urn:li:[a-zA-Z0-9_]+:[^\r\n]{1,1900}$/;
  const CONVERSATION_URN = /^urn:li:msg_conversation:[^\r\n]{1,1900}$/;
  const MAX_DRAFT_TEXT_LENGTH = 8_000;
  // A small rolling window is enough to establish recent reciprocity and
  // cadence without retaining message contents or an unbounded thread history.
  const RECENT_MESSAGE_METADATA_LIMIT = 5;
  const PRIVATE_MESSAGE_KEYS = new Set(["body", "renderContent", "subject", "text"]);

  function identityKey(value) {
    if (typeof value !== "string") return null;
    const match = value.match(PROFILE_URN);
    return match ? match[1] : null;
  }

  function canonicalProfileUrn(value) {
    const key = identityKey(value);
    return key ? `urn:li:fsd_profile:${key}` : null;
  }

  function profileUrnFromRawId(rawId) {
    if (typeof rawId !== "string" || !rawId || /[(),]/.test(rawId)) return null;
    return `urn:li:fsd_profile:${rawId}`;
  }

  /**
   * /voyager/api/me has changed wrappers over time. Walk only identity-bearing
   * fields and explicitly skip every field that could carry message content.
   */
  function extractSelfProfileUrn(value) {
    const queue = [{ value, depth: 0 }];
    const seen = new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      const node = current.value;
      if (typeof node === "string") {
        const urn = canonicalProfileUrn(node);
        if (urn) return urn;
        continue;
      }
      if (!node || typeof node !== "object" || current.depth > 10 || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) queue.push({ value: item, depth: current.depth + 1 });
        continue;
      }
      for (const key of ["hostIdentityUrn", "profileUrn", "entityUrn", "miniProfileUrn"]) {
        const urn = canonicalProfileUrn(node[key]);
        if (urn) return urn;
      }
      for (const key of Object.keys(node)) {
        if (PRIVATE_MESSAGE_KEYS.has(key)) continue;
        const child = node[key];
        if (child && typeof child === "object") {
          queue.push({ value: child, depth: current.depth + 1 });
        }
      }
    }
    return null;
  }

  function conversationElements(response) {
    const elements = response?.data?.messengerConversationsByCategoryQuery?.elements;
    return Array.isArray(elements) ? elements : [];
  }

  function recipientConversationElements(response) {
    const elements = response?.data?.messengerConversationsByRecipients?.elements;
    return Array.isArray(elements) ? elements : [];
  }

  function participants(conversation) {
    if (Array.isArray(conversation?.conversationParticipants)) {
      return conversation.conversationParticipants;
    }
    const elements = conversation?.conversationParticipants?.elements;
    return Array.isArray(elements) ? elements : [];
  }

  function conversationHasParticipant(conversation, targetProfileUrn) {
    const targetKey = identityKey(targetProfileUrn);
    if (!targetKey) return false;
    return participants(conversation).some(
      (participant) => identityKey(participant?.hostIdentityUrn) === targetKey,
    );
  }

  function directConversationBetween(conversation, selfProfileUrn, targetProfileUrn) {
    const selfKey = identityKey(selfProfileUrn);
    const targetKey = identityKey(targetProfileUrn);
    if (!selfKey || !targetKey || selfKey === targetKey || conversation?.groupChat === true) return false;
    const memberKeys = new Set(
      participants(conversation)
        .map((participant) => identityKey(participant?.hostIdentityUrn))
        .filter(Boolean),
    );
    // LinkedIn can omit the mailbox owner from this collection, but a direct
    // thread must never contain a third distinct member.
    return memberKeys.has(targetKey)
      && [...memberKeys].every((key) => key === selfKey || key === targetKey);
  }

  function conversationUrn(conversation) {
    const value = conversation?.entityUrn || conversation?.conversationUrn || null;
    return typeof value === "string" && CONVERSATION_URN.test(value) ? value : null;
  }

  function draftEntityUrn(conversation) {
    const elements = conversation?.draftMessages?.elements;
    if (!Array.isArray(elements)) return null;
    for (const item of elements) {
      const value = typeof item === "string" ? item : item?.entityUrn;
      if (typeof value === "string" && LINKEDIN_URN.test(value)) return value;
    }
    return null;
  }

  function requiredUrn(value, name) {
    if (typeof value !== "string" || !LINKEDIN_URN.test(value)) {
      throw new TypeError(`${name} must be a LinkedIn URN`);
    }
    return value;
  }

  function requiredDraftText(value) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError("Draft text is required");
    if (value.length > MAX_DRAFT_TEXT_LENGTH) {
      throw new TypeError(`Draft text must be ${MAX_DRAFT_TEXT_LENGTH} characters or fewer`);
    }
    return value;
  }

  function buildCreateDraftRequest({ mailboxUrn, conversationUrn: threadUrn, text, originToken }) {
    const mailbox = requiredUrn(mailboxUrn, "mailboxUrn");
    const conversation = requiredUrn(threadUrn, "conversationUrn");
    const token = typeof originToken === "string" && /^[a-zA-Z0-9-]{16,128}$/.test(originToken)
      ? originToken
      : null;
    if (!token) throw new TypeError("originToken is required");
    return {
      url: `${MESSAGE_DRAFTS_PATH}?mailboxUrn=${encodeURIComponent(mailbox)}`,
      body: {
        body: { text: requiredDraftText(text), attributes: [] },
        originToken: token,
        conversationUrn: conversation,
      },
    };
  }

  function buildUpdateDraftRequest({ draftEntityUrn: entityUrn, text }) {
    const draftUrn = requiredUrn(entityUrn, "draftEntityUrn");
    return {
      url: `${MESSAGE_DRAFTS_PATH}/${encodeURIComponent(draftUrn)}`,
      body: {
        patch: {
          $set: {
            body: { text: requiredDraftText(text), attributes: [] },
          },
        },
      },
    };
  }

  /**
   * A send is only ever issued after a human reviewed the exact recipient and
   * text and confirmed that specific message. The confirmation token is that
   * approval made explicit at the protocol boundary and doubles as LinkedIn's
   * client-generated dedupe key, so a retry can never deliver twice.
   */
  function requiredConfirmationToken(value) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9-]{16,128}$/.test(value)) {
      throw new TypeError("A per-message confirmation token is required to send");
    }
    return value;
  }

  /**
   * Build the delivery request for a single, already-confirmed message to one
   * existing direct conversation. There is deliberately no multi-recipient,
   * list, or batch form: callers send exactly one reviewed message at a time.
   */
  function buildSendMessageRequest({ mailboxUrn, conversationUrn: threadUrn, text, confirmationToken }) {
    const mailbox = requiredUrn(mailboxUrn, "mailboxUrn");
    const conversation = requiredUrn(threadUrn, "conversationUrn");
    const token = requiredConfirmationToken(confirmationToken);
    return {
      url: `${SEND_MESSAGES_PATH}?action=createMessage`,
      body: {
        message: {
          body: { text: requiredDraftText(text), attributes: [] },
          renderContentUnions: [],
          conversationUrn: conversation,
        },
        mailboxUrn: mailbox,
        dedupeByClientGenerateToken: token,
      },
    };
  }

  function numericTimestamp(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8_640_000_000_000_000
      ? Math.trunc(timestamp)
      : null;
  }

  /**
   * The newest few message events, stripped down to timestamp and direction.
   *
   * LinkedIn does not guarantee the response order, so sorting here also fixes
   * the old assumption that `messages.elements[0]` was always the latest event.
   * No message content field is inspected.
   */
  function recentMessageMetadata(
    conversation,
    selfProfileUrn,
    limit = RECENT_MESSAGE_METADATA_LIMIT,
  ) {
    const selfKey = identityKey(selfProfileUrn);
    const elements = conversation?.messages?.elements;
    if (!selfKey || !Array.isArray(elements)) return [];
    const boundedLimit = Math.max(
      1,
      Math.min(RECENT_MESSAGE_METADATA_LIMIT, Math.trunc(Number(limit) || RECENT_MESSAGE_METADATA_LIMIT)),
    );
    const observations = new Map();
    for (const message of elements) {
      const deliveredAt = numericTimestamp(message?.deliveredAt);
      const senderKey = identityKey(message?.sender?.hostIdentityUrn);
      if (!deliveredAt || !senderKey) continue;
      const direction = senderKey === selfKey ? "sent" : "received";
      observations.set(`${deliveredAt}:${direction}`, { deliveredAt, direction });
    }
    return [...observations.values()]
      .sort((left, right) => right.deliveredAt - left.deliveredAt)
      .slice(0, boundedLimit);
  }

  function mergeRecentMessageMetadata(...lists) {
    const observations = new Map();
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const observation of list) {
        const deliveredAt = numericTimestamp(observation?.deliveredAt);
        const direction = observation?.direction;
        if (!deliveredAt || (direction !== "sent" && direction !== "received")) continue;
        observations.set(`${deliveredAt}:${direction}`, { deliveredAt, direction });
      }
    }
    return [...observations.values()]
      .sort((left, right) => right.deliveredAt - left.deliveredAt)
      .slice(0, RECENT_MESSAGE_METADATA_LIMIT);
  }

  /**
   * Build the follow-up query for one conversation.
   *
   * The inbox listing only exposes one message per conversation. This private
   * first-party query is therefore needed to inspect a bounded recent window.
   * A conversation URN contains parentheses of its own; those are value data,
   * not GraphQL variable syntax, and must be encoded explicitly because
   * encodeURIComponent leaves parentheses unchanged.
   */
  function buildThreadMessagesUrl(threadUrn) {
    if (typeof threadUrn !== "string" || !CONVERSATION_URN.test(threadUrn)) {
      throw new TypeError("conversationUrn must be a LinkedIn conversation URN");
    }
    const urn = threadUrn;
    const encoded = encodeURIComponent(urn)
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29");
    return `${MESSAGING_GRAPHQL_PATH}?queryId=${MESSAGES_QUERY_ID}&variables=(conversationUrn:${encoded})`;
  }

  /** The only verified collection path in the thread-query response. */
  function threadMessageElements(response) {
    const elements = response?.data?.messengerMessagesBySyncToken?.elements;
    return Array.isArray(elements) ? elements.filter(Boolean) : [];
  }

  /**
   * Reduce a thread response to content-free facts from at most five messages.
   * The cap is enforced here because LinkedIn's gateway has historically
   * ignored a requested count. No body, subject, rendered content, attachment,
   * reaction, or footer field is read.
   */
  function summarizeThreadDirection(
    messages,
    selfProfileUrn,
    limit = RECENT_MESSAGE_METADATA_LIMIT,
  ) {
    const boundedLimit = Math.max(
      1,
      Math.min(RECENT_MESSAGE_METADATA_LIMIT, Math.trunc(Number(limit) || RECENT_MESSAGE_METADATA_LIMIT)),
    );
    const recent = recentMessageMetadata(
      { messages: { elements: Array.isArray(messages) ? messages : [] } },
      selfProfileUrn,
      boundedLimit,
    );
    const sent = recent.filter((entry) => entry.direction === "sent");
    const received = recent.filter((entry) => entry.direction === "received");
    return {
      lastSentAt: sent[0]?.deliveredAt ?? null,
      lastReceivedAt: received[0]?.deliveredAt ?? null,
      reciprocal: sent.length > 0 && received.length > 0,
      sentCount: sent.length,
      receivedCount: received.length,
      sampled: recent.length,
      recentMessageMetadata: recent,
    };
  }

  /**
   * Numeric timestamp on a draft, without reading the draft itself.
   *
   * A draft entity carries a body and, depending on the response shape, one of
   * several edit timestamps. Only numeric fields from this allowlist are read —
   * `body`, `renderContent`, `subject` and `text` are never touched, so an
   * unsent draft can be *noticed* without its contents ever being seen.
   */
  function draftTimestamp(conversation) {
    const elements = conversation?.draftMessages?.elements;
    if (!Array.isArray(elements)) return null;
    const ALLOWED = ["lastEditedAt", "deliveredAt", "createdAt", "lastModifiedAt"];
    for (const element of elements) {
      if (!element || typeof element !== "object") continue;
      for (const key of ALLOWED) {
        const value = numericTimestamp(element[key]);
        if (value) return value;
      }
    }
    return null;
  }

  /**
   * Whether an unsent draft exists in this thread.
   *
   * This is the single most under-used signal LinkedIn exposes. A draft means the
   * user themselves decided this person was worth messaging and got interrupted —
   * their own intent, recoverable, and stronger than anything that could be
   * inferred about the other person. Presence only; the text stays in LinkedIn.
   */
  function hasDraft(conversation) {
    const elements = conversation?.draftMessages?.elements;
    return Array.isArray(elements) && elements.length > 0;
  }

  function isMuted(conversation) {
    const status = conversation?.notificationStatus;
    return typeof status === "string" && status.toUpperCase().includes("MUTE");
  }

  /**
   * Return the only fields allowed to cross the extension bridge. The mutually
   * exclusive messageSent/messageReceived booleans describe the latest event;
   * recentMessageMetadata carries up to five timestamp/direction pairs so one
   * sync can establish recent reciprocity instead of waiting for future syncs.
   *
   * The posture fields (`hasDraft`, `lastReadAt`, `unreadCount`, `muted`) come
   * from the same response at no extra cost and answer questions the timestamp
   * alone cannot: whether the user began a message and abandoned it, and — when
   * the other person wrote last — whether their message was actually read. An
   * unanswered message that was *seen* is a different situation from one that was
   * never opened, and only the first is a social debt.
   */
  function summarizeLastInteraction(conversation, selfProfileUrn) {
    const recent = recentMessageMetadata(conversation, selfProfileUrn);
    const latest = recent[0] || null;
    const sent = recent.find((entry) => entry.direction === "sent") || null;
    const received = recent.find((entry) => entry.direction === "received") || null;
    const lastActivityAt = numericTimestamp(conversation?.lastActivityAt);
    const lastInteractionAt = latest?.deliveredAt ?? lastActivityAt;
    const messageSent = latest?.direction === "sent";
    const messageReceived = latest?.direction === "received";
    const unread = Number(conversation?.unreadCount);
    return {
      hasInteracted: lastInteractionAt !== null,
      messageSent,
      messageReceived,
      lastSentAt: sent?.deliveredAt ?? null,
      lastReceivedAt: received?.deliveredAt ?? null,
      reciprocal: sent !== null && received !== null,
      lastInteractionAt,
      lastInteractionDirection: messageSent ? "sent" : messageReceived ? "received" : null,
      recentMessageMetadata: recent,
      // Used only inside the extension to fetch the bounded thread window. It
      // is deliberately omitted by rowsWithInteractionSnapshot before upload.
      conversationUrn: conversationUrn(conversation),
      hasDraft: hasDraft(conversation),
      draftUpdatedAt: draftTimestamp(conversation),
      lastReadAt: numericTimestamp(conversation?.lastReadAt),
      unreadCount: Number.isFinite(unread) && unread > 0 ? Math.trunc(unread) : 0,
      muted: isMuted(conversation),
    };
  }

  function oldestActivityAt(conversations) {
    const timestamps = conversations
      .map((conversation) => numericTimestamp(conversation?.lastActivityAt))
      .filter((value) => value !== null);
    return timestamps.length > 0 ? Math.min(...timestamps) : null;
  }

  /**
   * Convert direct conversations into [memberId, summary] entries. Group
   * threads are excluded because their latest sender/timestamp cannot safely
   * be attributed to one selected person without reading message contents.
   */
  function directInteractionEntries(conversations, selfProfileUrn) {
    const selfKey = identityKey(selfProfileUrn);
    if (!selfKey || !Array.isArray(conversations)) return [];
    const newestByMember = new Map();
    for (const conversation of conversations) {
      if (conversation?.groupChat === true) continue;
      const otherMembers = new Set(
        participants(conversation)
          .map((participant) => identityKey(participant?.hostIdentityUrn))
          .filter((key) => key && key !== selfKey),
      );
      // LinkedIn sometimes omits the mailbox owner from participants (one
      // remaining member) and sometimes includes both people (still one other).
      if (otherMembers.size !== 1) continue;
      const [memberId] = otherMembers;
      const summary = summarizeLastInteraction(conversation, selfProfileUrn);
      const existing = newestByMember.get(memberId);
      if (!existing || Number(summary.lastInteractionAt || 0) > Number(existing.lastInteractionAt || 0)) {
        newestByMember.set(memberId, {
          ...summary,
          recentMessageMetadata: mergeRecentMessageMetadata(
            summary.recentMessageMetadata,
            existing?.recentMessageMetadata,
          ),
        });
      } else {
        existing.recentMessageMetadata = mergeRecentMessageMetadata(
          existing.recentMessageMetadata,
          summary.recentMessageMetadata,
        );
      }
    }
    return [...newestByMember.entries()];
  }

  function buildConversationsUrl(mailboxUrn, lastUpdatedBefore, count = 20) {
    const canonicalMailboxUrn = canonicalProfileUrn(mailboxUrn);
    const before = numericTimestamp(lastUpdatedBefore);
    const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(count) || 20)));
    if (!canonicalMailboxUrn) throw new TypeError("mailboxUrn must be a LinkedIn profile URN");
    if (!before) throw new TypeError("lastUpdatedBefore must be a positive millisecond timestamp");
    // Same Rest.li GraphQL encoding rule as buildConversationByRecipientsUrl:
    // the variables' structural parens and commas must stay literal and only the
    // URN colons are percent-encoded. URLSearchParams encodes ( ) , too, which
    // the gateway rejects with HTTP 400 — the cause of interaction-sync failures.
    const variables = "(query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX))))," +
      `count:${pageSize},mailboxUrn:${encodeURIComponent(canonicalMailboxUrn)},lastUpdatedBefore:${before})`;
    return `${MESSAGING_GRAPHQL_PATH}?queryId=${CONVERSATIONS_QUERY_ID}&variables=${variables}`;
  }

  function buildConversationByRecipientsUrl(mailboxUrn, recipientUrns, includeDrafts = true) {
    const canonicalMailboxUrn = canonicalProfileUrn(mailboxUrn);
    const recipients = Array.isArray(recipientUrns)
      ? recipientUrns.map(canonicalProfileUrn).filter(Boolean)
      : [];
    if (!canonicalMailboxUrn) throw new TypeError("mailboxUrn must be a LinkedIn profile URN");
    if (recipients.length === 0) throw new TypeError("At least one recipient profile URN is required");
    // LinkedIn's Rest.li GraphQL gateway needs the variables' structural parens
    // and commas kept literal and only the URN colons percent-encoded.
    // URLSearchParams encodes ( ) and , as well, which the gateway rejects (400),
    // so the variables string is assembled by hand with encodeURIComponent on the
    // URN values only.
    const queryId = includeDrafts
      ? CONVERSATIONS_BY_RECIPIENTS_WITH_DRAFTS_QUERY_ID
      : CONVERSATIONS_BY_RECIPIENTS_QUERY_ID;
    const recipientList = recipients.map(encodeURIComponent).join(",");
    const variables = `(mailboxUrn:${encodeURIComponent(canonicalMailboxUrn)},recipients:List(${recipientList}))`;
    return `${MESSAGING_GRAPHQL_PATH}?queryId=${queryId}&variables=${variables}`;
  }

  root.EarthOSLinkedInMessagingProtocol = Object.freeze({
    CONVERSATIONS_QUERY_ID,
    CONVERSATIONS_BY_RECIPIENTS_QUERY_ID,
    CONVERSATIONS_BY_RECIPIENTS_WITH_DRAFTS_QUERY_ID,
    MESSAGES_QUERY_ID,
    MAX_DRAFT_TEXT_LENGTH,
    RECENT_MESSAGE_METADATA_LIMIT,
    MESSAGE_DRAFTS_PATH,
    SEND_MESSAGES_PATH,
    buildConversationsUrl,
    buildThreadMessagesUrl,
    buildConversationByRecipientsUrl,
    buildCreateDraftRequest,
    buildUpdateDraftRequest,
    buildSendMessageRequest,
    canonicalProfileUrn,
    conversationUrn,
    conversationElements,
    conversationHasParticipant,
    directConversationBetween,
    directInteractionEntries,
    draftEntityUrn,
    extractSelfProfileUrn,
    oldestActivityAt,
    profileUrnFromRawId,
    recentMessageMetadata,
    recipientConversationElements,
    summarizeLastInteraction,
    summarizeThreadDirection,
    threadMessageElements,
  });
})(globalThis);
