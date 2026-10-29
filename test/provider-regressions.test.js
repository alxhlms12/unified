import test from "node:test";
import assert from "node:assert/strict";
import * as tidal from "../src/providers/tidal.js";
import * as deezer from "../src/providers/deezer.js";
import * as soundcloud from "../src/providers/soundcloud.js";

const realFetch = globalThis.fetch;
function response(body, status = 200, headers = { "content-type": "application/json" }) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}
function jwtWithExpiry() {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, userId: "123" })}.sig`;
}

test("Tidal adapter exposes the generic resource method names", () => {
  for (const key of ["info", "album", "artist", "playlist", "lyrics", "stream", "findByIsrc", "search", "status"]) {
    assert.equal(typeof tidal[key], "function", `tidal.${key} must exist for generic routes`);
  }
});

test("Tidal ISRC matching uses the native /tracks?isrc= filter", async t => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.hostname === "auth.tidal.com") return response({ access_token: "tidal-test-token", expires_in: 3600 });
    if (url.hostname === "api.tidal.com") return response({ totalNumberOfItems: 1, items: [{ id: 123, title: "Fixture", isrc: "USABC2612345" }] });
    throw new Error(`Unexpected host: ${url.hostname}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const result = await tidal.findByIsrc({ "t-cid": "tidal-isrc-test", "t-cs": "secret", "t-rt": "refresh-isrc-test", "t-cc": "US" }, "USABC2612345");
  assert.equal(result.items.length, 1);
  const request = calls.find(call => call.url.hostname === "api.tidal.com");
  assert.equal(request.url.pathname, "/v1/tracks");
  assert.equal(request.url.searchParams.get("isrc"), "USABC2612345");
});

test("Deezer ARL-to-JWT handshake uses POST instead of the method that returns 405", async t => {
  const calls = [];
  const jwt = jwtWithExpiry();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.hostname === "auth.deezer.com") return response({ jwt }, 200, { "content-type": "text/plain", "set-cookie": "dzr_uniq_id=test-cookie; Path=/; HttpOnly" });
    if (url.hostname === "pipe.deezer.com") {
      assert.equal(new Headers(init.headers).get("cookie"), "dzr_uniq_id=test-cookie");
      const node = { id: "55", title: "Fixture", ISRC: "USABC2612345", duration: 180, contributors: { edges: [] } };
      const body = { data: { search: { results: { tracks: { edges: [{ node }], pageInfo: { hasNextPage: false } } } } } };
      return response(body);
    }
    throw new Error(`Unexpected host: ${url.hostname}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const result = await deezer.search({ "d-arl": "deezer-arl-test" }, "USABC2612345", "track", 10, 0);
  assert.equal(result.items.length, 1);
  assert.equal(calls[0].url.hostname, "auth.deezer.com");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[1].url.hostname, "pipe.deezer.com");
  assert.equal(calls[1].init.method, "POST");
});

test("SoundCloud ISRC lookup attempts the query and reports that its search is not a native ISRC filter", async t => {
  let requestUrl;
  globalThis.fetch = async input => {
    requestUrl = new URL(input);
    return response({ collection: [], total_results: 0 });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const result = await soundcloud.findByIsrc({ "sc-cid": "soundcloud-test-client-id" }, "USABC2612345");
  assert.equal(requestUrl.pathname, "/search/tracks");
  assert.equal(requestUrl.searchParams.get("q"), "USABC2612345");
  assert.equal(result.items.length, 0);
  assert.match(result.limitation, /does not provide a dedicated ISRC search filter/i);
});

test("SoundCloud ISRC matching fetches candidate metadata before exact comparison", async t => {
  const calls = [];
  globalThis.fetch = async input => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === "/search/tracks") {
      return response({ collection: [{ id: 91, title: "Fixture", duration: 123000, user: { id: 8, username: "Artist" } }] });
    }
    if (url.pathname === "/tracks/91") {
      return response({ id: 91, title: "Fixture", duration: 123000, user: { id: 8, username: "Artist" }, publisher_metadata: { isrc: "USABC2612345" } });
    }
    throw new Error(`Unexpected path: ${url.pathname}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const result = await soundcloud.findByIsrc({ "sc-cid": "soundcloud-test-client-id" }, "USABC2612345");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].isrc, "USABC2612345");
  assert.deepEqual(calls.map(url => url.pathname), ["/search/tracks", "/tracks/91"]);
});

test("SoundCloud durations remain in milliseconds during normalization", async () => {
  const { normalizeTrack } = await import("../src/lib.js");
  const track = normalizeTrack("soundcloud", { id: 1, title: "Fixture", duration: 123000 });
  assert.equal(track.durationMs, 123000);
});
