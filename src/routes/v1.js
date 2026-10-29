import { Hono } from "hono";
import * as tidal from "../providers/tidal.js";
import * as deezer from "../providers/deezer.js";
import * as qobuz from "../providers/qobuz.js";
import * as ytmusic from "../providers/ytmusic.js";
import * as soundcloud from "../providers/soundcloud.js";
import { API_VERSION, ApiError, numberParam, providerResourceId, normalizeTrack, normalizeStreamResult, requireParam, createRelaySignature, verifyRelaySignature } from "../lib.js";

const providers = { tidal, deezer, qobuz, "youtube-music": ytmusic, soundcloud };
const resultCache = new Map();
export const v1Routes = new Hono({ strict: false });

function canonicalProvider(raw = "all") {
  const value = raw.toLowerCase();
  if (["ytm", "youtube_music", "youtube music"].includes(value)) return "youtube-music";
  if (value !== "all" && !providers[value]) throw new ApiError(400, "unknown_provider", `Unknown provider: ${raw}`);
  return value;
}

function unwrap(data) {
  if (data?.data && !Array.isArray(data.data) && typeof data.data === "object" &&
      (data.data.id || data.data.title || data.data.name)) return data.data;
  return data;
}

function normalizeEntity(provider, type, input) {
  const data = unwrap(input);
  if (!data || typeof data !== "object") return data;
  if (typeof data.id === "string" && data.id.startsWith(`${provider}:${type}:`)) return data;
  if (type === "track") return normalizeTrack(provider, data) ?? data;
  const rawId = data.id ?? data.browseId ?? data.playlistId ?? data.artistId;
  const image = data.artworkUrl ?? data.coverUrl ?? data.image ?? data.picture?.urls?.[0]?.url ??
    data.picture?.url ?? data.picture ?? data.cover?.urls?.[0]?.url ?? data.cover ?? null;
  const artworkUrl = typeof image === "string"
    ? (provider === "tidal" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(image)
      ? `https://resources.tidal.com/images/${image.replace(/-/g, "/")}/750x750.jpg` : image)
    : image?.url ?? null;
  const title = data.title ?? data.displayTitle ?? data.name ?? null;
  const artists = data.artists ?? data.contributors?.edges?.map(edge => edge.node) ?? [];
  const entity = {
    id: rawId == null ? null : `${provider}:${type}:${rawId}`,
    type,
    title,
    ...(type === "artist" ? { name: data.name ?? title } : {}),
    description: data.description ?? data.bio ?? null,
    artworkUrl,
    artists: (Array.isArray(artists) ? artists : [artists]).map(artist => ({
      id: artist?.id == null ? null : `${provider}:artist:${artist.id}`,
      name: artist?.name ?? "Unknown artist"
    })),
    provider,
    url: data.url ?? data.permalink_url ?? data.webUrl ?? null
  };
  if (type === "album") {
    entity.releaseDate = data.releaseDate ?? data.releasedAt ?? null;
    const rawTracks = data.tracks?.edges?.map(edge => edge.node) ?? data.items ?? data.tracks?.items ?? null;
    entity.trackCount = data.numberOfItems ?? data.numberOfTracks ?? data.tracksCount ?? rawTracks?.length ?? null;
    entity.tracks = Array.isArray(rawTracks)
      ? rawTracks.map(item => normalizeTrack(provider, item?.item ?? item)).filter(Boolean)
      : null;
    if (data.itemsError) entity.tracksError = data.itemsError;
  }
  if (type === "artist") {
    entity.albums = data.albums?.edges?.map(edge => normalizeEntity(provider, "album", edge.node)) ?? null;
    entity.topTracks = data.topTracks?.edges?.map(edge => normalizeTrack(provider, edge.node)).filter(Boolean) ?? null;
  }
  if (type === "playlist") {
    const rawTracks = data.tracks?.edges?.map(edge => edge.node) ?? data.items ?? data.tracks?.items ?? null;
    entity.trackCount = data.estimatedTracksCount ?? data.numberOfTracks ?? rawTracks?.length ?? null;
    entity.tracks = Array.isArray(rawTracks)
      ? rawTracks.map(item => normalizeTrack(provider, item?.item ?? item)).filter(Boolean)
      : null;
    entity.owner = data.owner?.name ?? null;
    if (data.itemsError) entity.tracksError = data.itemsError;
  }
  return entity;
}

function collectionFromResult(result, type) {
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.data?.items)) return result.data.items;
  if (Array.isArray(result?.tracks?.items)) return result.tracks.items;
  if (Array.isArray(result?.[`${type}s`]?.items)) return result[`${type}s`].items;
  if (Array.isArray(result?.[`${type}s`])) return result[`${type}s`];
  if (Array.isArray(result?.data?.[`${type}s`])) return result.data[`${type}s`];
  return [];
}

