import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { UNIFIED_VERSION: "test", SOUNDCLOUD_DISCOVERY: "false", YTM_KEY_DISCOVERY: "false" };
async function get(path, headers = {}) {
  const response = await worker.fetch(new Request(`https://unified.test${path}`, { headers }), env);
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

test("root serves Unified metadata and reference", async () => {
  const { response, body } = await get("/");
  assert.equal(response.status, 200);
  assert.equal(body.name, "Unified Music API");
  assert.equal(body.Repo, "https://github.com/binimum/hifi-api");
});

test("health works without provider credentials", async () => {
  const { response, body } = await get("/v1/health");
  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
});

test("providers are listed without leaking credential values", async () => {
  const protectedEnv = { ...env, "t-cid": "test-client-id", "t-cs": "test-secret-value", "t-rt": "test-refresh-token", "d-arl": "test-arl-value", "q-cid": "test-qobuz-id", "q-cs": "test-qobuz-secret", "q-uat": "test-user-token" };
  const response = await worker.fetch(new Request("https://unified.test/v1/providers"), protectedEnv);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.providers.map(item => item.provider), ["tidal", "deezer", "qobuz", "youtube-music", "soundcloud"]);
  const serialized = JSON.stringify(body);
  for (const secret of ["test-secret-value", "test-refresh-token", "test-arl-value", "test-qobuz-secret", "test-user-token"]) assert.equal(serialized.includes(secret), false);
});

test("search requires q", async () => {
  const { response, body } = await get("/v1/search");
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "missing_parameter");
});

test("Tidal compatibility search requires exactly one search query", async () => {
  const { response, body } = await get("/search/");
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_search");
});

test("Widevine route is intentionally disabled", async () => {
  const { response, body } = await get("/widevine");
  assert.equal(response.status, 501);
  assert.equal(body.error.code, "drm_license_proxy_disabled");
});

test("not found returns JSON error", async () => {
  const { response, body } = await get("/nope");
  assert.equal(response.status, 404);
  assert.equal(body.error.code, "not_found");
});

test("OpenAPI schema is available", async () => {
  const { response, body } = await get("/openapi.json");
  assert.equal(response.status, 200);
  assert.equal(body.openapi, "3.1.0");
  assert.ok(body.paths["/v1/search"]);
});

test("configured API keys are enforced", async () => {
  const lockedEnv = { UNIFIED_API_KEY: "unit-test-key" };
  const response = await worker.fetch(new Request("https://unified.test/v1/providers"), lockedEnv);
  assert.equal(response.status, 401);
  const authorized = await worker.fetch(new Request("https://unified.test/v1/providers", { headers: { "x-api-key": "unit-test-key" } }), lockedEnv);
  assert.equal(authorized.status, 200);
});
