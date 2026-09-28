import test from "node:test";
import assert from "node:assert/strict";
const H = "./helpers/image-harness.mjs";
const { PEOPLE, person, setup, sink, store } = await import(H);

test("Disconnect while a profile write is in flight: no crash, nothing re-written after", async () => {
  const { base } = setup();
  const inner = globalThis.fetch;
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async (input, init = {}) => {
    if ((init.method || "GET") === "POST" && new URL(String(input)).pathname.endsWith(`/${PEOPLE}`)) await gate;
    return inner(input, init);
  };
  const write = sink.writePeople([person("ada")]).then((t) => ({ t }), (e) => ({ e }));
  await new Promise((r) => setTimeout(r, 300));
  const cleared = sink.clearConfig();
  await new Promise((r) => setTimeout(r, 50));
  release();
  await cleared;
  const { e } = await write;
  const left = [...store.keys()].filter((k) => /^airtable_/.test(k));
  assert.equal(e, undefined, `write crashed: ${e?.message}`);
  assert.deepEqual(left, [], "keys re-written after Disconnect");
});
