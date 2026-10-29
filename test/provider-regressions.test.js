import test from "node:test";
import assert from "node:assert/strict";
import * as tidal from "../src/providers/tidal.js";
import * as deezer from "../src/providers/deezer.js";
import * as qobuz from "../src/providers/qobuz.js";
import * as soundcloud from "../src/providers/soundcloud.js";
import * as ytmusic from "../src/providers/ytmusic.js";
import { normalizeStreamResult, createRelaySignature, verifyRelaySignature } from "../src/lib.js";

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


test("Tidal track compatibility returns a direct manifest URL and supports Dolby Atmos", async t => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.hostname === "auth.tidal.com") return response({ access_token: "tidal-atmos-token", expires_in: 3600 });
    if (url.hostname === "openapi.tidal.com") {
      const manifestType = url.searchParams.get("manifestType");
      return response({ data: { data: { id: "182", attributes: {
        uri: `https://im-fa.manifest.tidal.com/example.${manifestType === "HLS" ? "m3u8" : "mpd"}?token=1880000000~signature`,
        formats: ["EAC3_JOC"]
      } } } });
    }
    throw new Error(`Unexpected host: ${url.hostname}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { "t-cid": "tidal-atmos-test", "t-cs": "secret", "t-rt": "refresh-atmos-test", "t-cc": "US" };
  const result = await tidal.compatible(env, "/track/", new URL("https://unified.test/track/?id=182&atmos=true&manifestType=HLS"));
  assert.equal(result.data.url, "https://im-fa.manifest.tidal.com/example.m3u8?token=1880000000~signature");
  assert.equal(result.data.manifestType, "HLS");
  assert.equal(result.data.isAtmos, true);
  assert.equal(result.data.audioMode, "DOLBY_ATMOS");
  assert.equal("manifest" in result.data, false);
  const manifestRequest = calls.find(call => call.url.hostname === "openapi.tidal.com");
  assert.equal(manifestRequest.url.pathname, "/v2/trackManifests/182");
  assert.equal(manifestRequest.url.searchParams.get("manifestType"), "HLS");
  assert.equal(manifestRequest.url.searchParams.get("formats"), "EAC3_JOC");
});

test("Tidal generic stream can request MPEG-DASH and emits the common URL schema", async t => {
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === "auth.tidal.com") return response({ access_token: "tidal-dash-token", expires_in: 3600 });
    if (url.hostname === "openapi.tidal.com") return response({ data: { data: { id: "183", attributes: {
      uri: "https://im-fa.manifest.tidal.com/fixture.mpd?token=1880000000~signature",
      formats: ["FLAC_HIRES"]
    } } } });
    throw new Error(`Unexpected host: ${url.hostname}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { "t-cid": "tidal-dash-test", "t-cs": "secret", "t-rt": "refresh-dash-test", "t-cc": "US" };
  const raw = await tidal.stream(env, "183", { manifestType: "MPEG_DASH", quality: "HI_RES_LOSSLESS" });
  const normalized = normalizeStreamResult("tidal", "183", raw);
  assert.equal(normalized.schema, "unified.stream.v1");
  assert.equal(normalized.url, "https://im-fa.manifest.tidal.com/fixture.mpd?token=1880000000~signature");
  assert.equal(normalized.manifestType, "MPEG_DASH");
  assert.equal(normalized.mimeType, "application/dash+xml");
  assert.equal(normalized.isAtmos, false);
});

test("Tidal only claims Atmos when EAC3_JOC is confirmed by the response", async t => {
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === "auth.tidal.com") return response({ access_token: "tidal-atmos-unconfirmed", expires_in: 3600 });
    if (url.hostname === "openapi.tidal.com") return response({ data: { data: { id: "184", attributes: {
      uri: "https://im-fa.manifest.tidal.com/fixture.mpd?token=1880000000~signature"
    } } } });
    throw new Error(`Unexpected host: ${url.hostname}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { "t-cid": "tidal-atmos-unconfirmed", "t-cs": "secret", "t-rt": "refresh-atmos-unconfirmed", "t-cc": "US" };
  const result = await tidal.stream(env, "184", { manifestType: "MPEG_DASH", atmos: true });
  assert.equal(result.isAtmos, false);
  assert.match(result.note, /did not confirm EAC3_JOC/i);
});

test("Tidal playback-info base64 B.T.S JSON decodes to a normal URL", () => {
  const manifest = Buffer.from(JSON.stringify({
    mimeType: "audio/flac", codecs: "flac", urls: ["https://cdn.example.test/track.flac?token=abc"]
  })).toString("base64");
  const normalized = normalizeStreamResult("tidal", "123", {
    manifest, manifestMimeType: "application/vnd.tidal.bts", audioQuality: "HI_RES_LOSSLESS"
  });
  assert.equal(normalized.url, "https://cdn.example.test/track.flac?token=abc");
  assert.equal(normalized.decodedManifest, true);
  assert.equal(normalized.mimeType, "audio/flac");
  assert.equal("manifest" in normalized, false);
});

test("Deezer emits the shared stream schema when Pipe has no clear preview URL", async t => {
  const calls = [];
  const jwt = jwtWithExpiry();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.hostname === "auth.deezer.com") return response({ jwt }, 200, { "content-type": "text/plain" });
    if (url.hostname === "pipe.deezer.com") return response({ errors: [{ message: "Cannot query field preview" }] });
    throw new Error(`Unexpected host: ${url.hostname}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const raw = await deezer.stream({ "d-arl": "deezer-stream-unavailable-test" }, "987");
  const normalized = normalizeStreamResult("deezer", "987", raw);
  assert.equal(normalized.schema, "unified.stream.v1");
  assert.equal(normalized.provider, "deezer");
  assert.equal(normalized.url, null);
  assert.equal(normalized.available, false);
  assert.equal(normalized.playable, false);
  assert.match(normalized.note, /did not expose a clear preview URL/i);
  assert.equal(calls[1].url.hostname, "pipe.deezer.com");
});

