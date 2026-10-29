import { Hono } from "hono";
import * as tidal from "../providers/tidal.js";
import * as deezer from "../providers/deezer.js";
import * as qobuz from "../providers/qobuz.js";
import * as ytmusic from "../providers/ytmusic.js";
import * as soundcloud from "../providers/soundcloud.js";
import { API_VERSION, ApiError, numberParam, providerResourceId, normalizeTrack, requireParam } from "../lib.js";

const providers = { tidal, deezer, qobuz, "youtube-music": ytmusic, soundcloud };
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
    data.picture?.url ?? data.picture ?? data.cover?.urls?.[0]?.url ?? null;
  const title = data.title ?? data.displayTitle ?? data.name ?? null;
  const artists = data.artists ?? data.contributors?.edges?.map(edge => edge.node) ?? [];
  const entity = {
    id: rawId == null ? null : `${provider}:${type}:${rawId}`,
    type,
    title,
    ...(type === "artist" ? { name: data.name ?? title } : {}),
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
    entity.releaseDate = data.releaseDate ?? data.releasedAt ?? null;
    entity.trackCount = data.numberOfItems ?? data.tracksCount ?? data.tracks?.edges?.length ?? null;
    entity.tracks = data.tracks?.edges?.map(edge => normalizeTrack(provider, edge.node)).filter(Boolean) ?? null;
  }
  if (type === "artist") {
    entity.albums = data.albums?.edges?.map(edge => normalizeEntity(provider, "album", edge.node)) ?? null;
    entity.topTracks = data.topTracks?.edges?.map(edge => normalizeTrack(provider, edge.node)).filter(Boolean) ?? null;
  }
  if (type === "playlist") {
    entity.trackCount = data.estimatedTracksCount ?? data.numberOfTracks ?? data.tracks?.edges?.length ?? null;
    entity.tracks = data.tracks?.edges?.map(edge => normalizeTrack(provider, edge.node)).filter(Boolean) ?? null;
    entity.owner = data.owner?.name ?? null;
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

async function runSearch(env, url) {
  const query = requireParam(url, "q");
  const type = url.searchParams.get("type") || "track";
  if (!["track", "album", "artist", "playlist", "video"].includes(type)) {
    throw new ApiError(400, "unsupported_search_type", "type must be track, album, artist, playlist, or video");
  }
  const provider = canonicalProvider(url.searchParams.get("provider") || "all");
  const limit = numberParam(url, "limit", 25, 1, 100);
  const offset = numberParam(url, "offset", 0, 0, 1000000);
  const targets = provider === "all" ? Object.keys(providers) : [provider];
  const settled = await Promise.allSettled(targets.map(name => providers[name].search(env, query, type, limit, offset)));
  const results = [];
  const errors = [];
  settled.forEach((entry, index) => {
    const name = targets[index];
    if (entry.status === "rejected") {
      errors.push({ provider: name, code: entry.reason?.code || "provider_error", message: entry.reason?.message || "Provider request failed." });
      return;
    }
    const value = entry.value;
    const items = Array.isArray(value?.items) ? value.items : collectionFromResult(value, type);
    results.push({ provider: name, type, total: value?.total ?? null, items: items.map(item => normalizeEntity(name, type, item)) });
  });
  const items = results.flatMap(result => result.items);
  return { query, type, provider, count: items.length, items, results, errors, partial: errors.length > 0 };
}

async function matchIsrc(env, url) {
  const isrc = requireParam(url, "isrc").trim().toUpperCase();
  const targets = Object.keys(providers);
  const settled = await Promise.allSettled(targets.map(name => providers[name].search(env, isrc, "track", 10, 0)));
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
      if (normalized?.isrc && normalized.isrc.toUpperCase() === isrc) matches.push(normalized);
    }
  });
  return { isrc, matches, errors, partial: errors.length > 0 };
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
  if (action === "stream") data = await provider.stream(env, parsed.id, url.searchParams.get("quality") || undefined);
  else if (action === "lyrics") data = await provider.lyrics(env, parsed.id);
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

