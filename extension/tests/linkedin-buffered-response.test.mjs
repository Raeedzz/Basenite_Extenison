import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { bufferedResponse } from "../lib/linkedin-session.js";

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.url = `http://127.0.0.1:${server.address().port}/`;
  return server;
}

test("a body that stalls after the headers ends at the timeout instead of hanging the sync", async () => {
  const server = await serve((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"elements":[');
  });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await assert.rejects(
      (async () => bufferedResponse(await fetch(server.url, { signal: controller.signal })))(),
      { name: "AbortError" },
    );
    clearTimeout(timer);
    assert.ok(Date.now() - started < 2000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a buffered response keeps its status, headers and body", async () => {
  const server = await serve((request, response) => {
    if (request.url === "/empty") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(429, { "retry-after": "7", "content-type": "application/json" });
    response.end('{"paging":{"total":3}}');
  });
  try {
    const limited = await bufferedResponse(await fetch(server.url));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "7");
    assert.deepEqual(await limited.json(), { paging: { total: 3 } });
    const empty = await bufferedResponse(await fetch(`${server.url}empty`));
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), "");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
