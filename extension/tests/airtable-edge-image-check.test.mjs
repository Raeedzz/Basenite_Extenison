import test from "node:test";
import assert from "node:assert/strict";

const { fetchImage, setImageFetcher, MAX_IMAGE_BYTES } = await import("../lib/image-check.js");

const URL = "https://media.licdn.com/dms/image/v2/X/profile-displayphoto-shrink_800_800/0?e=9999999999&t=abc";

function cdnThat(respond) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, credentials: init.credentials });
    return respond();
  };
  return calls;
}

test("an image downloads as its bytes, without cookies", async () => {
  setImageFetcher(null);
  const calls = cdnThat(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg; charset=binary" } }));
  const got = await fetchImage(URL);
  assert.equal(got.contentType, "image/jpeg");
  assert.deepEqual([...got.bytes], [1, 2, 3]);
  assert.deepEqual(calls, [{ url: URL, credentials: "omit" }]);
});

test("a refused, non-image, empty, oversized or unreachable download is null", async () => {
  setImageFetcher(null);
  cdnThat(() => new Response(null, { status: 403 }));
  assert.equal(await fetchImage(URL), null);
  cdnThat(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
  assert.equal(await fetchImage(URL), null);
  cdnThat(() => new Response(new Uint8Array(0), { headers: { "content-type": "image/png" } }));
  assert.equal(await fetchImage(URL), null);
  cdnThat(() => new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), { headers: { "content-type": "image/png" } }));
  assert.equal(await fetchImage(URL), null);
  cdnThat(() => { throw new TypeError("Failed to fetch"); });
  assert.equal(await fetchImage(URL), null);
});