function cacheRead(key) {
  const item = resultCache.get(key);
  if (!item || item.expiresAt <= Date.now()) {
    resultCache.delete(key);
    return null;
  }
  return structuredClone(item.value);
}
function cacheWrite(key, value, ttlMs) {
  resultCache.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttlMs });
  if (resultCache.size > 300) {
    const oldest = resultCache.keys().next().value;
    if (oldest) resultCache.delete(oldest);
  }
}

function providerTimeoutMs(env) {
  const configured = Number(env.UNIFIED_PROVIDER_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 1000 && configured <= 30000 ? configured : 6000;
}

async function withProviderDeadline(provider, operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(504, "provider_timeout", `${provider} exceeded the ${timeoutMs} ms provider deadline.`, { provider, timeoutMs })), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runSearch(env, url) {
  const query = requireParam(url, "q");
  const type = url.searchParams.get("type") || "track";
  if (!["track", "album", "artist", "playlist", "video"].includes(type)) {
    throw new ApiError(400, "unsupported_search_type", "type must be track, album, artist, playlist, or video");
  }
  const provider = canonicalProvider(url.searchParams.get("provider") || "all");
  const limit = numberParam(url, "limit", 25, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 1000000);
  const cacheKey = `search:${provider}:${type}:${query.toLowerCase()}:${limit}:${offset}`;
  const cached = cacheRead(cacheKey);
  if (cached) return cached;
  const targets = provider === "all" ? Object.keys(providers) : [provider];
  const timeoutMs = providerTimeoutMs(env);
  const settled = await Promise.all(targets.map(async name => {
    const started = Date.now();
    try {
      const value = await withProviderDeadline(name, () => providers[name].search(env, query, type, limit, offset), timeoutMs);
      return { name, value, elapsedMs: Date.now() - started };
    } catch (error) {
      return { name, error, elapsedMs: Date.now() - started };
    }
  }));
  const results = [];
  const errors = [];
  for (const entry of settled) {
    const name = entry.name;
    if (entry.error) {
      errors.push({ provider: name, code: entry.error?.code || "provider_error", message: entry.error?.message || "Provider request failed.", elapsedMs: entry.elapsedMs });
      continue;
    }
    const value = entry.value;
    const items = Array.isArray(value?.items) ? value.items : collectionFromResult(value, type);
    results.push({ provider: name, type, total: value?.total ?? null, elapsedMs: entry.elapsedMs, items: items.map(item => normalizeEntity(name, type, item)) });
  }
  const items = results.flatMap(result => result.items);
  const response = { query, type, provider, count: items.length, items, results, errors, partial: errors.length > 0 };
  // Catalog entries change less often than stream URLs; this short per-isolate
  // cache avoids repeated upstream latency while never caching playback URLs.
  if (results.length > 0) cacheWrite(cacheKey, response, 30000);
  return response;
}

async function matchIsrc(env, url) {
  const isrc = requireParam(url, "isrc").replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)) {
    throw new ApiError(400, "invalid_isrc", "isrc must be a 12-character ISO 3901 recording code.");
  }
  const cacheKey = `isrc:${isrc}`;
  const cached = cacheRead(cacheKey);
  if (cached) return cached;
  const targets = Object.keys(providers);
  const timeoutMs = providerTimeoutMs(env);
  const settled = await Promise.all(targets.map(async name => {
    const started = Date.now();
    try {
      const adapter = providers[name];
      const value = await withProviderDeadline(name, () => typeof adapter.findByIsrc === "function"
        ? adapter.findByIsrc(env, isrc, 25, 0)
        : adapter.search(env, isrc, "track", 25, 0).then(result => ({ items: result?.items ?? [], strategy: "text_search_then_exact_isrc_check" })), timeoutMs);
      return { name, value, elapsedMs: Date.now() - started };
    } catch (error) {
      return { name, error, elapsedMs: Date.now() - started };
    }
  }));
  const matches = [];
  const errors = [];
  const checkedProviders = [];
  for (const entry of settled) {
    const provider = entry.name;
    if (entry.error) {
      const error = { provider, code: entry.error?.code || "provider_error", message: entry.error?.message || "Provider request failed." };
      errors.push(error);
      checkedProviders.push({ provider, checked: false, candidateCount: 0, matchCount: 0, elapsedMs: entry.elapsedMs, error: error.code });
      continue;
    }
    const items = Array.isArray(entry.value?.items) ? entry.value.items : [];
    let matchCount = 0;
    for (const item of items) {
      const normalized = normalizeEntity(provider, "track", item);
      if (normalized?.isrc && String(normalized.isrc).replace(/[\s-]/g, "").toUpperCase() === isrc) {
        matches.push(normalized);
        matchCount++;
      }
    }
    checkedProviders.push({
      provider, checked: true, strategy: entry.value?.strategy || "text_search_then_exact_isrc_check",
      candidateCount: items.length, matchCount, elapsedMs: entry.elapsedMs,
      ...(entry.value?.limitation ? { limitation: entry.value.limitation } : {})
    });
  }
  const response = { isrc, matches, checkedProviders, errors, partial: errors.length > 0 };
  if (checkedProviders.some(provider => provider.checked)) cacheWrite(cacheKey, response, 60000);
  return response;
}
function parseProviderUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, "invalid_url", "url must be an absolute URL"); }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "tidal.com" || host.endsWith(".tidal.com")) {
    const typeIndex = parts.findIndex(part => ["track", "album", "artist", "playlist", "video"].includes(part));
    if (typeIndex >= 0 && parts[typeIndex + 1]) {
      const type = parts[typeIndex];
      return { provider: "tidal", resourceId: `tidal:${type}:${parts[typeIndex + 1]}`, type };
    }
  }
  if (host === "soundcloud.com" || host.endsWith(".soundcloud.com")) {
    return { provider: "soundcloud", unresolvedUrl: value, note: "A provider-specific URL resolver is required to map this permalink to a resource ID." };
  }
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") {
    const id = url.searchParams.get("v") || parts.at(-1);
    if (id) return { provider: "youtube-music", resourceId: `youtube-music:track:${id}`, type: "track" };
  }
  if (host === "deezer.com" || host.endsWith(".deezer.com")) {
    const type = parts.at(-2); const id = parts.at(-1);
    if (["track", "album", "artist", "playlist"].includes(type) && id) return { provider: "deezer", resourceId: `deezer:${type}:${id}`, type };
  }
  if (host === "qobuz.com" || host.endsWith(".qobuz.com")) {
    const type = parts.at(-2); const id = parts.at(-1);
    if (["track", "album", "artist", "playlist"].includes(type) && id) return { provider: "qobuz", resourceId: `qobuz:${type}:${id}`, type };
  }
  throw new ApiError(400, "unsupported_url", "Unified could not identify a supported provider resource from this URL.");
}

