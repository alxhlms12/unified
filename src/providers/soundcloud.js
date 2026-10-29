import { ApiError, fetchJson, fetchText, makeUrl, providerStatus, normalizeTrack } from "../lib.js";

const HOME = "https://soundcloud.com/";
const API = "https://api-v2.soundcloud.com/";
let cachedClientId = null;
let cachedAt = 0;

async function clientId(env) {
  if (env["sc-cid"] && String(env["sc-cid"]).trim()) return env["sc-cid"].trim();
  if (cachedClientId && cachedAt > Date.now() - 6 * 60 * 60 * 1000) return cachedClientId;
  if (String(env.SOUNDCLOUD_DISCOVERY ?? "true").toLowerCase() !== "true") {
    throw new ApiError(503, "provider_not_configured", "Set sc-cid or enable SoundCloud client ID discovery.", { missing: ["sc-cid"] });
  }
  const { text: html } = await fetchText(HOME, { headers: { "user-agent": "Mozilla/5.0", accept: "text/html" } });
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)].map(match => match[1]);
  const urls = scripts.map(src => new URL(src, HOME).href).filter((value, index, values) => values.indexOf(value) === index).slice(-35).reverse();
  for (const scriptUrl of urls) {
    try {
      const { text } = await fetchText(scriptUrl, { headers: { "user-agent": "Mozilla/5.0" } }, 8000);
      const match = /client_id\s*[:=]\s*["']([A-Za-z0-9_-]{25,})["']/.exec(text)
        ?? /clientId\s*[:=]\s*["']([A-Za-z0-9_-]{25,})["']/.exec(text);
      if (match) {
        cachedClientId = match[1];
        cachedAt = Date.now();
        return cachedClientId;
      }
    } catch { /* continue through frontend bundles */ }
  }
  throw new ApiError(503, "client_id_discovery_failed", "Could not discover SoundCloud's client ID. Configure sc-cid.");
}

async function request(env, path, params = {}) {
  const cid = await clientId(env);
  const url = makeUrl(API, path, { client_id: cid, ...params });
  return fetchJson(url, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" } });
}

export function status(env) {
  const auto = String(env.SOUNDCLOUD_DISCOVERY ?? "true").toLowerCase() === "true";
  return providerStatus(env, "soundcloud", [], {
    search: true, trackInfo: true, artistInfo: true, playlistInfo: true,
    streamResolution: true, clientIdDiscovery: !env["sc-cid"]
  }, { configured: Boolean(env["sc-cid"]), available: Boolean(env["sc-cid"] || auto), availableWithoutRequired: Boolean(env["sc-cid"] || auto), capabilities: { clientIdOverride: Boolean(env["sc-cid"]) } });
}

export async function search(env, query, type = "track", limit = 25, offset = 0) {
  const path = ({ track: "search/tracks", artist: "search/users", playlist: "search/playlists" })[type];
  if (!path) throw new ApiError(400, "unsupported_search_type", "SoundCloud supports track, artist, and playlist search.");
  const result = await request(env, path, { q: query, limit: Math.min(limit, 200), offset, linked_partitioning: "true", access: "playable,preview" });
  const collection = result.collection ?? [];
  return { provider: "soundcloud", type, total: result.total_results ?? null,
    items: type === "track" ? collection.map(item => normalizeTrack("soundcloud", {
      id: item.id ?? item.urn, title: item.title, durationMs: item.duration,
      artists: [{ id: item.user?.id, name: item.user?.username }],
      album: item.publisher_metadata?.artist ? { title: item.publisher_metadata.artist } : null,
      artworkUrl: item.artwork_url, url: item.permalink_url, isrc: item.publisher_metadata?.isrc
    })).filter(Boolean) : collection };
}

export async function info(env, id) { return request(env, `tracks/${encodeURIComponent(id)}`); }
export async function album(env, id) { return request(env, `playlists/${encodeURIComponent(id)}`); }
export async function artist(env, id) { return request(env, `users/${encodeURIComponent(id)}`); }
export async function playlist(env, id) { return request(env, `playlists/${encodeURIComponent(id)}`); }
export async function lyrics() { throw new ApiError(501, "lyrics_unavailable", "SoundCloud does not expose a consistent track-lyrics endpoint."); }
export async function stream(env, id) {
  const track = await info(env, id);
  const transcodings = track?.media?.transcodings ?? [];
  if (!transcodings.length) throw new ApiError(404, "stream_unavailable", "SoundCloud did not expose a playable transcoding for this track.");
  const selected = transcodings.find(item => item?.format?.protocol === "hls") ?? transcodings[0];
  const cid = await clientId(env);
  const url = makeUrl(selected.url, "", { client_id: cid });
  const result = await fetchJson(url, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" } });
  if (!result.url) throw new ApiError(502, "stream_resolution_failed", "SoundCloud did not return a transcoding URL.");
  return { provider: "soundcloud", trackId: String(id), url: result.url,
    protocol: selected.format?.protocol ?? null, mimeType: selected.format?.mime_type ?? null,
    expiresAt: result.expires_at ?? null };
}
