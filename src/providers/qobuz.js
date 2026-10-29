import { ApiError, fetchJson, makeUrl, providerStatus, normalizeTrack, extractEdges } from "../lib.js";

const REQUIRED = ["q-cid", "q-cs", "q-uat"];
const API = "https://www.qobuz.com/api.json/0.2/";

function assertConfigured(env) {
  const missing = REQUIRED.filter(key => !env[key] || !String(env[key]).trim());
  if (missing.length) throw new ApiError(503, "provider_not_configured", "Qobuz is not configured on this Unified instance.", { missing });
}

async function request(env, path, params = {}) {
  assertConfigured(env);
  const url = makeUrl(API, path, { app_id: env["q-cid"], ...params });
  return fetchJson(url, {
    headers: {
      "x-app-id": env["q-cid"],
      "x-user-auth-token": env["q-uat"],
      "user-agent": "UnifiedMusicAPI/0.3.2",
      accept: "application/json"
    }
  });
}

export function status(env) {
  return providerStatus(env, "qobuz", REQUIRED, {
    search: true, trackInfo: true, albumInfo: true, artistInfo: true, playlistInfo: true,
    legacyFileUrl: false, currentWebPlayerSegmentResolver: false
  });
}

export async function search(env, query, type = "track", limit = 25, offset = 0) {
  const path = ({ track: "track/search", album: "album/search", artist: "artist/search", playlist: "playlist/search" })[type];
  if (!path) throw new ApiError(400, "unsupported_search_type", "Qobuz supports track, album, artist, and playlist search.");
  const result = await request(env, path, { query, limit, offset });
  const key = ({ track: "tracks", album: "albums", artist: "artists", playlist: "playlists" })[type];
  const root = result[key] ?? result;
  let items = root.items ?? root;
  if (!Array.isArray(items)) items = extractEdges(items);
  return { provider: "qobuz", type, total: root.total ?? null,
    items: type === "track" ? items.map(item => normalizeTrack("qobuz", item)).filter(Boolean) : items };
}

export async function info(env, id) { return request(env, "track/get", { track_id: id }); }
export async function album(env, id) { return request(env, "album/get", { album_id: id, extra: "tracks" }); }
export async function artist(env, id) { return request(env, "artist/get", { artist_id: id }); }
export async function playlist(env, id) { return request(env, "playlist/get", { playlist_id: id }); }
export async function lyrics() { throw new ApiError(501, "lyrics_unavailable", "Qobuz does not expose a consistent lyrics endpoint in this adapter."); }

export async function stream(env, id, qualityOrOptions = "27") {
  assertConfigured(env);
  const options = qualityOrOptions && typeof qualityOrOptions === "object" ? qualityOrOptions : { quality: qualityOrOptions };
  const quality = String(options.quality || "HI_RES_LOSSLESS");
  const formatId = ({
    low: "5", LOW: "5", high: "6", HIGH: "6", lossless: "6", LOSSLESS: "6",
    hires: "27", "hi-res": "27", HI_RES_LOSSLESS: "27", FLAC_HIRES: "27", FLAC: "6"
  })[quality] ?? quality;
  const url = makeUrl(API, "track/getFileUrl", {
    app_id: env["q-cid"], user_auth_token: env["q-uat"], track_id: id, format_id: formatId, intent: "stream"
  });
  let data;
  try {
    data = await fetchJson(url, { headers: { "x-app-id": env["q-cid"], "x-user-auth-token": env["q-uat"], accept: "application/json" } }, 5500);
  } catch (error) {
    if (error?.details?.upstreamStatus === 410) {
      return {
        provider: "qobuz", trackId: String(id), url: null,
        streamType: "direct", manifestType: null, mimeType: null, codec: null,
        quality, playable: false, available: false, previewOnly: false, encrypted: false,
        note: "Qobuz's legacy file URL endpoint is gone. The session-based encrypted playback flow is not implemented in this build."
      };
    }
    throw error;
  }
  const streamUrl = data.url ?? data.streamUrl ?? null;
  return {
    provider: "qobuz", trackId: String(id), url: streamUrl,
    streamType: "direct", manifestType: null, mimeType: data.mimeType ?? null, codec: data.format ?? null,
    quality, playable: Boolean(streamUrl), available: Boolean(streamUrl), previewOnly: false,
    encrypted: Boolean(data.encrypted),
    note: streamUrl ? null : "Qobuz returned no direct stream URL."
  };
}
