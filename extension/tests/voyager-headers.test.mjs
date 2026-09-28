/**
 * What the graph engine is allowed to tell LinkedIn about itself.
 *
 * The engine used to send `x-li-track` with a randomized clientVersion —
 * "1.13." plus four random digits, a version that was never shipped. Voyager
 * validates that field, and answers a request carrying an invented version with
 * HTTP 200, `paging.total: 0`, and an empty element list.
 *
 * Not a 403. Not an error. Nothing. So every people search, every mutual
 * lookup, and every company capture reported "Found 0 people" while the
 * account, the cookie, the CSRF token, the decoration version, and the parser
 * were all working perfectly. It was verified against the live endpoint, same
 * query and same cookie, one header apart: without it, 250 results; with it,
 * zero.
 *
 * A test that fetched LinkedIn could not run in CI and would rot the moment
 * the session expired, so this holds the contract at the source instead: the
 * engine may identify its protocol and its language, and may carry a
 * per-request tracking id, but it may not make claims about a client version
 * it cannot honour. Deleting this test to re-add the header re-breaks search
 * silently, which is the whole failure mode it exists to prevent.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GRAPH_ENGINE = readFileSync(
  fileURLToPath(new URL("../background/linkedin-graph.js", import.meta.url)),
  "utf8",
);

/** The header builder's body, without the comment block above it. */
function stealthHeadersBody() {
  const start = GRAPH_ENGINE.indexOf("function stealthHeaders(");
  assert.notEqual(start, -1, "stealthHeaders() is gone — this test needs updating with it");
  const open = GRAPH_ENGINE.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < GRAPH_ENGINE.length; index++) {
    if (GRAPH_ENGINE[index] === "{") depth++;
    else if (GRAPH_ENGINE[index] === "}") {
      depth--;
      if (depth === 0) return GRAPH_ENGINE.slice(start, index + 1);
    }
  }
  throw new Error("stealthHeaders() body is unbalanced");
}

test("the graph engine declares no client version to LinkedIn", () => {
  const body = stealthHeadersBody();
  assert.ok(
    !/x-li-track/i.test(body),
    "x-li-track is back in stealthHeaders(). Voyager answers a request carrying an "
    + "unshipped clientVersion with 200 and zero results, which silently breaks people "
    + "search, mutual finding, and company capture all at once.",
  );
  assert.ok(
    !/clientVersion|mpVersion/.test(body),
    "stealthHeaders() names a client version. Any value here is a claim that has to stay "
    + "true against whatever LinkedIn is shipping; an invented one returns zero results.",
  );
});

test("no other request path smuggles the header back in", () => {
  // stealthHeaders() is the only builder, but a caller can always spread its
  // own extras onto the result.
  const offenders = GRAPH_ENGINE
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /["']x-li-track["']\s*:/.test(line));
  assert.deepEqual(
    offenders,
    [],
    `x-li-track is set at line(s) ${offenders.map((o) => o.number).join(", ")}`,
  );
});

test("the headers Voyager does need are still sent", () => {
  const body = stealthHeadersBody();
  // The CSRF token and the rest.li protocol version are not optional: without
  // them the endpoint 403s and 400s respectively, which would be a loud
  // failure rather than a silent one, but a failure all the same.
  assert.match(body, /csrf-token/, "the CSRF token is required by every Voyager endpoint");
  assert.match(body, /x-restli-protocol-version/, "Voyager needs the rest.li protocol version");
  // A per-request tracking id is a tracking id, not a claim about the client;
  // it was verified to make no difference to the result either way.
  assert.match(body, /x-li-page-instance/, "the page instance is harmless and expected");
});
