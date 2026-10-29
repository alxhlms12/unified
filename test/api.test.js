import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";

const env = { UNIFIED_VERSION: "test", SOUNDCLOUD_DISCOVERY: "false", YTM_KEY_DISCOVERY: "false" };
async function get(path, headers = {}, runtimeEnv = env) {
  const response = await app.fetch(new Request(`https://unified.test${path}`, { headers }), runtimeEnv);
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

test("root serves Unified metadata, not the Tidal compatibility identity", async () => {
  const { response, body } = await get("/");
  assert.equal(response.status, 200);
  assert.equal(body.name, "Unified Music API");
  assert.equal(body.docs, "/openapi.json");
  assert.equal(body.Repo, undefined);
});

test("health works without provider credentials", async () => {
  const { response, body } = await get("/v1/health");
  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
});

test("providers are listed without leaking credential values", async () => {
  const protectedEnv = { ...env, "t-cid": "test-client-id", "t-cs": "test-secret-value", "t-rt": "test-refresh-token", "d-arl": "test-arl-value", "q-cid": "test-qobuz-id", "q-cs": "test-qobuz-secret", "q-uat": "test-user-token" };
  const { response, body } = await get("/v1/providers", {}, protectedEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(body.providers.map(item => item.provider), ["tidal", "deezer", "qobuz", "youtube-music", "soundcloud"]);
  const serialized = JSON.stringify(body);
  for (const secret of ["test-secret-value", "test-refresh-token", "test-arl-value", "test-qobuz-secret", "test-user-token"]) assert.equal(serialized.includes(secret), false);
});

test("generic search requires q", async () => {
  const { response, body } = await get("/v1/search");
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "missing_parameter");
});

test("generic search uses provider-neutral route and aggregates disabled-provider errors", async () => {
  const { response, body } = await get("/v1/search?q=test&provider=tidal");
  assert.equal(response.status, 200);
  assert.equal(body.provider, "tidal");
  assert.equal(body.partial, true);
  assert.equal(body.errors[0].code, "provider_not_configured");
});

test("Tidal compatibility search validates hifi-api query conventions", async () => {
  const { response, body } = await get("/search/");
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_search");
});

test("Widevine compatibility route is intentionally disabled", async () => {
  const { response, body } = await get("/widevine");
  assert.equal(response.status, 501);
  assert.equal(body.error.code, "drm_license_proxy_disabled");
});

test("not found returns JSON error", async () => {
  const { response, body } = await get("/not-a-route");
  assert.equal(response.status, 404);
  assert.equal(body.error.code, "not_found");
});

test("OpenAPI schema describes Unified routes", async () => {
  const { response, body } = await get("/openapi.json");
  assert.equal(response.status, 200);
  assert.equal(body.openapi, "3.1.0");
  assert.ok(body.paths["/v1/search"]);
  assert.equal(body.paths["/search/"], undefined);
});

test("configured API keys are enforced on private routes", async () => {
  const lockedEnv = { ...env, UNIFIED_API_KEY: "unit-test-key" };
  const unauthenticated = await get("/v1/providers", {}, lockedEnv);
  assert.equal(unauthenticated.response.status, 401);
  const authorized = await get("/v1/providers", { "x-api-key": "unit-test-key" }, lockedEnv);
  assert.equal(authorized.response.status, 200);
});

test("OPTIONS requests bypass provider authentication and receive CORS headers", async () => {
  const lockedEnv = { ...env, UNIFIED_API_KEY: "unit-test-key" };
  const response = await app.fetch(new Request("https://unified.test/v1/providers", { method: "OPTIONS", headers: { origin: "https://client.example", "access-control-request-method": "GET" } }), lockedEnv);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("generic Tidal track metadata route calls the shared adapter interface", async t => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === "auth.tidal.com") {
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), { status: 200 });
    }
    if (url.hostname === "api.tidal.com" && url.pathname === "/v1/tracks/123") {
      return new Response(JSON.stringify({
        id: 123, title: "Fixture", duration: 180, isrc: "USABC2612345",
        artists: [{ id: 9, name: "Fixture Artist" }],
        album: { id: 456, title: "Fixture Album", cover: "01234567-89ab-cdef-0123-456789abcdef" }
      }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const credentials = { ...env, "t-cid": "route-test-client", "t-cs": "secret", "t-rt": "route-test-refresh", "t-cc": "US" };
  const { response, body } = await get("/v1/tracks/tidal:track:123", {}, credentials);
  assert.equal(response.status, 200);
  assert.equal(body.data.id, "tidal:track:123");
  assert.equal(body.data.title, "Fixture");
  assert.equal(body.data.durationMs, 180000);
  assert.equal(body.data.artists[0].name, "Fixture Artist");
});
