import * as tidal from "./providers/tidal.js";
import * as deezer from "./providers/deezer.js";
import * as qobuz from "./providers/qobuz.js";
import * as ytmusic from "./providers/ytmusic.js";
import * as soundcloud from "./providers/soundcloud.js";
import {
  API_VERSION, ApiError, json, numberParam, requireParam, providerResourceId,
  normalizeTrack, safeError
} from "./lib.js";

const PROVIDERS = {
  tidal,
  deezer,
  qobuz,
  "youtube-music": ytmusic,
  soundcloud
};
const API_INFO = {
  name: "Unified Music API",
  version: API_VERSION,
  description: "A provider-agnostic REST API for music catalog metadata and provider-supported playback resolution.",
  reference: "https://github.com/binimum/hifi-api"
};

function canonicalProvider(raw = "all") {
  const p = raw.toLowerCase();
  if (p === "ytm" || p === "youtube_music" || p === "youtube music") return "youtube-music";
  if (p !== "all" && !PROVIDERS[p]) throw new ApiError(400, "unknown_provider", `Unknown provider: ${raw}`);
  return p;
}

function unwrap(data) {
  if (data?.data && !Array.isArray(data.data) && typeof data.data === "object" && (data.data.id || data.data.title || data.data.name)) return data.data;
  return data;
}