async function resource(env, id, plural, action, url) {
  const parsed = providerResourceId(id);
  const provider = providers[parsed.provider];
  if (!provider) throw new ApiError(400, "unknown_provider", `Unknown provider in resource ID: ${parsed.provider}`);
  const expected = ({ tracks: "track", albums: "album", artists: "artist", playlists: "playlist" })[plural];
  if (parsed.type !== expected) throw new ApiError(400, "resource_type_mismatch", `This route expects a ${expected} ID.`);
  let data;
  if (action === "stream") {
    const options = {
      quality: url.searchParams.get("quality") || undefined,
      manifestType: url.searchParams.get("manifestType") || "MPEG_DASH",
      audioMode: url.searchParams.get("audioMode") || undefined,
      atmos: url.searchParams.get("atmos") === "true",
      formats: url.searchParams.getAll("formats"),
      relay: url.searchParams.get("relay") !== "false"
    };
    const raw = await provider.stream(env, parsed.id, options);
    data = normalizeStreamResult(parsed.provider, parsed.id, raw);
    if (parsed.provider === "deezer" && raw?.previewUrl && options.relay) {
      const exp = Math.floor(Date.now() / 1000) + 300;
      const sig = await createRelaySignature(env, "deezer", parsed.id, exp);
      const relayUrl = new URL(`/v1/relay/deezer/${encodeURIComponent(parsed.id)}`, url.origin);
      relayUrl.searchParams.set("exp", String(exp));
      relayUrl.searchParams.set("sig", sig);
      data = normalizeStreamResult("deezer", parsed.id, {
        ...raw, url: relayUrl.href, streamType: "relay", relayed: true,
        playable: true, previewOnly: true,
        note: "This is Deezer's available preview, relayed through this Worker. Full-track protected media is not decoded by Unified."
      });
    }
  } else if (action === "lyrics") data = await provider.lyrics(env, parsed.id);
  else if (plural === "tracks") data = await provider.info(env, parsed.id);
  else if (plural === "albums") data = await provider.album(env, parsed.id);
  else if (plural === "artists") data = await provider.artist(env, parsed.id);
  else data = await provider.playlist(env, parsed.id);
  if (action) return { provider: parsed.provider, id, type: expected, action, data };
  return { provider: parsed.provider, id, type: expected, data: normalizeEntity(parsed.provider, expected, data) };
}

