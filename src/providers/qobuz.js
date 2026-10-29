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
      "user-agent": "UnifiedMusicAPI/0.2.0",
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

export async function stream(env, id, quality = "27") {
  assertConfigured(env);
  // Current Qobuz web playback shifted away from track/getFileUrl to session-based
  // encrypted CMAF. The legacy endpoint has been reported as HTTP 410. We surface
  // this explicitly instead of returning a broken URL or trying to decrypt protected media.
  const formatId = ({ low: "5", high: "6", lossless: "6", hires: "27", "hi-res": "27" })[String(quality).toLowerCase()] ?? String(quality);
  const url = makeUrl(API, "track/getFileUrl", {
    app_id: env["q-cid"], user_auth_token: env["q-uat"], track_id: id, format_id: formatId, intent: "stream"
  });
  const result = await fetch(url, { headers: { "x-app-id": env["q-cid"], "x-user-auth-token": env["q-uat"], accept: "application/json" } });
  if (result.status === 410) throw new ApiError(503, "qobuz_legacy_stream_endpoint_gone", "Qobuz's legacy file URL endpoint is gone. Current session-based encrypted playback is not implemented in this build.", { upstreamStatus: 410 });
  if (!result.ok) throw new ApiError(502, "qobuz_stream_failed", `Qobuz stream resolution returned HTTP ${result.status}.`, { upstreamStatus: result.status });
  return result.json();
}