function normalizeEntity(provider, type, input) {
  const data = unwrap(input);
  if (!data || typeof data !== "object") return data;
  if (typeof data.id === "string" && data.id.startsWith(`${provider}:${type}:`)) return data;
  if (type === "track") return normalizeTrack(provider, data) ?? data;
  const rawId = data.id ?? data.browseId ?? data.playlistId ?? data.artistId;
  const image = data.artworkUrl ?? data.coverUrl ?? data.image ?? data.picture?.urls?.[0]?.url ?? data.picture?.url ?? data.picture ?? data.cover?.urls?.[0]?.url ?? null;
  const title = data.title ?? data.displayTitle ?? data.name ?? null;
  const artists = data.artists ?? data.contributors?.edges?.map(edge => edge.node) ?? [];
  const base = {
    id: rawId == null ? null : `${provider}:${type}:${rawId}`,
    type,
    title,
    name: data.name ?? (type === "artist" ? title : undefined),
    description: data.description ?? data.bio ?? null,
    artworkUrl: typeof image === "string" ? image : image?.url ?? null,
    artists: (Array.isArray(artists) ? artists : [artists]).map(artist => ({
      id: artist?.id == null ? null : `${provider}:artist:${artist.id}`,
      name: artist?.name ?? "Unknown artist"
    })),
    provider,
    url: data.url ?? data.permalink_url ?? data.webUrl ?? null
  };
  if (type === "album") {
    base.releaseDate = data.releaseDate ?? data.releasedAt ?? null;
    base.trackCount = data.numberOfItems ?? data.tracksCount ?? data.tracks?.edges?.length ?? null;
    base.tracks = data.tracks?.edges?.map(edge => normalizeTrack(provider, edge.node)).filter(Boolean) ?? null;
  }
  if (type === "artist") {
    base.albums = data.albums?.edges?.map(edge => normalizeEntity(provider, "album", edge.node)) ?? null;
    base.topTracks = data.topTracks?.edges?.map(edge => normalizeTrack(provider, edge.node)).filter(Boolean) ?? null;
  }
  if (type === "playlist") {
    base.trackCount = data.estimatedTracksCount ?? data.numberOfTracks ?? data.tracks?.edges?.length ?? null;
    base.tracks = data.tracks?.edges?.map(edge => normalizeTrack(provider, edge.node)).filter(Boolean) ?? null;
    base.owner = data.owner?.name ?? null;
  }
  return base;
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

async function unifiedSearch(env, url) {
  const query = requireParam(url, "q");
  const type = url.searchParams.get("type") || "track";
  if (!["track", "album", "artist", "playlist", "video"].includes(type)) {
    throw new ApiError(400, "unsupported_search_type", "type must be track, album, artist, playlist, or video");
  }
  const provider = canonicalProvider(url.searchParams.get("provider") || "all");
  const limit = numberParam(url, "limit", 25, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 1000000);
  const targets = provider === "all" ? Object.keys(PROVIDERS) : [provider];
  const settled = await Promise.allSettled(targets.map(name => PROVIDERS[name].search(env, query, type, limit, offset)));
  const results = [];
  const errors = [];
  settled.forEach((entry, index) => {
    const name = targets[index];
    if (entry.status === "rejected") {
      errors.push({ provider: name, code: entry.reason?.code || "provider_error", message: entry.reason?.message || "Provider request failed." });
      return;
    }
    const response = entry.value;
    const items = Array.isArray(response?.items) ? response.items : collectionFromResult(response, type);
    results.push({ provider: name, type, total: response?.total ?? null, items: items.map(item => normalizeEntity(name, type, item)) });
  });
  const items = results.flatMap(result => result.items);
  return json({ query, type, provider, count: items.length, items, results, errors, partial: errors.length > 0 });
}

async function resourceRoute(env, url, match) {
  const [, plural, encodedId, action] = match;
  const rawId = decodeURIComponent(encodedId);
  const parsed = providerResourceId(rawId);
  const provider = PROVIDERS[parsed.provider];
  if (!provider) throw new ApiError(400, "unknown_provider", `Unknown provider in resource ID: ${parsed.provider}`);
  const expected = ({ tracks: "track", albums: "album", artists: "artist", playlists: "playlist" })[plural];
  if (parsed.type !== expected) throw new ApiError(400, "resource_type_mismatch", `This route expects a ${expected} ID.`);
  let data;
  if (action === "stream") data = await provider.stream(env, parsed.id, url.searchParams.get("quality") || undefined);
  else if (action === "lyrics") data = await provider.lyrics(env, parsed.id);
  else if (plural === "tracks") data = await provider.info(env, parsed.id);
  else if (plural === "albums") data = await provider.album(env, parsed.id);
  else if (plural === "artists") data = await provider.artist(env, parsed.id);
  else data = await provider.playlist(env, parsed.id);
  if (action) return { provider: parsed.provider, id: rawId, type: expected, action, data };
  return { provider: parsed.provider, id: rawId, type: expected, data: normalizeEntity(parsed.provider, expected, data) };
}

async function matchIsrc(env, url) {
  const isrc = requireParam(url, "isrc");
  const targets = Object.keys(PROVIDERS);
  const settled = await Promise.allSettled(targets.map(name => PROVIDERS[name].search(env, isrc, "track", 10, 0)));
  const matches = [];
  const errors = [];
  settled.forEach((entry, index) => {
    const provider = targets[index];
    if (entry.status === "rejected") {
      errors.push({ provider, code: entry.reason?.code || "provider_error", message: entry.reason?.message || "Provider request failed." });
      return;
    }
    for (const item of entry.value?.items ?? []) {
      const normalized = normalizeEntity(provider, "track", item);
      if (normalized?.isrc && normalized.isrc.toUpperCase() === isrc.toUpperCase()) matches.push(normalized);
      else if (!normalized?.isrc) matches.push(normalized);
    }
  });
  return { isrc: isrc.toUpperCase(), matches, errors, partial: errors.length > 0 };
}

function openapi() {
  const paths = {
    "/v1/health": { get: { summary: "Health check", responses: { "200": { description: "Worker is running" } } } },
    "/v1/providers": { get: { summary: "Provider configuration and capabilities", responses: { "200": { description: "Provider statuses" } } } },
    "/v1/search": { get: { summary: "Search one or all providers", parameters: [
      { name: "q", in: "query", required: true, schema: { type: "string" } },
      { name: "type", in: "query", schema: { type: "string", enum: ["track", "album", "artist", "playlist", "video"] } },
      { name: "provider", in: "query", schema: { type: "string" } },
      { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } }
    ], responses: { "200": { description: "Combined search results" } } } },
    "/v1/match": { get: { summary: "Find track matches by ISRC", parameters: [{ name: "isrc", in: "query", required: true, schema: { type: "string" } }], responses: { "200": { description: "Matching tracks" } } } },
    "/v1/tracks/{id}": { get: { summary: "Get normalized track metadata", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Track metadata" } } } },
    "/v1/tracks/{id}/stream": { get: { summary: "Resolve provider-supported playback metadata", responses: { "200": { description: "Stream or manifest details" } } } },
    "/v1/tracks/{id}/lyrics": { get: { summary: "Retrieve lyrics when supported", responses: { "200": { description: "Lyrics data" } } } },
    "/v1/albums/{id}": { get: { summary: "Get album metadata", responses: { "200": { description: "Album metadata" } } } },
    "/v1/artists/{id}": { get: { summary: "Get artist metadata", responses: { "200": { description: "Artist metadata" } } } },
    "/v1/playlists/{id}": { get: { summary: "Get playlist metadata", responses: { "200": { description: "Playlist metadata" } } } }
  };
  return { openapi: "3.1.0", info: { title: "Unified Music REST API", version: API_VERSION, description: API_INFO.description }, servers: [{ url: "/" }], paths };
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-api-key"
  };
}

function checkApiKey(request, env, pathname) {
  if (!env.UNIFIED_API_KEY || pathname === "/" || pathname === "/openapi.json" || pathname === "/v1/health") return;
  const key = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (key !== env.UNIFIED_API_KEY) throw new ApiError(401, "unauthorized", "Provide a valid Unified API key.");
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET" && request.method !== "HEAD") throw new ApiError(405, "method_not_allowed", "This REST API currently accepts GET requests only.");
  checkApiKey(request, env, path);

  if (path === "/") return json({ ...API_INFO, version: API_VERSION, Repo: "https://github.com/binimum/hifi-api", docs: "/openapi.json", health: "/v1/health" });
  if (path === "/openapi.json") return json(openapi());
  if (path === "/v1/health") return json({ status: "ok", version: env.UNIFIED_VERSION || API_VERSION, timestamp: new Date().toISOString() });
  if (path === "/v1/providers") return json({ providers: Object.values(PROVIDERS).map(provider => provider.status(env)) });
  if (path === "/v1/search") return unifiedSearch(env, url);
  if (path === "/v1/match") return json(await matchIsrc(env, url));

  const v1Resource = /^\/v1\/(tracks|albums|artists|playlists)\/([^/]+)(?:\/(stream|lyrics))?$/.exec(path);
  if (v1Resource) return json(await resourceRoute(env, url, v1Resource));

  // Direct compatibility routes modelled on binimum/hifi-api.
  const tidalCompatRoutes = new Set([
    "/info/", "/track/", "/trackManifests/", "/widevine", "/recommendations/", "/search/", "/album/", "/mix/", "/playlist/",
    "/artist/similar/", "/album/similar/", "/artist/", "/cover/", "/lyrics/", "/topvideos/", "/video/"
  ]);
  const normalizedPath = path.endsWith("/") ? path : `${path}/`;
  if (tidalCompatRoutes.has(path) || tidalCompatRoutes.has(normalizedPath)) {
    const compatPath = tidalCompatRoutes.has(path) ? path : normalizedPath;
    if (compatPath === "/widevine" && request.method === "GET") {
      throw new ApiError(501, "drm_license_proxy_disabled", "Unified deliberately does not proxy DRM license requests.");
    }
    return json(await tidal.compatible(env, compatPath, url));
  }

  const resolveUrl = url.searchParams.get("url");
  if (path === "/v1/resolve" && resolveUrl) {
    const parsed = parseProviderUrl(resolveUrl);
    return json({ input: resolveUrl, ...parsed });
  }
  throw new ApiError(404, "not_found", `No route matches ${path}`);
}

function parseProviderUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, "invalid_url", "url must be an absolute URL"); }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host.endsWith("tidal.com")) {
    const typeIndex = parts.findIndex(part => ["track", "album", "artist", "playlist", "video"].includes(part));
    if (typeIndex >= 0 && parts[typeIndex + 1]) {
      const type = parts[typeIndex];
      return { provider: "tidal", resourceId: `tidal:${type}:${parts[typeIndex + 1]}`, type };
    }
  }
  if (host.includes("soundcloud.com")) return { provider: "soundcloud", unresolvedUrl: value, note: "Call SoundCloud's resolve endpoint through a configured client to get the resource ID." };
  if (host.includes("youtube.com") || host.includes("youtu.be")) {
    const id = url.searchParams.get("v") || parts.at(-1);
    if (id) return { provider: "youtube-music", resourceId: `youtube-music:track:${id}`, type: "track" };
  }
  if (host.includes("deezer.com")) {
    const type = parts.at(-2); const id = parts.at(-1);
    if (["track", "album", "artist", "playlist"].includes(type) && id) return { provider: "deezer", resourceId: `deezer:${type}:${id}`, type };
  }
  if (host.includes("qobuz.com")) {
    const type = parts.at(-2); const id = parts.at(-1);
    if (["track", "album", "artist", "playlist"].includes(type) && id) return { provider: "qobuz", resourceId: `qobuz:${type}:${id}`, type };
  }
  throw new ApiError(400, "unsupported_url", "Unified could not identify a supported provider resource from this URL.");
}

export default {
  async fetch(request, env) {
    try {
      const response = await route(request, env);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      const result = safeError(error);
      return json(result.body, result.status, corsHeaders());
    }
  }
};
