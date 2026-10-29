import { ApiError, fetchJson, fetchText, makeUrl, providerStatus, normalizeTrack } from "../lib.js";

const HOME = "https://soundcloud.com/";
const API = "https://api-v2.soundcloud.com/";
let cachedClientId = null;
let cachedAt = 0;
let discoveryFlight = null;

async function clientId(env) {
  if (env["sc-cid"] && String(env["sc-cid"]).trim()) return env["sc-cid"].trim();
  if (cachedClientId && cachedAt > Date.now() - 6 * 60 * 60 * 1000) return cachedClientId;
  if (discoveryFlight) return discoveryFlight;
  if (String(env.SOUNDCLOUD_DISCOVERY ?? "true").toLowerCase() !== "true") {
    throw new ApiError(503, "provider_not_configured", "Set sc-cid or enable SoundCloud client ID discovery.", { missing: ["sc-cid"] });
  }
  discoveryFlight = (async () => {
    const { text: html } = await fetchText(HOME, { headers: { "user-agent": "Mozilla/5.0", accept: "text/html" } }, 6000);
    const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)].map(match => match[1]);
    const urls = scripts.map(src => new URL(src, HOME).href).filter((value, index, values) => values.indexOf(value) === index).slice(-8).reverse();
    // The prior implementation fetched up to 35 scripts serially (often tens of
    // seconds on a cold isolate). Fetch a small batch concurrently with short
    // timeouts: ID discovery is best-effort and should not stall every request.
    // Resolve on the first matching bundle instead of waiting for every JS
    // bundle to download. Non-matching responses reject their branch; Promise.any
    // returns the first discovered ID while the remaining requests are irrelevant.
    const attempts = urls.map(async scriptUrl => {
      const { text } = await fetchText(scriptUrl, { headers: { "user-agent": "Mozilla/5.0" } }, 3500);
      const match = /client_id\s*[:=]\s*["']([A-Za-z0-9_-]{25,})["']/.exec(text)
        ?? /clientId\s*[:=]\s*["']([A-Za-z0-9_-]{25,})["']/.exec(text);
      if (!match?.[1]) throw new Error("No SoundCloud client ID in bundle");
      return match[1];
    });
    try {
      cachedClientId = await Promise.any(attempts);
      cachedAt = Date.now();
      return cachedClientId;
    } catch {
      throw new ApiError(503, "client_id_discovery_failed", "Could not discover SoundCloud's client ID. Configure sc-cid.");
    }
  })();
  try { return await discoveryFlight; }
  finally { discoveryFlight = null; }
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

// SoundCloud does not expose a dedicated ISRC filter on its track-search
// endpoint. Try its text index with the ISRC, then verify any candidates against
// full track metadata. A zero-result response is not proof the ISRC is absent
// from the entire SoundCloud catalog; this limitation is returned to callers.
export async function findByIsrc(env, isrc, limit = 50) {
  const response = await request(env, "search/tracks", {
    q: isrc, limit: Math.min(limit, 50), offset: 0,
    linked_partitioning: "true", access: "playable,preview"
  });
  const candidates = response.collection ?? [];
  const checked = await Promise.all(candidates.slice(0, 8).map(async item => {
    let full = item;
    if (!item.publisher_metadata?.isrc && !item.publisher_metadata?.ISRC && item.id != null) {
      try { full = await info(env, item.id); } catch { /* keep search metadata for the exact comparison */ }
    }
    return normalizeTrack("soundcloud", {
      ...item, ...full,
      id: full.id ?? full.urn ?? item.id ?? item.urn,
      title: full.title ?? item.title,
      artists: [{ id: (full.user ?? item.user)?.id, name: (full.user ?? item.user)?.username }],
      durationMs: full.duration ?? item.duration,
      artworkUrl: full.artwork_url ?? item.artwork_url,
      url: full.permalink_url ?? item.permalink_url,
      isrc: full.isrc ?? full.publisher_metadata?.isrc ?? full.publisher_metadata?.ISRC ?? item.publisher_metadata?.isrc ?? null
    });
  }));
  return {
    items: checked.filter(Boolean),
    candidateCount: candidates.length,
    strategy: "text_search_then_metadata_verification",
    limitation: "SoundCloud does not provide a dedicated ISRC search filter; only candidates surfaced by text search can be verified."
  };
}

export async function info(env, id) { return request(env, `tracks/${encodeURIComponent(id)}`); }
export async function album(env, id) { return request(env, `playlists/${encodeURIComponent(id)}`); }
export async function artist(env, id) { return request(env, `users/${encodeURIComponent(id)}`); }
export async function playlist(env, id) { return request(env, `playlists/${encodeURIComponent(id)}`); }
export async function lyrics() { throw new ApiError(501, "lyrics_unavailable", "SoundCloud does not expose a consistent track-lyrics endpoint."); }
export async function stream(env, id, options = {}) {
  const track = await info(env, id);
  const transcodings = track?.media?.transcodings ?? [];
  if (!transcodings.length) throw new ApiError(404, "stream_unavailable", "SoundCloud did not expose a playable transcoding for this track.");
  const isEncrypted = item => /(?:cbc|ctr)-encrypted-hls/i.test(item?.format?.protocol ?? "");
  const clear = transcodings.filter(item => !isEncrypted(item));
  // Prefer the modern clear AAC HLS stream, then other unencrypted HLS or
  // progressive formats. Some tracks expose only CBC/CTR-encrypted HLS; those
  // are marked as protected instead of attempting to bypass their protection.
  const selected = clear.find(item => /hls/i.test(item?.format?.protocol ?? "") && /aac/i.test(item?.preset ?? ""))
    ?? clear.find(item => item?.format?.protocol === "hls")
    ?? clear.find(item => item?.format?.protocol === "progressive")
    ?? clear[0]
    ?? transcodings.find(isEncrypted);
  if (!selected?.url) throw new ApiError(404, "stream_unavailable", "SoundCloud did not expose a usable transcoding URL.");
  const cid = await clientId(env);
  const transcodingUrl = makeUrl(selected.url, "", { client_id: cid });
  const result = await fetchJson(transcodingUrl, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" } }, 8000);
  if (!result.url) throw new ApiError(502, "stream_resolution_failed", "SoundCloud did not return a transcoding URL.");
  const encrypted = isEncrypted(selected);
  const protocol = selected.format?.protocol ?? null;
  return {
    provider: "soundcloud", trackId: String(id), url: result.url,
    streamType: /hls/i.test(protocol ?? "") ? "manifest" : "direct",
    manifestType: /hls/i.test(protocol ?? "") ? "HLS" : null,
    mimeType: selected.format?.mime_type ?? null,
    codec: /aac/i.test(selected.preset ?? "") ? "AAC" : null,
    quality: selected.quality ?? selected.preset ?? null,
    bitrate: /160/.test(selected.preset ?? "") ? 160000 : /96/.test(selected.preset ?? "") ? 96000 : null,
    protocol,
    encrypted,
    protection: encrypted ? (protocol.includes("cbc") ? "CBC-HLS" : "CTR-HLS") : null,
    playable: !encrypted,
    previewOnly: Boolean(selected.snipped),
    expiresAt: result.expires_at ?? null,
    note: encrypted
      ? "Only provider-encrypted HLS transcodings were available. Unified does not decrypt or bypass CBC/CTR protection; try again later or use a clear transcoding if SoundCloud exposes one."
      : null
  };
}
