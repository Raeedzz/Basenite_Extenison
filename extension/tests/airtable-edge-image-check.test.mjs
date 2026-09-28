import test from "node:test";
import assert from "node:assert/strict";

const { dropBrokenImages, setImageChecker } = await import(
  "/Users/raeedz/Goonware/workspaces/Basenite_Extenison/big-one/extension/lib/image-check.js");

const URL = "https://media.licdn.com/dms/image/v2/X/profile-displayphoto-shrink_800_800/0?e=9999999999&t=abc";
const item = () => ({ fields: { fldPhoto: [{ url: URL, filename: "x.jpg" }] } });

function cdnThat(headBehaviour) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(init.method);
    if (init.method === "HEAD") return headBehaviour();
    return new Response("x", { status: 206, headers: { "content-type": "image/jpeg" } });
  };
  return calls;
}

test("HEAD 405 falls back to a ranged GET", async () => {
  setImageChecker(null);
  const calls = cdnThat(() => new Response(null, { status: 405 }));
  const one = item();
  await dropBrokenImages([one], ["fldPhoto"]);
  assert.deepEqual(calls, ["HEAD", "GET"]);
  assert.ok(one.fields.fldPhoto);
});

test("a HEAD refused with 403 falls back to the ranged GET", async () => {
  setImageChecker(null);
  const calls = cdnThat(() => new Response(null, { status: 403 }));
  const one = item();
  await dropBrokenImages([one], ["fldPhoto"]);
  assert.deepEqual(calls, ["HEAD", "GET"], `requests made: ${calls}`);
  assert.ok(one.fields.fldPhoto, "an image the ranged GET loads was dropped");
});

test("a HEAD that throws falls back to the ranged GET", async () => {
  setImageChecker(null);
  const calls = cdnThat(() => { throw new TypeError("Failed to fetch"); });
  const one = item();
  await dropBrokenImages([one], ["fldPhoto"]);
  assert.deepEqual(calls, ["HEAD", "GET"], `requests made: ${calls}`);
  assert.ok(one.fields.fldPhoto);
});