test("Qobuz returns a canonical unavailable stream object when its legacy stream endpoint returns 410", async t => {
  globalThis.fetch = async () => response({ error: "gone" }, 410);
  t.after(() => { globalThis.fetch = realFetch; });
  const raw = await qobuz.stream({ "q-cid": "qobuz-test", "q-cs": "secret", "q-uat": "token" }, "q-123", { quality: "HI_RES_LOSSLESS" });
  const normalized = normalizeStreamResult("qobuz", "q-123", raw);
  assert.equal(normalized.schema, "unified.stream.v1");
  assert.equal(normalized.url, null);
  assert.equal(normalized.available, false);
  assert.equal(normalized.playable, false);
  assert.match(normalized.note, /legacy file URL endpoint is gone/i);
});

test("SoundCloud reports CBC-encrypted HLS with the same normalized URL contract but does not decrypt it", async t => {
  const realClientFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === "api-v2.soundcloud.com" && url.pathname === "/tracks/1") {
      return response({ id: 1, title: "Protected fixture", media: { transcodings: [{
        url: "https://api-v2.soundcloud.com/media/fixture/stream/cbc-encrypted-hls",
        preset: "aac_160k",
        format: { protocol: "cbc-encrypted-hls", mime_type: "audio/mp4; codecs=mp4a.40.2" }
      }] } });
    }
    if (url.hostname === "api-v2.soundcloud.com" && url.pathname.includes("/media/")) {
      return response({ url: "https://cdn.example.test/protected.m3u8?token=abc" });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => { globalThis.fetch = realClientFetch; });
  const raw = await soundcloud.stream({ "sc-cid": "soundcloud-test-client-id" }, "1");
  const stream = normalizeStreamResult("soundcloud", "1", raw);
  assert.equal(stream.url, "https://cdn.example.test/protected.m3u8?token=abc");
  assert.equal(stream.manifestType, "HLS");
  assert.equal(stream.encrypted, true);
  assert.equal(stream.playable, false);
  assert.equal(stream.protection, "CBC-HLS");
  assert.match(stream.note, /does not decrypt or bypass/i);
});

test("YouTube Music uses ytm-cookie and creates SAPISIDHASH when SAPISID is present", async t => {
  let captured;
  globalThis.fetch = async (input, init = {}) => {
    captured = { url: new URL(input), init };
    return response({ contents: {} });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  await ytmusic.search({
    "ytm-api-key": "test-key",
    "ytm-cookie": "SAPISID=test-sapisid; SID=test-session",
    "ytm-client-version": "1.20261029.00.00"
  }, "fixture", "track", 10, 0);
  const headers = new Headers(captured.init.headers);
  assert.equal(headers.get("cookie"), "SAPISID=test-sapisid; SID=test-session");
  assert.match(headers.get("authorization"), /^SAPISIDHASH \d+_[a-f0-9]{40}$/);
  assert.equal(captured.url.pathname, "/youtubei/v1/search");
});

test("signed relay URLs expire and validate with the configured secret", async () => {
  const env = { UNIFIED_RELAY_SECRET: "relay-test-secret" };
  const expires = Math.floor(Date.now() / 1000) + 300;
  const signature = await createRelaySignature(env, "deezer", "123", expires);
  assert.equal(await verifyRelaySignature(env, "deezer", "123", String(expires), signature), true);
  assert.equal(await verifyRelaySignature(env, "deezer", "124", String(expires), signature), false);
  assert.equal(await verifyRelaySignature(env, "deezer", "123", String(expires - 900), signature), false);
});