export function openapiDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "Unified Music REST API", version: API_VERSION, description: "Provider-agnostic REST routes. Tidal compatibility routes are separate." },
    servers: [{ url: "/" }],
    paths: {
      "/v1/health": { get: { summary: "Health check", responses: { "200": { description: "Worker is running" } } } },
      "/v1/providers": { get: { summary: "Provider configuration and capabilities", responses: { "200": { description: "Provider statuses" } } } },
      "/v1/search": { get: { summary: "Search one or all providers", parameters: [
        { name: "q", in: "query", required: true, schema: { type: "string" } },
        { name: "type", in: "query", schema: { type: "string", enum: ["track", "album", "artist", "playlist", "video"] } },
        { name: "provider", in: "query", schema: { type: "string", enum: ["all", "tidal", "deezer", "qobuz", "youtube-music", "soundcloud"] } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } }
      ], responses: { "200": { description: "Combined search results" } } } },
      "/v1/match": { get: { summary: "Find exact track matches by ISRC", parameters: [{ name: "isrc", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Matching tracks" } } } },
      "/v1/resolve": { get: { summary: "Resolve a provider URL to a Unified resource identifier", parameters: [{ name: "url", in: "query", required: true, schema: { type: "string", format: "uri" } }], responses: { "200": { description: "Provider resource mapping" } } } },
      "/v1/tracks/{id}": { get: { summary: "Get normalized track metadata", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Track metadata" } } } },
      "/v1/tracks/{id}/stream": { get: { summary: "Resolve provider-supported stream information", responses: { "200": { description: "Stream or manifest metadata" } } } },
      "/v1/tracks/{id}/lyrics": { get: { summary: "Retrieve lyrics when supported", responses: { "200": { description: "Lyrics data" } } } },
      "/v1/albums/{id}": { get: { summary: "Get normalized album metadata", responses: { "200": { description: "Album metadata" } } } },
      "/v1/artists/{id}": { get: { summary: "Get normalized artist metadata", responses: { "200": { description: "Artist metadata" } } } },
      "/v1/playlists/{id}": { get: { summary: "Get normalized playlist metadata", responses: { "200": { description: "Playlist metadata" } } } }
    }
  };
}

v1Routes.get("/relay/deezer/:id", async c => {
  const id = c.req.param("id");
  const exp = c.req.query("exp");
  const sig = c.req.query("sig");
  if (!(await verifyRelaySignature(c.env, "deezer", id, exp, sig))) {
    throw new ApiError(401, "invalid_relay_signature", "This media relay URL is invalid or expired.");
  }
  const source = await deezer.previewUrl(c.env, id);
  if (!source) throw new ApiError(404, "preview_unavailable", "Deezer has no playable preview for this track.");
  const headers = new Headers({ "user-agent": "Mozilla/5.0", accept: "audio/*,*/*;q=0.8" });
  const range = c.req.header("range");
  if (range) headers.set("range", range);
  let upstream;
  try {
    upstream = await fetch(source, { headers, redirect: "follow" });
  } catch {
    throw new ApiError(502, "relay_upstream_failed", "Could not reach Deezer's preview stream.");
  }
  if (!upstream.ok && upstream.status !== 206) {
    throw new ApiError(502, "relay_upstream_failed", `Deezer preview returned HTTP ${upstream.status}.`, { upstreamStatus: upstream.status });
  }
  const outHeaders = new Headers({
    "cache-control": "private, max-age=30",
    "content-type": upstream.headers.get("content-type") || "audio/mpeg",
    "accept-ranges": upstream.headers.get("accept-ranges") || "bytes",
    "x-content-type-options": "nosniff"
  });
  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) outHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
});

v1Routes.get("/health", c => c.json({ status: "ok", version: c.env.UNIFIED_VERSION || API_VERSION, timestamp: new Date().toISOString() }));
v1Routes.get("/providers", c => c.json({ providers: Object.values(providers).map(provider => provider.status(c.env)) }));
v1Routes.get("/search", async c => c.json(await runSearch(c.env, new URL(c.req.url))));
v1Routes.get("/match", async c => c.json(await matchIsrc(c.env, new URL(c.req.url))));
v1Routes.get("/resolve", c => {
  const input = c.req.query("url");
  if (!input) throw new ApiError(400, "missing_parameter", "Missing required query parameter: url");
  return c.json({ input, ...parseProviderUrl(input) });
});
for (const plural of ["tracks", "albums", "artists", "playlists"]) {
  v1Routes.get(`/${plural}/:id/stream`, async c => c.json(await resource(c.env, c.req.param("id"), plural, "stream", new URL(c.req.url))));
  v1Routes.get(`/${plural}/:id/lyrics`, async c => {
    if (plural !== "tracks") throw new ApiError(404, "not_found", "Lyrics are only available on track resources.");
    return c.json(await resource(c.env, c.req.param("id"), plural, "lyrics", new URL(c.req.url)));
  });
  v1Routes.get(`/${plural}/:id`, async c => c.json(await resource(c.env, c.req.param("id"), plural, null, new URL(c.req.url))));
}

